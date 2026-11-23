import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startMcpServer, type McpServerHandle } from "../src/mcp"
import {
  reconcileDeliveryState,
  recordExecutionEvent,
  startExecutionMonitor,
  type EventStream,
  type ExecutionMonitor,
} from "../src/execution-events"
import { loadOperation, saveOperation, type Ctx, type OperationRecord } from "../src/tools"
import {
  deliverRecordedAttention,
  deliverRecordedOperation,
  type DeliveryPayload,
  type DeliveryTransport,
} from "../src/codex-delivery"
import { detectNeedsInput } from "../src/attention"
import { permissionAttentionKey } from "../src/codex-attention"

// Offline execution-event tests (gangway-34r.1). The fake upstream holds the
// durable transcript and storage; events are fed directly or through a fake
// AsyncIterable so every case runs without a provider, network or real server.

type Message = { type: string; [key: string]: any }

interface Session {
  id: string
  messages: Message[]
  completed: number
}

class MemoryStorage {
  readonly map = new Map<string, unknown>()
  async set(key: string, value: unknown): Promise<void> {
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
      ...(start + page.length < keys.length && page.length > 0
        ? { next: page[page.length - 1] }
        : {}),
    }
  }
}

class Backend {
  readonly storage = new MemoryStorage()
  readonly sessions = new Map<string, Session>()
  readonly promptCalls: Array<{ sessionID: string; text: string }> = []
  readonly permissions = new Map<string, unknown[]>()
  readonly forms = new Map<string, unknown[]>()
  autoComplete = false
  completeText = "assistant-output"
  private counter = 0

  seedSession(): Session {
    const id = `ses_${(++this.counter).toString().padStart(4, "0")}`
    const session: Session = { id, messages: [], completed: 0 }
    this.sessions.set(id, session)
    return session
  }

  completeTurn(sessionID: string, text: string, outcome = "succeeded"): void {
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error(`session ${sessionID} not found`)
    const n = (session.completed += 1)
    session.messages.push({
      type: "assistant",
      id: `msg_${sessionID}_${n}`,
      content: [{ type: "text", text }],
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      time: { created: 1_000 + n, completed: 1_000 + n },
      cost: 0.001,
      tokens: { input: 1, output: 1 },
      finish: "stop",
    })
    session.messages.push({ type: "idle", outcome })
  }

  ctx(event?: EventStream): Ctx {
    return {
      location: { directory: "/repo" },
      event,
      session: {
        create: async () => ({ id: this.seedSession().id }),
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = this.sessions.get(sessionID)
          if (!session) throw new Error(`session ${sessionID} not found`)
          return {
            title: null,
            agent: null,
            model: null,
            outcome: null,
            time: { updated: 0, idle: null },
            tokens: null,
            cost: null,
          }
        },
        context: async ({ sessionID }: { sessionID: string }) => {
          const session = this.sessions.get(sessionID)
          if (!session) throw new Error(`session ${sessionID} not found`)
          return session.messages
        },
        prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
          const session = this.sessions.get(sessionID)
          if (!session) throw new Error(`session ${sessionID} not found`)
          const n = this.promptCalls.length + 1
          this.promptCalls.push({ sessionID, text })
          session.messages.push({ type: "user", id: `usr_${n}`, text })
          if (this.autoComplete) this.completeTurn(sessionID, this.completeText)
          return { id: `ack_${sessionID}_${n}` }
        },
        interrupt: async () => ({}),
        wait: async () => ({}),
      },
      permission: { list: async ({ sessionID }: { sessionID: string }) => this.permissions.get(sessionID) ?? [] },
      form: { list: async ({ sessionID }: { sessionID: string }) => this.forms.get(sessionID) ?? [] },
      storage: this.storage,
    }
  }
}

interface Harness {
  backend: Backend
  server: McpServerHandle
}

function harness(backend = new Backend()): Harness {
  const server = startMcpServer({ port: 0, ctx: backend.ctx() })
  return { backend, server }
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean }

function textOf(result: unknown): string {
  return ((result as ToolResult).content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
}

function payload(result: unknown): any {
  return JSON.parse(textOf(result))
}

async function callTool(server: McpServerHandle, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = new Client({ name: "gangway-event-test", version: "0.0.1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult
  } finally {
    await client.close()
  }
}

async function startOperation(server: McpServerHandle, requestID: string, prompt = "task"): Promise<any> {
  return payload(await callTool(server, "opencode_start_session", { prompt, requestID, wait: false }))
}

async function recordOf(backend: Backend, requestID: string): Promise<OperationRecord> {
  const page = await backend.storage.scan({ prefix: "operations/", limit: 100 })
  const found = page.entries.find((entry) => (entry.value as any)?.requestID === requestID)
  if (!found) throw new Error(`operation ${requestID} not found`)
  return found.value as OperationRecord
}

let eventSeq = 0
function event(
  type: string,
  sessionID: string,
  data: Record<string, unknown> = {},
  created = Date.now(),
  id = `evt_${++eventSeq}`,
): Record<string, unknown> {
  return { id, type, created, data: { sessionID, ...data } }
}

function formEvent(
  type: "form.created" | "form.replied" | "form.cancelled",
  sessionID: string,
  id: string,
  title: string | null = null,
  created = Date.now(),
): Record<string, unknown> {
  const data = type === "form.created"
    ? { form: { id, sessionID, ...(title ? { title } : {}) } }
    : { id, sessionID }
  return { id: `evt_${++eventSeq}`, type, created, data }
}

class FakeStream {
  private queue: unknown[] = [];
  private waiters: Array<{
    resolve(value: IteratorResult<unknown>): void;
    reject(error: unknown): void;
  }> = [];
  private failure: unknown = null;
  private ended = false;

  [Symbol.asyncIterator]() {
    return this
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift(), done: false })
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  push(value: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.queue.push(value)
  }

  fail(error: unknown): void {
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  finish(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }

  return(): Promise<IteratorResult<unknown>> {
    this.ended = true
    return Promise.resolve({ value: undefined, done: true })
  }
}

function fakeSource(): { source: EventStream; streams: FakeStream[] } {
  const streams: FakeStream[] = []
  return {
    streams,
    source: {
      subscribe() {
        const stream = new FakeStream()
        streams.push(stream)
        return stream
      },
    },
  }
}

describe("terminal execution events", () => {
  test("queue reconciliation preserves host timestamp identity for no-ID attention", async () => {
    const backend = new Backend()
    const sessionID = "ses_queue_identity"
    const item = {
      action: "shell",
      message: "run command",
      resources: ["bun test"],
      time: { created: 1_700_000_000_001 },
    }
    backend.permissions.set(sessionID, [item])

    const first = await detectNeedsInput(backend.ctx(), sessionID, "/repo")
    const repeated = await detectNeedsInput(backend.ctx(), sessionID, "/repo")
    expect(first?.requests[0].sourceEventID).toBe("queue:time.created:1700000000001")
    expect(permissionAttentionKey(first!.requests[0])).toBe(
      permissionAttentionKey(repeated!.requests[0]),
    )

    backend.permissions.set(sessionID, [{ ...item, time: { created: 1_700_000_000_002 } }])
    const next = await detectNeedsInput(backend.ctx(), sessionID, "/repo")
    expect(permissionAttentionKey(next!.requests[0])).not.toBe(
      permissionAttentionKey(first!.requests[0]),
    )

    backend.permissions.set(sessionID, [{
      action: item.action,
      message: item.message,
      resources: item.resources,
    }])
    const withoutIdentity = await detectNeedsInput(backend.ctx(), sessionID, "/repo")
    expect(withoutIdentity?.requests[0].sourceEventID).toBeUndefined()
    expect(permissionAttentionKey(withoutIdentity!.requests[0])).toStartWith(
      "attention:permission:shape:",
    )
    const repeatedWithoutIdentity = await detectNeedsInput(backend.ctx(), sessionID, "/repo")
    expect(permissionAttentionKey(repeatedWithoutIdentity!.requests[0])).toBe(
      permissionAttentionKey(withoutIdentity!.requests[0]),
    )
  })

  test("success completes before transcript projection with bounded streamed text", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-success")
      const op = await recordOf(backend, "req-success")
      const long = "x".repeat(30_000)
      const text = await recordExecutionEvent(
        backend.ctx(),
        event("session.text.ended", started.sessionID, {
          assistantMessageID: "msg_1",
          ordinal: 0,
          text: long,
        }, op.submittedAt! + 1),
      )
      expect(text.handled).toBe(true)

      const done = await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.succeeded", started.sessionID, {}, op.submittedAt! + 2),
      )
      expect(done).toMatchObject({ handled: true, terminal: true, state: "completed" })

      const recorded = await recordOf(backend, "req-success")
      expect(recorded.state).toBe("completed")
      expect(recorded.terminalSource).toBe("event")
      expect(recorded.completion?.outcome).toBe("succeeded")
      expect(recorded.completion?.text.length).toBe(20_000)
      expect(backend.sessions.get(started.sessionID)?.messages.some((m) => m.type === "assistant")).toBe(false)

      const status = payload(
        await callTool(server, "opencode_status", { sessionID: started.sessionID, requestID: "req-success" }),
      )
      expect(status.status).toBe("completed")

      const result = payload(
        await callTool(server, "opencode_result", { sessionID: started.sessionID, requestID: "req-success", maxChars: 100 }),
      )
      expect(result.text.length).toBe(100)
      expect(result.truncated).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("failure records a failed terminal outcome and bounded error", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-failed")
      const op = await recordOf(backend, "req-failed")
      const result = await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.failed", started.sessionID, {
          error: { type: "provider", message: "provider exploded" },
        }, op.submittedAt! + 1),
      )
      expect(result).toMatchObject({ handled: true, terminal: true, state: "failed" })
      const recorded = await recordOf(backend, "req-failed")
      expect(recorded.state).toBe("failed")
      expect(recorded.completion?.outcome).toBe("failed")
      expect(recorded.error).toBe("provider exploded")
      expect(recorded.completion?.text).toBe("")
    } finally {
      server.stop()
    }
  })

  test("interruption is terminal and distinguishable from failure", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-interrupted")
      const op = await recordOf(backend, "req-interrupted")
      const result = await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.interrupted", started.sessionID, { reason: "user" }, op.submittedAt! + 1),
      )
      expect(result).toMatchObject({ handled: true, terminal: true, state: "failed" })
      const recorded = await recordOf(backend, "req-interrupted")
      expect(recorded.completion?.outcome).toBe("interrupted")
      expect(recorded.error).toBe("interrupted: user")
    } finally {
      server.stop()
    }
  })

  test("terminal events without assistant text still complete with an empty result", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-empty")
      const op = await recordOf(backend, "req-empty")
      await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.succeeded", started.sessionID, {}, op.submittedAt! + 1),
      )
      const result = payload(
        await callTool(server, "opencode_result", { sessionID: started.sessionID, requestID: "req-empty" }),
      )
      expect(result.state).toBe("completed")
      expect(result.text).toBe("")
    } finally {
      server.stop()
    }
  })
})

describe("attention events", () => {
  test("permission and question requests are nonterminal until replied or cancelled", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-attention")
      const op = await recordOf(backend, "req-attention")

      const asked = await recordExecutionEvent(
        backend.ctx(),
        event("permission.asked", started.sessionID, {
          id: "per_1",
          action: "shell",
          resources: ["npm install"],
          message: "approve shell",
        }, op.submittedAt! + 1),
      )
      expect(asked).toMatchObject({ handled: true, terminal: false, state: "submitted" })

      const status = payload(
        await callTool(server, "opencode_status", { sessionID: started.sessionID, requestID: "req-attention" }),
      )
      expect(status.needsInput.kind).toBe("permission")
      expect(status.needsInput.requests[0].id).toBe("per_1")
      expect(status.status).toBe("running")

      const begin = Date.now()
      const waited = payload(
        await callTool(server, "opencode_wait", {
          sessionID: started.sessionID,
          requestID: "req-attention",
          timeoutMs: 5_000,
        }),
      )
      expect(Date.now() - begin).toBeLessThan(1_000)
      expect(waited.waitResult).toBe("needs-input")
      expect(waited.needsInput.kind).toBe("permission")
      expect(waited.state).not.toBe("completed")

      await recordExecutionEvent(
        backend.ctx(),
        event("permission.replied", started.sessionID, { requestID: "per_1", reply: "once" }, op.submittedAt! + 2),
      )
      expect((await recordOf(backend, "req-attention")).attention).toBeNull()

      await recordExecutionEvent(
        backend.ctx(),
        formEvent("form.created", started.sessionID, "form_1", "Which option?", op.submittedAt! + 3),
      )
      const question = payload(
        await callTool(server, "opencode_status", { sessionID: started.sessionID, requestID: "req-attention" }),
      )
      expect(question.needsInput.kind).toBe("question")
      expect(question.needsInput.forms[0].id).toBe("form_1")

      await recordExecutionEvent(
        backend.ctx(),
        formEvent("form.cancelled", started.sessionID, "form_1", null, op.submittedAt! + 4),
      )
      expect((await recordOf(backend, "req-attention")).attention).toBeNull()
      expect((await recordOf(backend, "req-attention")).state).not.toBe("completed")
    } finally {
      server.stop()
    }
  })

  test("a question permission is classified as a question and duplicated asks do not duplicate", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-question-perm")
      const op = await recordOf(backend, "req-question-perm")
      const ask = event("permission.asked", started.sessionID, {
        id: "per_q",
        action: "question",
        resources: null,
        message: "which option?",
      }, op.submittedAt! + 1)
      await recordExecutionEvent(backend.ctx(), ask)
      const duplicate = await recordExecutionEvent(backend.ctx(), ask)
      const first = await recordExecutionEvent(backend.ctx(), event("permission.asked", started.sessionID, {
        id: "per_q2",
        action: "question",
        resources: null,
        message: "another option?",
      }, op.submittedAt! + 2))
      expect(first.attentionKey).toBeString()
      expect(duplicate.attentionKey).toBeUndefined()
      const recorded = await recordOf(backend, "req-question-perm")
      expect(recorded.attention?.kind).toBe("question")
      expect(recorded.attention?.requests).toHaveLength(2)
      expect(recorded.attention?.requests[0].id).toBe("per_q")
    } finally {
      server.stop()
    }
  })

  test("same-shape requests without upstream ids get distinct event-based delivery keys", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-attention-shape")
      const op = await recordOf(backend, "req-attention-shape")
      const common = {
        action: "shell",
        resources: ["npm install"],
        message: "approve this command",
      }
      const first = await recordExecutionEvent(
        backend.ctx(),
        event("permission.asked", started.sessionID, common, op.submittedAt! + 1, "evt_shape_a"),
      )
      const second = await recordExecutionEvent(
        backend.ctx(),
        event("permission.asked", started.sessionID, common, op.submittedAt! + 2, "evt_shape_b"),
      )
      const duplicate = await recordExecutionEvent(
        backend.ctx(),
        event("permission.asked", started.sessionID, common, op.submittedAt! + 1, "evt_shape_a"),
      )
      const recorded = await recordOf(backend, "req-attention-shape")

      expect(first.attentionKey).toBeString()
      expect(second.attentionKey).toBeString()
      expect(second.attentionKey).not.toBe(first.attentionKey)
      expect(duplicate.attentionKey).toBeUndefined()
      expect(recorded.attention?.requests).toHaveLength(2)
    } finally {
      server.stop()
    }
  })
})

describe("stale, unrelated and duplicate events", () => {
  test("stale idle and foreign-session events cannot complete the operation", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-stale")
      const op = await recordOf(backend, "req-stale")
      const foreign = backend.seedSession()

      const stale = await recordExecutionEvent(
        backend.ctx(),
        event("session.idle", started.sessionID, {}, op.submittedAt! - 1_000),
      )
      expect(stale.handled).toBe(false)

      const other = await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.succeeded", foreign.id, {}, op.submittedAt! + 1),
      )
      expect(other.handled).toBe(false)
      expect((await recordOf(backend, "req-stale")).state).toBe("submitted")
    } finally {
      server.stop()
    }
  })

  test("an unrelated inbox id does not admit the operation", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-inbox")
      const op = await recordOf(backend, "req-inbox")
      expect(op.submittedMessageID).toBeTruthy()

      const unrelated = await recordExecutionEvent(
        backend.ctx(),
        event("session.inbox.enqueued", started.sessionID, {
          inboxID: "someone-else",
          item: { type: "user" },
        }, op.submittedAt! + 1),
      )
      expect(unrelated.handled).toBe(false)
      expect((await recordOf(backend, "req-inbox")).admittedAt).toBeNull()

      const admitted = await recordExecutionEvent(
        backend.ctx(),
        event("session.inbox.delivered", started.sessionID, {
          inboxID: op.submittedMessageID,
        }, op.submittedAt! + 2),
      )
      expect(admitted.handled).toBe(true)
      expect((await recordOf(backend, "req-inbox")).admittedAt).toBe(op.submittedAt! + 2)
    } finally {
      server.stop()
    }
  })

  test("repeated terminal events keep the first completion", async () => {
    const { backend, server } = harness()
    try {
      const started = await startOperation(server, "req-repeat")
      const op = await recordOf(backend, "req-repeat")
      await recordExecutionEvent(
        backend.ctx(),
        event("session.text.ended", started.sessionID, {
          assistantMessageID: "msg_a",
          ordinal: 0,
          text: "first",
        }, op.submittedAt! + 1),
      )
      const success = event("session.execution.succeeded", started.sessionID, {}, op.submittedAt! + 2)
      await recordExecutionEvent(backend.ctx(), success)
      const duplicate = await recordExecutionEvent(backend.ctx(), success)
      expect(duplicate.handled).toBe(false)
      const later = await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.failed", started.sessionID, { error: { message: "late" } }, op.submittedAt! + 3),
      )
      expect(later.handled).toBe(false)

      const recorded = await recordOf(backend, "req-repeat")
      expect(recorded.state).toBe("completed")
      expect(recorded.completion?.outcome).toBe("succeeded")
      expect(recorded.completion?.text).toBe("first")
    } finally {
      server.stop()
    }
  })

  test("a stale idle after an older answer cannot complete a new operation", async () => {
    const backend = new Backend()
    const existing = backend.seedSession()
    backend.completeTurn(existing.id, "OLD ANSWER")
    const { server } = harness(backend)
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", {
          prompt: "new task",
          sessionID: existing.id,
          requestID: "req-old-answer",
          wait: false,
        }),
      )
      expect(started.sessionID).toBe(existing.id)
      const op = await recordOf(backend, "req-old-answer")

      const stale = await recordExecutionEvent(
        backend.ctx(),
        event("session.idle", existing.id, {}, op.submittedAt! - 1),
      )
      expect(stale.handled).toBe(false)
      expect((await recordOf(backend, "req-old-answer")).state).toBe("submitted")

      await recordExecutionEvent(
        backend.ctx(),
        event("session.text.ended", existing.id, {
          assistantMessageID: "msg_new",
          ordinal: 0,
          text: "NEW ANSWER",
        }, op.submittedAt! + 1),
      )
      await recordExecutionEvent(
        backend.ctx(),
        event("session.execution.succeeded", existing.id, {}, op.submittedAt! + 2),
      )
      expect((await recordOf(backend, "req-old-answer")).completion?.text).toBe("NEW ANSWER")
    } finally {
      server.stop()
    }
  })
})

describe("subscription lifecycle", () => {
  test("monitor liveness follows successful subscription and disconnect", async () => {
    const backend = new Backend()
    const { source, streams } = fakeSource()
    const disconnected = Promise.withResolvers<void>()
    const reconnected = Promise.withResolvers<void>()
    const monitor = startExecutionMonitor(backend.ctx(source), {
      reconnectDelayMs: 10,
      onUnsubscribed() {
        disconnected.resolve()
      },
      onSubscribed(attempt) {
        if (attempt === 2) reconnected.resolve()
      },
    })
    try {
      await monitor.ready
      expect(monitor.available).toBe(true)
      streams[0].fail(new Error("disconnect"))
      await disconnected.promise
      expect(monitor.available).toBe(false)
      await reconnected.promise
      expect(monitor.available).toBe(true)
    } finally {
      monitor.stop()
    }
  })

  test("events arriving on the subscribed stream complete the admitted turn", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const { source, streams } = fakeSource()
    const processed = Promise.withResolvers<unknown>()
    const monitor = startExecutionMonitor(backend.ctx(source), {
      reconnectDelayMs: 0,
      onEvent(_event, result) {
        if (result.handled) processed.resolve(result)
      },
    })
    try {
      await monitor.ready
      // Subscription is established before dispatch, matching plugin setup.
      const started = await startOperation(server, "req-stream")
      const op = await recordOf(backend, "req-stream")
      streams[0].push(event("session.execution.succeeded", started.sessionID, {}, op.submittedAt! + 1))
      const result = await processed.promise as { state?: string; terminal?: boolean }
      expect(result).toMatchObject({ state: "completed", terminal: true })
      expect((await recordOf(backend, "req-stream")).completion?.outcome).toBe("succeeded")
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("periodic reconciliation delivers a terminal result dropped while the stream stays open", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const { source, streams } = fakeSource()
    const worker = crypto.randomUUID()
    const payloads: DeliveryPayload[] = []
    const monitorCtx = backend.ctx(source)
    const originalContext = monitorCtx.session.context
    let activeReads = 0
    let maxActiveReads = 0
    monitorCtx.session.context = async (args) => {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return await originalContext(args)
      } finally {
        activeReads -= 1
      }
    }
    const accepted = Promise.withResolvers<void>()
    const transport: DeliveryTransport = {
      async send({ payload }) {
        payloads.push(payload)
        accepted.resolve()
        return { recipientThreadId: worker, turnId: "turn_periodic" }
      },
    }
    let candidateCount = 0
    const monitor = startExecutionMonitor(monitorCtx, {
      reconnectDelayMs: 0,
      reconcileIntervalMs: 10,
      onDeliveryReconciled(candidates) {
        for (const candidate of candidates) {
          if (!candidate.result) continue
          candidateCount += 1
          void deliverRecordedOperation(backend.ctx(), candidate.requestID, { transport })
        }
      },
    })
    try {
      await monitor.ready
      const started = await startOperation(server, "req-dropped-terminal-event")
      const op = await recordOf(backend, "req-dropped-terminal-event")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })

      // The host transcript reaches success, but its terminal event is lost.
      // The event iterator remains healthy, so only the periodic sweep can see it.
      backend.completeTurn(started.sessionID, "finished without an event")
      await accepted.promise
      await new Promise((resolve) => setTimeout(resolve, 35))

      expect(monitor.available).toBe(true)
      expect(streams).toHaveLength(1)
      expect(candidateCount).toBe(1)
      expect(payloads).toHaveLength(1)
      expect(maxActiveReads).toBe(1)
      expect(payloads[0].kind).toBe("gangway.operation.result")
      const completed = await recordOf(backend, "req-dropped-terminal-event")
      expect(completed.state).toBe("completed")
      expect(Object.values(completed.codexDelivery?.events ?? {})[0]?.status).toBe("accepted")
      monitor.stop()
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(candidateCount).toBe(1)
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("periodic reconciliation rechecks running probes and finds status-terminalized results", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const { source, streams } = fakeSource()
    const worker = crypto.randomUUID()
    const payloads: DeliveryPayload[] = []
    const monitorCtx = backend.ctx(source)
    const originalContext = monitorCtx.session.context
    const firstProbe = Promise.withResolvers<void>()
    let monitorProbes = 0
    monitorCtx.session.context = async (args) => {
      monitorProbes += 1
      firstProbe.resolve()
      return originalContext(args)
    }
    const accepted = Promise.withResolvers<void>()
    const transport: DeliveryTransport = {
      async send({ payload }) {
        payloads.push(payload)
        accepted.resolve()
        return { recipientThreadId: worker, turnId: "turn_status_terminal" }
      },
    }
    const monitor = startExecutionMonitor(monitorCtx, {
      reconnectDelayMs: 0,
      reconcileIntervalMs: 100,
      onDeliveryReconciled(candidates) {
        for (const candidate of candidates) {
          if (candidate.result) {
            void deliverRecordedOperation(backend.ctx(), candidate.requestID, { transport })
          }
        }
      },
    })
    try {
      await monitor.ready
      const started = await startOperation(server, "req-status-terminalized")
      const op = await recordOf(backend, "req-status-terminalized")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })

      // The first sweep sees a healthy, still-running transcript.
      await firstProbe.promise
      expect((await recordOf(backend, "req-status-terminalized")).state).toBe("submitted")
      backend.completeTurn(started.sessionID, "finished before status")
      const status = payload(await callTool(server, "opencode_status", {
        sessionID: started.sessionID,
        requestID: "req-status-terminalized",
        reconcile: true,
      }))
      expect(status.state).toBe("completed")

      // The monitor's next fair sweep notices the durable terminal state even
      // though status finalized it and no execution event arrived.
      await accepted.promise
      expect(monitor.available).toBe(true)
      expect(streams).toHaveLength(1)
      expect(monitorProbes).toBeGreaterThanOrEqual(1)
      expect(payloads).toHaveLength(1)
      expect(payloads[0].text).toBe("finished before status")
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("a completion that happened before subscribe is reconciled on startup", async () => {
    const backend = new Backend()
    backend.autoComplete = true
    backend.completeText = "fast"
    const { server } = harness(backend)
    let monitor: ExecutionMonitor | undefined
    try {
      await startOperation(server, "req-fast")
      const { source, streams } = fakeSource()
      monitor = startExecutionMonitor(backend.ctx(source), { reconnectDelayMs: 0 })
      await monitor.ready
      expect(streams.length).toBeGreaterThan(0)
      expect((await recordOf(backend, "req-fast")).state).toBe("completed")
      expect((await recordOf(backend, "req-fast")).completion?.text).toBe("fast")
    } finally {
      monitor?.stop()
      server.stop()
    }
  })

  test("a reconnect delivers a terminal outcome missed while the stream was down exactly once", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const { source, streams } = fakeSource()
    const worker = crypto.randomUUID()
    const payloads: DeliveryPayload[] = []
    const accepted = Promise.withResolvers<void>()
    const transport: DeliveryTransport = {
      async send({ payload }) {
        payloads.push(payload)
        accepted.resolve()
        return { recipientThreadId: worker, turnId: "turn_reconnect" }
      },
    }
    let third!: () => void
    const resubscribed = new Promise<void>((resolve) => (third = resolve))
    const monitor = startExecutionMonitor(backend.ctx(source), {
      reconnectDelayMs: 0,
      onReconciled(requestIDs) {
        for (const requestID of requestIDs) {
          void deliverRecordedOperation(backend.ctx(), requestID, { transport })
        }
      },
      onSubscribed(attempt) {
        if (attempt === 3) third()
      },
    })
    try {
      await monitor.ready
      const started = await startOperation(server, "req-reconnect-push")
      const op = await recordOf(backend, "req-reconnect-push")
      await saveOperation(backend.ctx(), {
        ...op,
        notify: true,
        codexThreadId: worker,
      })

      // The completion happens while the stream is down; only reconnect
      // reconciliation can observe it.
      streams[0].fail(new Error("stream dropped"))
      backend.completeTurn(started.sessionID, "finished offline")
      await accepted.promise

      expect(payloads).toHaveLength(1)
      expect(payloads[0].kind).toBe("gangway.operation.result")
      expect(payloads[0].source.workerThreadId).toBe(worker)
      expect((await recordOf(backend, "req-reconnect-push")).state).toBe("completed")

      // A later reconnect has no nonterminal candidate and must not resend.
      streams[1].fail(new Error("stream dropped again"))
      await resubscribed
      expect(payloads).toHaveLength(1)
      const delivery = Object.values(
        (await recordOf(backend, "req-reconnect-push")).codexDelivery?.events ?? {},
      )[0]
      expect(delivery?.status).toBe("accepted")
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("a reconnect reconciles a completion missed while the stream was down", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const { source, streams } = fakeSource()
    let subscribed = 0
    let second!: () => void
    const reconnected = new Promise<void>((resolve) => (second = resolve))
    let reconciled: string[] = []
    const monitor = startExecutionMonitor(backend.ctx(source), {
      reconnectDelayMs: 0,
      onSubscribed(attempt) {
        subscribed = attempt
        if (attempt === 2) second()
      },
      onReconciled(requestIDs) {
        reconciled = requestIDs
      },
    })
    try {
      const started = await startOperation(server, "req-reconnect")
      await monitor.ready
      expect(streams.length).toBe(1)

      streams[0].fail(new Error("stream dropped"))
      backend.completeTurn(started.sessionID, "finished offline")
      await reconnected
      expect(subscribed).toBe(2)
      expect(reconciled).toEqual(["req-reconnect"])
      const recorded = await recordOf(backend, "req-reconnect")
      expect(recorded.state).toBe("completed")
      expect(recorded.completion?.text).toBe("finished offline")
      expect(recorded.terminalSource).toBe("transcript")
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("reconnect offers attention observed from the live permission queue", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const { source, streams } = fakeSource()
    const worker = crypto.randomUUID()
    const candidate = Promise.withResolvers<any>()
    const monitor = startExecutionMonitor(backend.ctx(source), {
      reconnectDelayMs: 0,
      onDeliveryReconciled(items) {
        if (items.some((item) => item.attentionKeys.length > 0)) candidate.resolve(items[0])
      },
    })
    try {
      await monitor.ready
      const started = await startOperation(server, "req-attention-reconnect")
      const op = await recordOf(backend, "req-attention-reconnect")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })

      streams[0].fail(new Error("stream dropped"))
      backend.permissions.set(started.sessionID, [{
        id: "per_offline",
        action: "shell",
        resources: ["npm install"],
        message: "approve after reconnect",
      }])
      const reconciled = await candidate.promise
      expect(reconciled).toMatchObject({ requestID: "req-attention-reconnect", result: false })
      expect(reconciled.attentionKeys).toEqual(["attention:permission:id:per_offline"])
      expect((await recordOf(backend, "req-attention-reconnect")).attention?.requests[0].id).toBe("per_offline")
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("startup retries a transient transcript failure and reconciles the terminal result", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const started = await startOperation(server, "req-transient-reconcile")
    const op = await recordOf(backend, "req-transient-reconcile")
    const worker = crypto.randomUUID()
    await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })
    backend.completeTurn(started.sessionID, "completed during reconnect")
    const { source } = fakeSource()
    const ctx = backend.ctx(source)
    const originalContext = ctx.session.context
    let failedOnce = false
    ctx.session.context = async (args) => {
      if (!failedOnce) {
        failedOnce = true
        throw new Error("temporary transcript failure")
      }
      return originalContext(args)
    }
    const candidate = Promise.withResolvers<any>()
    const monitor = startExecutionMonitor(ctx, {
      reconnectDelayMs: 0,
      reconcileRetryMs: 10,
      onDeliveryReconciled(items) {
        if (items.some((item) => item.result)) candidate.resolve(items.find((item) => item.result))
      },
    })
    try {
      await monitor.ready
      const reconciled = await candidate.promise
      expect(reconciled).toMatchObject({ requestID: "req-transient-reconcile", result: true })
      expect(failedOnce).toBe(true)
      expect((await recordOf(backend, "req-transient-reconcile")).state).toBe("completed")
    } finally {
      monitor.stop()
      server.stop()
    }
  })

  test("a terminal operation reconciled by another tool is found even with no delivery record", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const started = await startOperation(server, "req-already-terminal")
    const worker = crypto.randomUUID()
    const admitted = await recordOf(backend, "req-already-terminal")
    await saveOperation(backend.ctx(), { ...admitted, notify: true, codexThreadId: worker })
    backend.completeTurn(started.sessionID, "completed by tool path")
    await callTool(server, "opencode_status", {
      sessionID: started.sessionID,
      requestID: "req-already-terminal",
      reconcile: true,
    })
    const terminal = await recordOf(backend, "req-already-terminal")
    expect(terminal.state).toBe("completed")

    try {
      const result = await reconcileDeliveryState(backend.ctx())
      expect(result.candidates).toEqual([{
        requestID: "req-already-terminal",
        result: true,
        attentionKeys: [],
      }])
      expect(result.terminalizedRequestIDs).toEqual([])
    } finally {
      server.stop()
    }
  })

  test("delivery discovery scans beyond the first 500 hash-ordered operation rows", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    await startOperation(server, "req-after-first-500")
    const op = await recordOf(backend, "req-after-first-500")
    op.state = "completed"
    op.completion = {
      text: "terminal output",
      model: null,
      cost: null,
      tokens: null,
      finish: null,
      error: null,
      outcome: "succeeded",
      messageID: null,
      outputId: "output-after-first-500",
      completedAt: Date.now(),
    }
    op.notify = true
    op.codexThreadId = crypto.randomUUID()
    await saveOperation(backend.ctx(), op)

    const targetKey = [...backend.storage.map.keys()].find((key) =>
      (backend.storage.map.get(key) as any)?.requestID === op.requestID,
    )!
    const targetHash = BigInt("0x" + targetKey.slice("operations/".length))
    for (let i = 1; i <= 510; i++) {
      const hash = (targetHash - BigInt(i)).toString(16).padStart(16, "0")
      backend.storage.map.set("operations/" + hash, {})
    }

    try {
      const result = await reconcileDeliveryState(backend.ctx())
      expect(result.candidates).toEqual([{
        requestID: op.requestID,
        result: true,
        attentionKeys: [],
      }])
    } finally {
      server.stop()
    }
  })

  test("queue reconciliation merges event identity with the matching live queue item", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const worker = crypto.randomUUID()
    try {
      const started = await startOperation(server, "req-merge-attention")
      const op = await recordOf(backend, "req-merge-attention")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })
      const asked = event("permission.asked", started.sessionID, {
        action: "shell",
        resources: ["bun test"],
        message: "approve",
      }, op.submittedAt! + 1, "evt_merge")
      const eventResult = await recordExecutionEvent(backend.ctx(), asked)
      expect(eventResult.attentionKey).toBe("attention:permission:event:evt_merge")
      backend.permissions.set(started.sessionID, [{
        action: "shell",
        resources: ["bun test"],
        message: "approve",
      }])

      const result = await reconcileDeliveryState(backend.ctx())
      const recorded = await recordOf(backend, "req-merge-attention")
      expect(recorded.attention?.requests).toHaveLength(1)
      expect(recorded.attention?.requests[0].sourceEventID).toBe("event:evt_merge")
      expect(result.candidates[0]?.attentionKeys).toEqual([
        "attention:permission:event:evt_merge",
      ])
    } finally {
      server.stop()
    }
  })

  test("queue-first permission attention keeps its key when the no-ID event arrives", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const worker = crypto.randomUUID()
    const transport: DeliveryTransport = {
      async send() {
        return { recipientThreadId: worker, turnId: "turn_queue_first_permission" }
      },
    }
    try {
      const started = await startOperation(server, "req-queue-first-permission")
      const op = await recordOf(backend, "req-queue-first-permission")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })
      backend.permissions.set(started.sessionID, [{
        action: "shell",
        resources: ["make test"],
        message: "approve command",
        time: { created: 1_700_000_000_321 },
      }])
      const first = await reconcileDeliveryState(backend.ctx())
      const key = first.candidates[0]!.attentionKeys[0]!
      expect(key).toBe("attention:permission:event:queue:time.created:1700000000321")
      expect((await deliverRecordedAttention(backend.ctx(), op.requestID, key, { transport })).status)
        .toBe("accepted")

      const eventResult = await recordExecutionEvent(backend.ctx(), event(
        "permission.asked",
        started.sessionID,
        { action: "shell", resources: ["make test"], message: "approve command" },
        op.submittedAt! + 1,
        "evt_queue_first_permission",
      ))
      expect(eventResult.attentionKey).toBe(key)
      expect((await recordOf(backend, op.requestID)).attention?.requests).toHaveLength(1)
      const afterEvent = await reconcileDeliveryState(backend.ctx())
      expect(afterEvent.candidates.find((candidate) => candidate.requestID === op.requestID))
        .toBeUndefined()
    } finally {
      server.stop()
    }
  })

  test("queue-first no-ID form attention keeps its shape key when the event arrives", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const worker = crypto.randomUUID()
    const transport: DeliveryTransport = {
      async send() {
        return { recipientThreadId: worker, turnId: "turn_queue_first_form" }
      },
    }
    try {
      const started = await startOperation(server, "req-queue-first-form")
      const op = await recordOf(backend, "req-queue-first-form")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })
      backend.forms.set(started.sessionID, [{ title: "Choose a branch" }])
      const first = await reconcileDeliveryState(backend.ctx())
      const key = first.candidates[0]!.attentionKeys[0]!
      expect(key).toStartWith("attention:form:shape:")
      expect((await deliverRecordedAttention(backend.ctx(), op.requestID, key, { transport })).status)
        .toBe("accepted")

      const eventResult = await recordExecutionEvent(backend.ctx(), event(
        "form.created",
        started.sessionID,
        { form: { sessionID: started.sessionID, title: "Choose a branch" } },
        op.submittedAt! + 1,
        "evt_queue_first_form",
      ))
      expect(eventResult.attentionKey).toBe(key)
      expect((await recordOf(backend, op.requestID)).attention?.forms).toHaveLength(1)
      const afterEvent = await reconcileDeliveryState(backend.ctx())
      expect(afterEvent.candidates.find((candidate) => candidate.requestID === op.requestID))
        .toBeUndefined()
    } finally {
      server.stop()
    }
  })

  test("unknown queues preserve event attention while known-empty queues clear queue-only attention", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    const worker = crypto.randomUUID()
    try {
      const started = await startOperation(server, "req-queue-tristate")
      const op = await recordOf(backend, "req-queue-tristate")
      await saveOperation(backend.ctx(), { ...op, notify: true, codexThreadId: worker })
      await recordExecutionEvent(backend.ctx(), event("permission.asked", started.sessionID, {
        id: "per_event",
        action: "shell",
        resources: ["git status"],
        message: "event request",
      }, op.submittedAt! + 1, "evt_queue_preserve"))
      const unknownCtx = backend.ctx()
      unknownCtx.permission!.list = async () => new Promise(() => {})
      const preserved = await reconcileDeliveryState(unknownCtx, undefined, 10)
      expect(preserved.candidates[0]?.attentionKeys).toEqual([
        "attention:permission:event:evt_queue_preserve",
      ])
      expect((await recordOf(backend, "req-queue-tristate")).attention?.requests).toHaveLength(1)

      const second = await startOperation(server, "req-queue-clear")
      const secondOp = await recordOf(backend, "req-queue-clear")
      await saveOperation(backend.ctx(), { ...secondOp, notify: true, codexThreadId: worker })
      backend.permissions.set(second.sessionID, [{
        id: "per_stale_queue",
        action: "shell",
        resources: ["make test"],
        message: "stale queue request",
      }])
      await reconcileDeliveryState(backend.ctx())
      expect((await recordOf(backend, "req-queue-clear")).attention?.requests).toHaveLength(1)
      backend.permissions.set(second.sessionID, [])
      const cleared = await reconcileDeliveryState(backend.ctx())
      expect((await recordOf(backend, "req-queue-clear")).attention).toBeNull()
      expect(cleared.candidates.find((item) => item.requestID === "req-queue-clear")).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  test("a hung transcript probe times out without blocking reconciliation", async () => {
    const backend = new Backend()
    const { server } = harness(backend)
    try {
      const started = await startOperation(server, "req-hung-probe")
      const ctx = backend.ctx()
      ctx.session.context = async () => new Promise(() => {})
      const began = Date.now()
      const result = await reconcileDeliveryState(ctx, undefined, 15)
      expect(Date.now() - began).toBeLessThan(200)
      expect(result.transientRequestIDs).toEqual(["req-hung-probe"])
      expect((await recordOf(backend, "req-hung-probe")).state).toBe("submitted")

      const hangingAttention = backend.ctx()
      hangingAttention.permission!.list = async () => new Promise(() => {})
      const queueStarted = await recordOf(backend, "req-hung-probe")
      const afterAttention = await reconcileDeliveryState(hangingAttention, undefined, 15)
      expect(Date.now() - began).toBeLessThan(250)
      expect(afterAttention.candidates).toEqual([])
      expect(queueStarted.state).toBe("submitted")
    } finally {
      server.stop()
    }
  })
})
