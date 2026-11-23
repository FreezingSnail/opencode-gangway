import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  attentionKeys,
  buildAttentionPayload,
  buildDeliveryPayload,
  codexThreadIdFromMeta,
  createAppServerTransport,
  deliverFirstRecordedOperation,
  deliverRecordedAttention,
  deliverRecordedOperation,
  DELIVERY_TOOL_NAME,
  MAX_DELIVERY_TEXT,
  recoverStaleSending,
  retryRecordedDelivery,
  STALE_SENDING_MS,
  type DeliveryTransport,
} from "../src/codex-delivery"
import { permissionAttentionKey } from "../src/codex-attention"
import { startMcpServer } from "../src/mcp"
import { loadOperation, saveOperation, type Ctx, type OperationRecord } from "../src/tools"

// Offline delivery tests (gangway-34r.2). A scripted WebSocket stands in for the
// shared Codex App Server control socket and an in-memory store stands in for
// plugin storage, so routing, deduplication and failure phases are deterministic.

class MemoryStorage {
  readonly map = new Map<string, unknown>()
  failSet: { key: string; count: number } | null = null
  private readonly setCounts = new Map<string, number>()
  async set(key: string, value: unknown): Promise<void> {
    const count = (this.setCounts.get(key) ?? 0) + 1
    this.setCounts.set(key, count)
    if (this.failSet?.key === key && this.failSet.count === count) {
      throw new Error("injected operation persistence failure")
    }
    this.map.set(key, JSON.parse(JSON.stringify(value)))
  }
  async get(key: string): Promise<unknown> {
    if (!this.map.has(key)) return null
    return JSON.parse(JSON.stringify(this.map.get(key)))
  }
  async scan(input: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>
    next?: string
  }> {
    const keys = [...this.map.keys()].filter((key) => key.startsWith(input.prefix)).sort()
    const start = input.after ? keys.indexOf(input.after) + 1 : 0
    const page = keys.slice(start, start + (input.limit ?? 100))
    return {
      entries: page.map((key) => ({ key, value: JSON.parse(JSON.stringify(this.map.get(key))) })),
      next: undefined,
    }
  }
}

function context(storage: MemoryStorage = new MemoryStorage()): Ctx {
  return { storage } as unknown as Ctx
}

type Sent = { id?: number; method: string; params?: Record<string, any> }

class FakeSocket extends EventTarget {
  readonly sent: Sent[] = []
  behavior: (message: Sent, socket: FakeSocket) => void
  readonly openOnMicrotask: boolean

  constructor(behavior: (message: Sent, socket: FakeSocket) => void, openOnMicrotask = true) {
    super()
    this.behavior = behavior
    this.openOnMicrotask = openOnMicrotask
    if (openOnMicrotask) queueMicrotask(() => this.dispatchEvent(new Event("open")))
  }

  send(data: string): void {
    const message = JSON.parse(data) as Sent
    this.sent.push(message)
    if (message.id === undefined) return
    this.behavior(message, this)
  }

  respond(message: Sent, result: unknown): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ id: message.id, result }),
    })))
  }

  respondError(message: Sent, error: { code?: number; message?: string }): void {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ id: message.id, error }),
    })))
  }

  disconnect(): void {
    this.dispatchEvent(new Event("close"))
  }

  close(): void {
    this.dispatchEvent(new Event("close"))
  }
}

interface ThreadScript {
  worker: string
  parent?: string
  workerDirect?: boolean
  workerStatus?: "idle" | "active" | "notLoaded"
  parentStatus?: "idle" | "active" | "notLoaded"
  onTurnStart?: (message: Sent, socket: FakeSocket) => void
}

function scriptedSocket(script: ThreadScript): FakeSocket {
  return new FakeSocket((message, socket) => {
    if (message.method === "initialize") {
      socket.respond(message, {})
      return
    }
    if (message.method === "thread/read") {
      const threadId = message.params?.threadId as string
      const worker = threadId === script.worker
      const status = worker
        ? (script.workerStatus ?? "idle")
        : (script.parentStatus ?? "idle")
      socket.respond(message, {
        thread: {
          id: threadId,
          status: { type: status },
          canAcceptDirectInput: worker ? script.workerDirect ?? false : true,
          parentThreadId: worker ? script.parent ?? null : null,
        },
      })
      return
    }
    if (message.method === "turn/start") {
      if (script.onTurnStart) return script.onTurnStart(message, socket)
      socket.respond(message, { turn: { id: "turn_1", status: "inProgress", items: [] } })
    }
  })
}

function operation(requestID: string, overrides: Partial<OperationRecord> = {}): OperationRecord {
  const now = 1_700_000_000_000
  return {
    requestID,
    kind: "start",
    identity: {
      kind: "start",
      directory: "/repo",
      model: "opencode-go/deepseek-v4.1-flash",
      agent: null,
      sessionID: null,
      prompt: "task",
    },
    identityHash: "hash",
    state: "completed",
    sessionID: "ses_1",
    boundary: 0,
    submittedAt: now - 1_000,
    submittedMessageID: "msg_in",
    delivery: "recorded",
    createdAt: now - 2_000,
    updatedAt: now,
    completion: {
      text: "done",
      model: null,
      cost: null,
      tokens: null,
      finish: "stop",
      error: null,
      outcome: "succeeded",
      messageID: "msg_out",
      outputId: "msg_out@1@completed",
      completedAt: now,
    },
    lastOutputId: null,
    error: null,
    terminalEventId: "evt_1",
    terminalSource: "event",
    codexThreadId: null,
    notify: true,
    codexDelivery: null,
    ...overrides,
  }
}

function turnStarts(sockets: FakeSocket[]): Sent[] {
  return sockets.flatMap((socket) => socket.sent).filter((message) => message.method === "turn/start")
}

function attentionOperation(requestID: string, overrides: Partial<OperationRecord> = {}): OperationRecord {
  return operation(requestID, {
    state: "submitted",
    completion: null,
    terminalEventId: null,
    terminalSource: null,
    attention: {
      kind: "permission",
      requests: [{
        id: "per_1",
        action: "shell",
        resources: ["npm install"],
        message: "approve shell",
      }],
      forms: [],
    },
    ...overrides,
  })
}

describe("Codex caller metadata", () => {
  test("reads and normalizes the MCP _meta.threadId supplied by Codex", () => {
    const threadId = crypto.randomUUID()
    expect(codexThreadIdFromMeta({ threadId })).toBe(threadId)
    expect(codexThreadIdFromMeta({ threadId: threadId.toUpperCase() })).toBe(threadId)
    expect(codexThreadIdFromMeta({ threadId: "not-a-thread" })).toBeNull()
    expect(codexThreadIdFromMeta(null)).toBeNull()
    expect(codexThreadIdFromMeta({ source: "client" })).toBeNull()
  })

  test("the MCP transport binds the caller thread to the recorded operation", async () => {
    const storage = new MemoryStorage()
    const ctx = {
      location: { directory: "/repo" },
      storage,
      session: {
        create: async () => ({ id: "ses_meta" }),
        prompt: async () => ({ id: "ack_meta" }),
        get: async () => ({}),
        context: async () => [],
        wait: async () => ({}),
        interrupt: async () => ({}),
      },
    } as unknown as Ctx
    const threadId = crypto.randomUUID()
    const server = startMcpServer({ port: 0, ctx })
    const client = new Client({ name: "gangway-meta-test", version: "0.0.1" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
      await client.callTool({
        name: "opencode_start_session",
        arguments: { prompt: "task", requestID: "req-meta", wait: false },
        _meta: { threadId },
      })
      expect((await loadOperation(ctx, "req-meta"))?.codexThreadId).toBe(threadId)
    } finally {
      await client.close()
      server.stop()
    }
  })
})

describe("dispatch opt-in", () => {
  test("does not push an operation dispatched without notify", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-not-opted", { codexThreadId: worker, notify: false }))

    const result = await deliverRecordedOperation(ctx, "req-not-opted", { transport })

    expect(result).toMatchObject({ status: "skipped", reason: "not-opted-in" })
    expect(turnStarts(sockets)).toHaveLength(0)
    expect((await loadOperation(ctx, "req-not-opted"))?.codexDelivery).toBeNull()
  })
})

describe("destination and parent routing", () => {
  test("routes a native V2 worker through its idle parent", async () => {
    const worker = crypto.randomUUID()
    const parent = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, parent, workerDirect: false, parentStatus: "idle" })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-parent-idle", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-parent-idle", { transport })

    expect(result).toMatchObject({ status: "accepted", recipientThreadId: parent })
    const reads = sockets.flatMap((socket) => socket.sent)
      .filter((message) => message.method === "thread/read")
      .map((message) => message.params?.threadId)
    expect(reads).toEqual([worker, parent])
    expect(turnStarts(sockets)).toHaveLength(1)
    expect(turnStarts(sockets)[0].params?.threadId).toBe(parent)
  })

  test("routes through an active loaded parent and still accepts one result", async () => {
    const worker = crypto.randomUUID()
    const parent = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, parent, workerDirect: false, parentStatus: "active" })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-parent-active", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-parent-active", { transport })

    expect(result).toMatchObject({ status: "accepted", recipientThreadId: parent })
    expect(turnStarts(sockets)[0].params?.threadId).toBe(parent)
  })

  test("delivers directly to a worker that accepts direct input", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-direct", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-direct", { transport })

    expect(result).toMatchObject({ status: "accepted", recipientThreadId: worker })
    const reads = sockets.flatMap((socket) => socket.sent).filter((message) => message.method === "thread/read")
    expect(reads).toHaveLength(1)
    expect(turnStarts(sockets)[0].params?.threadId).toBe(worker)
  })

  test("a missing parent is a preflight failure and never attempts turn/start", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: false })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-no-parent", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-no-parent", { transport })

    expect(result).toMatchObject({ status: "preflight-failed", phase: "preflight" })
    expect(turnStarts(sockets)).toHaveLength(0)
  })
})

describe("duplicate and reentrant delivery", () => {
  test("concurrent callbacks send one accepted notification", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const storage = new MemoryStorage()
    const ctx = context(storage)
    await saveOperation(ctx, operation("req-duplicate", { codexThreadId: worker }))

    const results = await Promise.all([
      deliverRecordedOperation(ctx, "req-duplicate", { transport }),
      deliverRecordedOperation(ctx, "req-duplicate", { transport }),
    ])
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1)
    expect(results.filter((result) => result.status === "skipped")).toHaveLength(1)
    expect(turnStarts(sockets)).toHaveLength(1)

    // A reload sees the same durable state through a fresh plugin context.
    const repeated = await deliverRecordedOperation(context(storage), "req-duplicate", { transport })
    expect(repeated).toMatchObject({ status: "skipped", reason: "already-accepted" })
    expect(turnStarts(sockets)).toHaveLength(1)

    const record = await loadOperation(ctx, "req-duplicate")
    const state = record?.codexDelivery?.events["msg_out@1@completed"]
    expect(state).toMatchObject({ status: "accepted", recipientThreadId: worker })
  })

  test("different operations serialize turn starts for the same resolved recipient", async () => {
    const firstWorker = crypto.randomUUID()
    const secondWorker = crypto.randomUUID()
    const sharedRecipient = crypto.randomUUID()
    let active = 0
    let maximumActive = 0
    const transport: DeliveryTransport = {
      async preflight(threadId) {
        return { recipientThreadId: sharedRecipient, sourceThreadId: threadId }
      },
      async send() {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        return { recipientThreadId: sharedRecipient, turnId: "turn_serial" }
      },
    }
    const ctx = context()
    await saveOperation(ctx, operation("req-recipient-serial-a", { codexThreadId: firstWorker }))
    await saveOperation(ctx, operation("req-recipient-serial-b", { codexThreadId: secondWorker }))

    const results = await Promise.all([
      deliverRecordedOperation(ctx, "req-recipient-serial-a", { transport }),
      deliverRecordedOperation(ctx, "req-recipient-serial-b", { transport }),
    ])
    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"])
    expect(maximumActive).toBe(1)
  })
})

describe("bounded payload", () => {
  test("caps result text and marks the payload truncated", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    const long = operation("req-bound", {
      codexThreadId: worker,
      completion: {
        ...operation("req-bound").completion!,
        text: "x".repeat(MAX_DELIVERY_TEXT + 5_000),
      },
    })
    expect(buildDeliveryPayload(long).truncated).toBe(true)
    await saveOperation(ctx, long)

    expect(await deliverRecordedOperation(ctx, "req-bound", { transport })).toMatchObject({ status: "accepted" })
    const output = turnStarts(sockets)[0].params?.toolOutput?.output as string
    const payload = JSON.parse(output)
    expect(turnStarts(sockets)[0].params?.toolOutput?.name).toBe(DELIVERY_TOOL_NAME)
    expect(payload.text.length).toBe(MAX_DELIVERY_TEXT)
    expect(payload.truncated).toBe(true)
  })
})

describe("source identity and attention push", () => {
  test("result payload names the source worker and recorded session", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-source", { codexThreadId: worker }))

    await deliverRecordedOperation(ctx, "req-source", { transport })

    const payload = JSON.parse(turnStarts(sockets)[0].params?.toolOutput?.output as string)
    expect(payload.source).toEqual({
      requestID: "req-source",
      kind: "start",
      sessionID: "ses_1",
      workerThreadId: worker,
      directory: "/repo",
      agent: null,
      model: "opencode-go/deepseek-v4.1-flash",
    })
  })

  test("a new needsInput item is pushed once with a stable dedupe key", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    const op = attentionOperation("req-attention-push", { codexThreadId: worker })
    await saveOperation(ctx, op)
    const key = permissionAttentionKey(op.attention!.requests[0])
    expect(attentionKeys(op)).toEqual([key])
    expect(buildAttentionPayload(op, op.attention!, key).needsInput?.kind).toBe("permission")

    const first = await deliverRecordedAttention(ctx, "req-attention-push", key, { transport })
    expect(first).toMatchObject({ status: "accepted", key })
    expect(turnStarts(sockets)).toHaveLength(1)
    const payload = JSON.parse(turnStarts(sockets)[0].params?.toolOutput?.output as string)
    expect(payload.kind).toBe("gangway.operation.attention")
    expect(payload.outputId).toBe(key)
    expect(payload.needsInput.requests[0].id).toBe("per_1")
    expect(payload.source.workerThreadId).toBe(worker)
    expect(payload.source.sessionID).toBe("ses_1")

    const duplicate = await deliverRecordedAttention(ctx, "req-attention-push", key, { transport })
    expect(duplicate).toMatchObject({ status: "skipped", reason: "already-accepted" })
    expect(turnStarts(sockets)).toHaveLength(1)
  })
})

describe("socket failure phases and inspectability", () => {
  test("an App Server initialize failure is safe preflight and never attempts turn/start", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = new FakeSocket((message, active) => {
          if (message.method === "initialize") {
            active.respondError(message, { code: -32000, message: "initialize refused" })
          }
        })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-init-failed", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-init-failed", { transport })

    expect(result).toMatchObject({ status: "preflight-failed", phase: "preflight" })
    expect(result.error).toContain("initialize")
    expect(turnStarts(sockets)).toHaveLength(0)
    const reads = sockets.flatMap((socket) => socket.sent).filter((message) => message.method === "thread/read")
    expect(reads).toHaveLength(0)
    const record = await loadOperation(ctx, "req-init-failed")
    expect(record?.codexDelivery?.events["msg_out@1@completed"]?.status).toBe("preflight-failed")
  })

  test("a thread lookup rejection is safe preflight", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = new FakeSocket((message, active) => {
          if (message.method === "initialize") return active.respond(message, {})
          if (message.method === "thread/read") {
            return active.respondError(message, { code: -32001, message: "thread read failed" })
          }
        })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-read-failed", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-read-failed", { transport })

    expect(result).toMatchObject({ status: "preflight-failed", phase: "preflight" })
    expect(result.error).toContain("thread lookup failed")
    expect(turnStarts(sockets)).toHaveLength(0)
  })

  test("a post-send RPC rejection is rejected, not an ambiguous blind retry", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = new FakeSocket((message, active) => {
          if (message.method === "initialize") return active.respond(message, {})
          if (message.method === "thread/read") {
            return active.respond(message, {
              thread: { id: worker, status: { type: "idle" }, canAcceptDirectInput: true },
            })
          }
          if (message.method === "turn/start") {
            return active.respondError(message, { code: -32002, message: "turn rejected" })
          }
        })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-rejected", { codexThreadId: worker }))

    const first = await deliverRecordedOperation(ctx, "req-rejected", { transport })
    expect(first).toMatchObject({ status: "rejected", phase: "rejected" })
    expect(turnStarts(sockets)).toHaveLength(1)

    const second = await deliverRecordedOperation(ctx, "req-rejected", { transport })
    expect(second).toMatchObject({ status: "skipped", reason: "already-rejected" })
    expect(turnStarts(sockets)).toHaveLength(1)
  })

  test("a disconnect before turn/start is a safe preflight failure", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({
          worker,
          workerDirect: true,
          onTurnStart: () => {
            throw new Error("turn/start must not be reached")
          },
        })
        // Drop the socket while the lookup is outstanding, before any effectful
        // turn/start request can be sent.
        socket.behavior = (message, active) => {
          if (message.method === "initialize") return active.respond(message, {})
          if (message.method === "thread/read") return active.disconnect()
        }
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-before-send", { codexThreadId: worker }))

    const result = await deliverRecordedOperation(ctx, "req-before-send", { transport })

    expect(result).toMatchObject({ status: "preflight-failed", phase: "preflight" })
    expect(turnStarts(sockets)).toHaveLength(0)
    const record = await loadOperation(ctx, "req-before-send")
    expect(record?.state).toBe("completed")
    expect(record?.completion?.text).toBe("done")
    expect(record?.codexDelivery?.events["msg_out@1@completed"]?.status).toBe("preflight-failed")
  })

  test("a disconnect after send is ambiguous and never resends", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({
          worker,
          workerDirect: true,
          onTurnStart: (_message, active) => active.disconnect(),
        })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-after-send", { codexThreadId: worker }))

    const first = await deliverRecordedOperation(ctx, "req-after-send", { transport })
    expect(first).toMatchObject({ status: "ambiguous", phase: "ambiguous" })
    expect(turnStarts(sockets)).toHaveLength(1)

    const repeated = await deliverRecordedOperation(ctx, "req-after-send", { transport })
    expect(repeated).toMatchObject({ status: "skipped", reason: "already-ambiguous" })
    expect(turnStarts(sockets)).toHaveLength(1)
    const record = await loadOperation(ctx, "req-after-send")
    expect(record?.completion?.text).toBe("done")
  })

  test("an unanswered turn/start times out as ambiguous without a blind duplicate wake", async () => {
    const worker = crypto.randomUUID()
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 20,
      connect: () => {
        const socket = scriptedSocket({
          worker,
          workerDirect: true,
          onTurnStart: () => {
            // Stay open but never answer, modelling an accepted write whose
            // response was lost before the client learned the turn id.
          },
        })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })
    const ctx = context()
    await saveOperation(ctx, operation("req-timeout", { codexThreadId: worker }))

    const first = await deliverRecordedOperation(ctx, "req-timeout", { transport })
    expect(first).toMatchObject({ status: "ambiguous", phase: "ambiguous" })
    expect(turnStarts(sockets)).toHaveLength(1)

    const second = await deliverRecordedOperation(ctx, "req-timeout", { transport })
    expect(second).toMatchObject({ status: "skipped", reason: "already-ambiguous" })
    expect(turnStarts(sockets)).toHaveLength(1)
  })

  test("a delivery transport error is recorded without touching the run result", async () => {
    const ctx = context()
    await saveOperation(ctx, operation("req-inspectable", { codexThreadId: crypto.randomUUID() }))
    const transport: DeliveryTransport = {
      async send() {
        throw new Error("transport exploded")
      },
    }

    const result = await deliverRecordedOperation(ctx, "req-inspectable", { transport })
    expect(result).toMatchObject({ status: "preflight-failed", phase: "preflight" })
    const record = await loadOperation(ctx, "req-inspectable")
    expect(record?.state).toBe("completed")
    expect(record?.completion?.text).toBe("done")
    expect(record?.error).toBeNull()
  })
})

describe("operator recovery", () => {
  test("first-delivery recovery refuses any existing attempt, including preflight failure", async () => {
    const worker = crypto.randomUUID()
    const ctx = context()
    const key = "msg_out@1@completed"
    await saveOperation(ctx, operation("req-first-delivery-existing", {
      codexThreadId: worker,
      codexDelivery: {
        events: {
          [key]: {
            key,
            status: "preflight-failed",
            threadId: worker,
            recipientThreadId: null,
            attemptedAt: 1,
            acceptedAt: null,
            turnId: null,
            error: "unloaded",
          },
        },
      },
    }))
    let sends = 0
    const transport: DeliveryTransport = {
      async send() {
        sends += 1
        return { recipientThreadId: worker, turnId: "unexpected" }
      },
    }

    const result = await deliverFirstRecordedOperation(ctx, "req-first-delivery-existing", key, { transport })
    expect(result).toMatchObject({ status: "skipped", reason: "already-preflight-failed" })
    expect(sends).toBe(0)
  })

  test("a known preflight failure is retried only on explicit request, then never again", async () => {
    const worker = crypto.randomUUID()
    const ctx = context()
    await saveOperation(ctx, operation("req-retry", {
      codexThreadId: worker,
      codexDelivery: {
        events: {
          "msg_out@1@completed": {
            key: "msg_out@1@completed",
            status: "preflight-failed",
            threadId: worker,
            recipientThreadId: worker,
            attemptedAt: 1,
            acceptedAt: null,
            turnId: null,
            error: "Codex thread is not loaded",
          },
        },
      },
    }))
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })

    const first = await retryRecordedDelivery(ctx, "req-retry", "msg_out@1@completed", { transport })
    expect(first).toMatchObject({ status: "accepted" })
    expect(turnStarts(sockets)).toHaveLength(1)

    const repeated = await retryRecordedDelivery(ctx, "req-retry", "msg_out@1@completed", { transport })
    expect(repeated).toMatchObject({ status: "skipped", reason: "already-accepted" })
    expect(turnStarts(sockets)).toHaveLength(1)
  })

  test("a stale sending reservation is recovered as ambiguous without a resend", async () => {
    const worker = crypto.randomUUID()
    const ctx = context()
    const now = 1_800_000_000_000
    await saveOperation(ctx, operation("req-stale", {
      codexThreadId: worker,
      codexDelivery: {
        events: {
          "msg_out@1@completed": {
            key: "msg_out@1@completed",
            status: "sending",
            threadId: worker,
            recipientThreadId: null,
            attemptedAt: now - STALE_SENDING_MS - 1,
            acceptedAt: null,
            turnId: null,
            error: null,
          },
        },
      },
    }))
    const sockets: FakeSocket[] = []
    const transport = createAppServerTransport({
      timeoutMs: 100,
      connect: () => {
        const socket = scriptedSocket({ worker, workerDirect: true })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
    })

    const automatic = await deliverRecordedOperation(ctx, "req-stale", {
      transport,
      now: () => now,
    })
    expect(automatic).toMatchObject({ status: "skipped", reason: "stale-sending-recovered" })
    expect(turnStarts(sockets)).toHaveLength(0)
    const recovered = await loadOperation(ctx, "req-stale")
    const event = recovered?.codexDelivery?.events["msg_out@1@completed"]
    expect(event?.status).toBe("ambiguous")
    expect(event?.error).toContain("no turn/start was resent")

    // Ambiguous is terminal for retries: only preflight failures are resent.
    const retry = await retryRecordedDelivery(ctx, "req-stale", "msg_out@1@completed", { transport })
    expect(retry).toMatchObject({ status: "skipped", reason: "already-ambiguous" })
    expect(turnStarts(sockets)).toHaveLength(0)
  })

  test("accepted send followed by persistence failure remains sending and is never preflight-retried", async () => {
    const worker = crypto.randomUUID()
    const storage = new MemoryStorage()
    const ctx = context(storage)
    const op = operation("req-accepted-persist-fails", { codexThreadId: worker })
    await saveOperation(ctx, op)
    // Locate the actual hashed storage key via the store rather than deriving it.
    const operationKey = [...storage.map.keys()][0]!
    storage.failSet = { key: operationKey, count: 3 } // intent, reservation, accepted finalization
    let sends = 0
    const transport: DeliveryTransport = {
      async send() {
        sends += 1
        return { recipientThreadId: worker, turnId: "turn_accepted" }
      },
    }

    const result = await deliverRecordedOperation(ctx, op.requestID, { transport })
    expect(result).toMatchObject({ status: "ambiguous", phase: "ambiguous" })
    expect(result.error).toContain("accepted the turn")
    expect(sends).toBe(1)
    const stored = await loadOperation(ctx, op.requestID)
    expect(Object.values(stored?.codexDelivery?.events ?? {})[0]?.status).toBe("sending")

    const retry = await retryRecordedDelivery(ctx, op.requestID, stored!.completion!.outputId!, { transport })
    expect(retry).toMatchObject({ status: "skipped", reason: "already-sending" })
    expect(sends).toBe(1)
  })

  test("explicit stale recovery abandons a crash reservation without sending", async () => {
    const worker = crypto.randomUUID()
    const ctx = context()
    const now = 1_800_000_000_000
    await saveOperation(ctx, operation("req-recover", {
      codexThreadId: worker,
      codexDelivery: {
        events: {
          "msg_out@1@completed": {
            key: "msg_out@1@completed",
            status: "sending",
            threadId: worker,
            recipientThreadId: null,
            attemptedAt: now - STALE_SENDING_MS - 1,
            acceptedAt: null,
            turnId: null,
            error: null,
          },
        },
      },
    }))

    const recovered = await recoverStaleSending(ctx, "req-recover", { now: () => now })
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      status: "ambiguous",
      key: "msg_out@1@completed",
      reason: "stale-sending-recovered",
    })
    const record = await loadOperation(ctx, "req-recover")
    expect(record?.codexDelivery?.events["msg_out@1@completed"]?.status).toBe("ambiguous")
  })
})
