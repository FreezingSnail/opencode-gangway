import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startMcpServer, type McpServerHandle } from "../src/mcp"
import type { Ctx } from "../src/tools"

// Focused, deterministic, offline tests for reliable dispatch/resume
// (gangway-5ti). A fake OpenCode context stands in for the real plugin context:
// sessions, transcript and storage are in memory, so every case runs without a
// live provider and without network access. The bridge's process-global operation
// lock and the per-request MCP server are exercised end to end through a real
// streamable-HTTP client.

type Message = { type: string; [key: string]: any }

interface Session {
  id: string
  title: unknown
  model: unknown
  agent: unknown
  location: unknown
  permissions: unknown
  metadata: unknown
  messages: Message[]
  completed: number
}

// In-memory plugin storage. `failSetAt` injects a write failure at the nth set of
// a key prefix so recovery paths can be tested deterministically. Values are
// JSON-round-tripped to mimic a serialized durable store.
class MemoryStorage {
  readonly map = new Map<string, unknown>()
  private readonly counts = new Map<string, number>()
  readonly setLog: string[] = []
  failSetAt: { prefix: string; nth: number } | null = null

  async set(key: string, value: unknown): Promise<void> {
    const nth = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, nth)
    this.setLog.push(key)
    if (this.failSetAt && key.startsWith(this.failSetAt.prefix) && nth === this.failSetAt.nth) {
      throw new Error(`injected storage failure for ${key}`)
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

// Fake upstream OpenCode service. Shared across contexts to model a plugin reload
// or endpoint-owner transfer (the service, and therefore sessions and storage,
// outlives a single plugin instance).
class Backend {
  readonly storage = new MemoryStorage()
  readonly sessions = new Map<string, Session>()
  // Attention queues: pending permission requests and question forms keyed by
  // session id. The bridge uses the matching ctx seams (no network) because the
  // fake context's location is the same directory for every session.
  readonly permissions = new Map<string, unknown[]>()
  readonly forms = new Map<string, unknown[]>()
  failPermissionProbe = false
  failFormProbe = false
  readonly createCalls: Array<Record<string, any>> = []
  readonly promptCalls: Array<{ sessionID: string; text: string; id?: string }> = []
  readonly interruptCalls: string[] = []
  readonly waitCalls: string[] = []
  createAttempts = 0
  promptAttempts = 0
  failCreate = false
  failPrompt = false
  // When true, a submitted prompt immediately produces an assistant message and
  // a trailing idle message. Tests that need a still-running turn disable it and
  // call completeTurn() explicitly.
  autoComplete = true
  completeText = "assistant-output"
  private counter = 0

  createSession(input: Record<string, any>): Session {
    this.createAttempts += 1
    if (this.failCreate) throw new Error("upstream create failed")
    return this.seedSession(input)
  }

  // Seeds a session without counting as a bridge create attempt (test setup only).
  seedSession(input: Record<string, any>): Session {
    const id = `ses_${(++this.counter).toString().padStart(4, "0")}`
    const session: Session = {
      id,
      title: input.title ?? null,
      model: input.model ?? null,
      agent: input.agent ?? null,
      location: input.location ?? null,
      permissions: "permissions" in input ? input.permissions : undefined,
      metadata: input.metadata ?? null,
      messages: [],
      completed: 0,
    }
    this.sessions.set(id, session)
    this.createCalls.push({ id, ...input })
    return session
  }

  submit(sessionID: string, text: string, id?: string): void {
    this.promptAttempts += 1
    if (this.failPrompt) throw new Error("upstream prompt failed")
    const session = this.sessions.get(sessionID)
    if (!session) throw new Error(`session ${sessionID} not found`)
    this.promptCalls.push({ sessionID, text, id })
    session.messages.push({ type: "user", id: `usr_${this.promptCalls.length}`, text })
    if (this.autoComplete) this.completeTurn(sessionID, this.completeText)
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

  context(): Ctx {
    return {
      location: { directory: "/repo" },
      session: {
        create: async (input: Record<string, unknown>) => ({ id: this.createSession(input).id }),
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = this.sessions.get(sessionID)
          if (!session) throw new Error(`session ${sessionID} not found`)
          return {
            title: session.title,
            agent: session.agent,
            model: session.model,
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
        prompt: async (input: { sessionID: string; text: string; id?: string }) => {
          this.submit(input.sessionID, input.text, input.id)
          return { id: `ack_${input.sessionID}` }
        },
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          this.interruptCalls.push(sessionID)
          return {}
        },
        wait: async ({ sessionID }: { sessionID: string }) => {
          this.waitCalls.push(sessionID)
          return {}
        },
      },
      permission: {
        list: async ({ sessionID }: { sessionID: string }) => {
          if (this.failPermissionProbe) throw new Error("permission probe unavailable")
          return this.permissions.get(sessionID) ?? []
        },
      },
      form: {
        list: async ({ sessionID }: { sessionID: string }) => {
          if (this.failFormProbe) throw new Error("form probe unavailable")
          return this.forms.get(sessionID) ?? []
        },
      },
      storage: this.storage,
    }
  }
}

interface Harness {
  backend: Backend
  server: McpServerHandle
}

function harness(options: {
  backend?: Backend
  pluginOptions?: Record<string, unknown>
} = {}): Harness {
  const backend = options.backend ?? new Backend()
  const server = startMcpServer({
    port: 0,
    ctx: backend.context(),
    pluginOptions: options.pluginOptions ?? {},
  })
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
  const client = new Client({ name: "gangway-dispatch-test", version: "0.0.1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult
  } finally {
    await client.close()
  }
}

describe("idempotent dispatch (requestID)", () => {
  test("identical sequential retries resolve to one operation, session and prompt", async () => {
    const { backend, server } = harness()
    try {
      const first = await callTool(server, "opencode_start_session", {
        prompt: "implement X",
        requestID: "req-seq",
        wait: false,
      })
      const second = await callTool(server, "opencode_start_session", {
        prompt: "implement X",
        requestID: "req-seq",
        wait: false,
      })
      const a = payload(first)
      const b = payload(second)
      expect(a.sessionID).toStartWith("ses_")
      expect(b.sessionID).toBe(a.sessionID)
      expect(backend.createAttempts).toBe(1)
      expect(backend.promptCalls.length).toBe(1)
      expect(b.state).toBe("completed")
      expect("text" in b).toBe(false)
    } finally {
      server.stop()
    }
  })

  test("concurrent duplicate requests do not double-create or double-submit", async () => {
    const { backend, server } = harness()
    try {
      const [a, b] = await Promise.all([
        callTool(server, "opencode_start_session", { prompt: "race", requestID: "req-conc", wait: false }),
        callTool(server, "opencode_start_session", { prompt: "race", requestID: "req-conc", wait: false }),
      ])
      expect(backend.createAttempts).toBe(1)
      expect(backend.promptCalls.length).toBe(1)
      expect(payload(a).sessionID).toBe(payload(b).sessionID)
    } finally {
      server.stop()
    }
  })

  test("changed input under the same requestID conflicts", async () => {
    const { backend, server } = harness()
    try {
      await callTool(server, "opencode_start_session", { prompt: "one", requestID: "req-conflict", wait: false })
      const conflict = await callTool(server, "opencode_start_session", {
        prompt: "two",
        requestID: "req-conflict",
        wait: false,
      })
      expect(conflict.isError).toBe(true)
      expect(textOf(conflict)).toContain("already bound to a different input")
      expect(backend.createAttempts).toBe(1)
      expect(backend.promptCalls.length).toBe(1)
    } finally {
      server.stop()
    }
  })
})

describe("failure boundaries", () => {
  test("create failure records ambiguous delivery and never blind-recreates", async () => {
    const { backend, server } = harness()
    try {
      backend.failCreate = true
      const failed = payload(
        await callTool(server, "opencode_start_session", { prompt: "p", requestID: "req-fc", wait: false }),
      )
      expect(failed.state).toBe("unknown")
      expect(failed.delivery).toBe("unknown")
      expect(failed.sessionID).toBeNull()
      expect(backend.createAttempts).toBe(1)

      backend.failCreate = false
      const retry = payload(
        await callTool(server, "opencode_start_session", { prompt: "p", requestID: "req-fc", wait: false }),
      )
      expect(retry.state).toBe("unknown")
      expect(retry.delivery).toBe("unknown")
      expect(backend.createAttempts).toBe(1) // no recreate after unknown create
      expect(backend.promptCalls.length).toBe(0)
    } finally {
      server.stop()
    }
  })

  test("prompt submission failure records unknown delivery and never blind-resends", async () => {
    const { backend, server } = harness()
    try {
      backend.failPrompt = true
      const failed = payload(
        await callTool(server, "opencode_start_session", { prompt: "p", requestID: "req-fp", wait: false }),
      )
      expect(failed.sessionID).toStartWith("ses_")
      expect(failed.state).toBe("unknown")
      expect(failed.delivery).toBe("unknown")
      expect(backend.promptAttempts).toBe(1)

      backend.failPrompt = false
      const retry = payload(
        await callTool(server, "opencode_start_session", { prompt: "p", requestID: "req-fp", wait: false }),
      )
      expect(retry.state).toBe("unknown")
      expect(retry.sessionID).toBe(failed.sessionID)
      expect(backend.promptAttempts).toBe(1) // no blind resend
    } finally {
      server.stop()
    }
  })

  test("mapping write failure keeps the known session and resumes the prompt on retry", async () => {
    const { backend, server } = harness()
    try {
      // 1st operations write = intent, 2nd = post-create mapping.
      backend.storage.failSetAt = { prefix: "operations/", nth: 2 }
      const first = payload(
        await callTool(server, "opencode_start_session", { prompt: "p", requestID: "req-map", wait: false }),
      )
      expect(first.sessionID).toStartWith("ses_")
      expect(backend.createAttempts).toBe(1)
      expect(backend.promptCalls.length).toBe(0) // mapping unconfirmed -> no submit

      backend.storage.failSetAt = null
      const retry = payload(
        await callTool(server, "opencode_start_session", { prompt: "p", requestID: "req-map", wait: false }),
      )
      expect(retry.sessionID).toBe(first.sessionID)
      expect(backend.createAttempts).toBe(1) // no recreate
      expect(backend.promptCalls.length).toBe(1) // prompt resumed once mapping recorded
    } finally {
      server.stop()
    }
  })
})

describe("reload and owner transfer", () => {
  test("operation mapping survives a new plugin instance and completes the recorded turn", async () => {
    const backend = new Backend()
    backend.autoComplete = false
    const first = harness({ backend })
    const second = harness({ backend })
    try {
      const started = payload(
        await callTool(first.server, "opencode_start_session", { prompt: "long job", requestID: "req-reload", wait: false }),
      )
      expect(started.sessionID).toStartWith("ses_")
      first.server.stop() // owner unload

      const status = payload(
        await callTool(second.server, "opencode_status", {
          sessionID: started.sessionID,
          requestID: "req-reload",
        }),
      )
      expect(status.sessionID).toBe(started.sessionID)
      expect(status.status).toBe("running")

      backend.completeTurn(started.sessionID, "done after reload")
      const finished = payload(
        await callTool(second.server, "opencode_wait", {
          sessionID: started.sessionID,
          requestID: "req-reload",
          timeoutMs: 5_000,
        }),
      )
      expect(finished.state).toBe("completed")
      expect(finished.text).toBe("done after reload")
      expect(backend.createAttempts).toBe(1)
    } finally {
      first.server.stop()
      second.server.stop()
    }
  })

  test("unknown create outcome is not recreated after owner transfer", async () => {
    const backend = new Backend()
    backend.failCreate = true
    const first = harness({ backend })
    const second = harness({ backend })
    try {
      const failed = payload(
        await callTool(first.server, "opencode_start_session", { prompt: "p", requestID: "req-reload-unknown", wait: false }),
      )
      expect(failed.state).toBe("unknown")
      first.server.stop()

      backend.failCreate = false
      const retry = payload(
        await callTool(second.server, "opencode_start_session", { prompt: "p", requestID: "req-reload-unknown", wait: false }),
      )
      expect(retry.state).toBe("unknown")
      expect(backend.createAttempts).toBe(1)
    } finally {
      first.server.stop()
      second.server.stop()
    }
  })
})

describe("bounded waits and turn binding", () => {
  test("wait returns a stable handle with running state inside its budget without cancelling", async () => {
    const backend = new Backend()
    backend.autoComplete = false
    const { server } = harness({ backend })
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "stuck", requestID: "req-bound", wait: false }),
      )
      const begin = Date.now()
      const waiting = payload(
        await callTool(server, "opencode_wait", { sessionID: started.sessionID, requestID: "req-bound", timeoutMs: 250 }),
      )
      const elapsed = Date.now() - begin
      expect(elapsed).toBeLessThan(5_000)
      expect(waiting.sessionID).toBe(started.sessionID)
      expect(["running", "unknown"]).toContain(waiting.status)
      expect(backend.interruptCalls.length).toBe(0) // expiry never cancels the worker
    } finally {
      server.stop()
    }
  })

  test("a previous assistant answer and stale idle cannot satisfy a new operation", async () => {
    const backend = new Backend()
    const seed = backend.seedSession({ title: "attached" })
    backend.completeTurn(seed.id, "OLD ANSWER")
    backend.autoComplete = false
    const { server } = harness({ backend })
    try {
      const waiting = payload(
        await callTool(server, "opencode_start_session", {
          prompt: "new task",
          sessionID: seed.id,
          requestID: "req-stale",
          wait: true,
          timeoutMs: 300,
        }),
      )
      expect(waiting.sessionID).toBe(seed.id)
      expect(["running", "unknown"]).toContain(waiting.status)
      expect(waiting.text ?? "").not.toContain("OLD ANSWER")

      backend.completeTurn(seed.id, "NEW ANSWER")
      const finished = payload(
        await callTool(server, "opencode_wait", { sessionID: seed.id, requestID: "req-stale", timeoutMs: 5_000 }),
      )
      expect(finished.state).toBe("completed")
      expect(finished.text).toBe("NEW ANSWER")
    } finally {
      server.stop()
    }
  })
})

describe("compact state and bounded output", () => {
  test("status is compact (no transcript) while result is bounded and reports unchanged output", async () => {
    const { backend, server } = harness()
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "produce", requestID: "req-out", wait: true }),
      )
      expect(started.state).toBe("completed")
      expect(started.text).toBe("assistant-output")

      const status = payload(
        await callTool(server, "opencode_status", {
          sessionID: started.sessionID,
          requestID: "req-out",
          reconcile: false,
        }),
      )
      expect(status.state).toBe("completed")
      expect(status.session.title).toBeString()
      expect("text" in status).toBe(false)

      const first = payload(
        await callTool(server, "opencode_result", { sessionID: started.sessionID, requestID: "req-out", maxChars: 10_000 }),
      )
      expect(first.unchanged).toBe(false)
      expect(first.text).toBe("assistant-output")

      const second = payload(
        await callTool(server, "opencode_result", { sessionID: started.sessionID, requestID: "req-out", maxChars: 10_000 }),
      )
      expect(second.unchanged).toBe(true)
      expect("text" in second).toBe(false)

      const forced = payload(
        await callTool(server, "opencode_result", {
          sessionID: started.sessionID,
          requestID: "req-out",
          force: true,
          maxChars: 10_000,
        }),
      )
      expect(forced.unchanged).toBe(false)
      expect(forced.text).toBe("assistant-output")

      const truncated = payload(
        await callTool(server, "opencode_result", {
          sessionID: started.sessionID,
          requestID: "req-out",
          force: true,
          maxChars: 4,
        }),
      )
      expect(truncated.truncated).toBe(true)
      expect(truncated.text.length).toBeLessThanOrEqual(4)
      expect(backend.createAttempts).toBe(1)
    } finally {
      server.stop()
    }
  })
})

describe("legacy callers (no requestID)", () => {
  test("start without requestID keeps default model, unattended ruleset and session registry", async () => {
    const { backend, server } = harness()
    try {
      const started = payload(await callTool(server, "opencode_start_session", { prompt: "legacy" }))
      expect(started.status).toBe("started")
      expect(started.sessionID).toStartWith("ses_")
      const create = backend.createCalls[0]
      expect(create.model).toEqual({ providerID: "opencode-go", id: "deepseek-v4.1-flash" })
      const ruleset = create.permissions as Array<{ action: string; resource: string; effect: string }>
      expect(ruleset).toContainEqual({ action: "shell", resource: "git push*", effect: "deny" })
      const registered: any = await backend.storage.get(`sessions/${started.sessionID}`)
      expect(registered.sessionID).toBe(started.sessionID)
    } finally {
      server.stop()
    }
  })

  test("attach to an existing session reuses it and does not create", async () => {
    const { backend, server } = harness()
    try {
      const existing = backend.seedSession({ title: "existing" })
      const attached = payload(
        await callTool(server, "opencode_start_session", { prompt: "follow up", sessionID: existing.id }),
      )
      expect(attached.sessionID).toBe(existing.id)
      expect(attached.status).toBe("queued")
      expect(backend.createAttempts).toBe(0)
      expect(backend.promptCalls.at(-1)?.sessionID).toBe(existing.id)
    } finally {
      server.stop()
    }
  })

  test("model and directory overrides are honored; inheritPermissions drops the ruleset", async () => {
    const { backend, server } = harness({ pluginOptions: { inheritPermissions: true } })
    try {
      await callTool(server, "opencode_start_session", {
        prompt: "custom",
        model: "other/model-x",
        directory: "/custom/dir",
      })
      const create = backend.createCalls[0]
      expect(create.model).toEqual({ providerID: "other", id: "model-x" })
      expect(create.location).toEqual({ directory: "/custom/dir" })
      expect("permissions" in create).toBe(false)
    } finally {
      server.stop()
    }
  })
})

describe("generated operation sequences", () => {
  test("create and prompt counts match the number of distinct requestIDs", async () => {
    let seed = 123456789
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const pool = ["a", "b", "c", "d", "e", "f"]
    const requests: string[] = []
    for (let i = 0; i < 40; i++) requests.push(`req-gen-${pool[Math.floor(next() * pool.length)]}`)

    const { backend, server } = harness()
    try {
      const byRequest = new Map<string, string>()
      for (const requestID of requests) {
        const result = payload(
          await callTool(server, "opencode_start_session", {
            prompt: `task ${requestID}`,
            requestID,
            wait: false,
          }),
        )
        const previous = byRequest.get(requestID)
        if (previous) expect(result.sessionID).toBe(previous)
        else byRequest.set(requestID, result.sessionID)
      }
      const distinct = new Set(requests).size
      expect(backend.createAttempts).toBe(distinct)
      expect(backend.promptCalls.length).toBe(distinct)
      expect(byRequest.size).toBe(distinct)
    } finally {
      server.stop()
    }
  })
})

describe("needsInput attention reporting", () => {
  test("a pending permission request reports needsInput and wait returns early, then resumes", async () => {
    const backend = new Backend()
    backend.autoComplete = false
    const { server } = harness({ backend })
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "needs approval", requestID: "req-attn", wait: false }),
      )
      const requests = [{ id: "perm_1", action: "shell", resources: ["npm install"], message: "approve shell" }]
      backend.permissions.set(started.sessionID, requests)

      const status = payload(
        await callTool(server, "opencode_status", { sessionID: started.sessionID, requestID: "req-attn" }),
      )
      expect(status.status).toBe("running")
      expect(status.needsInput.kind).toBe("permission")
      expect(status.needsInput.requests).toEqual(requests)
      expect(status.needsInput.forms).toEqual([])

      const begin = Date.now()
      const stalled = payload(
        await callTool(server, "opencode_wait", {
          sessionID: started.sessionID,
          requestID: "req-attn",
          timeoutMs: 5_000,
        }),
      )
      const elapsed = Date.now() - begin
      expect(elapsed).toBeLessThan(1_000)
      expect(stalled.status).toBe("running")
      expect(stalled.state).not.toBe("completed")
      expect(stalled.needsInput.kind).toBe("permission")
      expect(stalled.waitResult).toBe("needs-input")
      expect(stalled.timedOut).toBe(false)
      expect(backend.interruptCalls.length).toBe(0) // attention never cancels the run

      // Answering in the TUI clears the queue; the same recorded operation resumes.
      backend.permissions.delete(started.sessionID)
      backend.completeTurn(started.sessionID, "approved and done")
      const resumed = payload(
        await callTool(server, "opencode_wait", {
          sessionID: started.sessionID,
          requestID: "req-attn",
          timeoutMs: 5_000,
        }),
      )
      expect(resumed.state).toBe("completed")
      expect(resumed.text).toBe("approved and done")
    } finally {
      server.stop()
    }
  })

  test("a permission request whose action is question is classified as a question", async () => {
    const backend = new Backend()
    backend.autoComplete = false
    const { server } = harness({ backend })
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "ask", requestID: "req-qperm", wait: false }),
      )
      backend.permissions.set(started.sessionID, [
        { id: "perm_q", action: "question", resources: null, message: "which option?" },
      ])
      const status = payload(
        await callTool(server, "opencode_status", { sessionID: started.sessionID, requestID: "req-qperm" }),
      )
      expect(status.needsInput.kind).toBe("question")
      expect(status.needsInput.requests).toEqual([
        { id: "perm_q", action: "question", resources: null, message: "which option?" },
      ])
      expect(status.needsInput.forms).toEqual([])
    } finally {
      server.stop()
    }
  })

  test("a pending question form is the primary question signal", async () => {
    const backend = new Backend()
    backend.autoComplete = false
    const { server } = harness({ backend })
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "choose", requestID: "req-form", wait: false }),
      )
      backend.forms.set(started.sessionID, [{ id: "form_1", title: "Which option?" }])

      const status = payload(await callTool(server, "opencode_status", { sessionID: started.sessionID }))
      expect(status.needsInput.kind).toBe("question")
      expect(status.needsInput.forms).toEqual([{ id: "form_1", title: "Which option?" }])
      expect(status.needsInput.requests).toEqual([])

      const stalled = payload(
        await callTool(server, "opencode_wait", {
          sessionID: started.sessionID,
          requestID: "req-form",
          timeoutMs: 5_000,
        }),
      )
      expect(stalled.needsInput.kind).toBe("question")
      expect(stalled.waitResult).toBe("needs-input")
    } finally {
      server.stop()
    }
  })

  test("unreadable probes report needsInput null instead of claiming the session needs no input", async () => {
    const backend = new Backend()
    backend.autoComplete = false
    const { server } = harness({ backend })
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "probe", requestID: "req-unknown", wait: false }),
      )

      backend.failPermissionProbe = true
      const partial = payload(
        await callTool(server, "opencode_status", { sessionID: started.sessionID, requestID: "req-unknown" }),
      )
      expect(partial.needsInput).toBeNull()
      expect(partial.status).toBe("running")

      backend.failFormProbe = true
      const unknown = payload(
        await callTool(server, "opencode_result", { sessionID: started.sessionID, requestID: "req-unknown" }),
      )
      expect(unknown.needsInput).toBeNull()
      expect(unknown.state).not.toBe("completed")
    } finally {
      server.stop()
    }
  })

  test("a quiet session reports needsInput null", async () => {
    const backend = new Backend()
    const { server } = harness({ backend })
    try {
      const started = payload(
        await callTool(server, "opencode_start_session", { prompt: "quiet", requestID: "req-quiet", wait: true }),
      )
      expect(started.state).toBe("completed")
      const status = payload(await callTool(server, "opencode_status", { sessionID: started.sessionID }))
      expect(status.needsInput).toBeNull()
    } finally {
      server.stop()
    }
  })
})
