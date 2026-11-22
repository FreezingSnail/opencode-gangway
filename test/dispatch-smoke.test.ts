import { expect, test } from "bun:test"
import { startMcpServer } from "../src/mcp"
import type { Ctx } from "../src/tools"
import { registerDispatchRpc, type DispatchRpcRegistrar } from "../src/dispatch-rpc"
import type { DispatchStorage } from "../src/dispatch-records"
import { loadDispatchInspection, type DispatchRpcClient } from "../src/tui-dispatch"

// Service/TUI smoke test on an ephemeral (custom) port and a different project
// directory. The fake host mirrors the promise-plugin contract: the server-side
// registrar and the TUI-side client share the service storage object. No session
// method is reachable, so any accidental dispatch/reconcile/prompt read fails.

class MemoryStorage implements DispatchStorage {
  readonly map = new Map<string, unknown>()
  writes = 0

  async set(key: string, value: unknown): Promise<void> {
    this.writes += 1
    this.map.set(key, value)
  }

  async get(key: string): Promise<unknown> {
    return this.map.has(key) ? JSON.parse(JSON.stringify(this.map.get(key))) : null
  }

  async scan(input: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>
    next?: string
  }> {
    const keys = [...this.map.keys()].filter((key) => key.startsWith(input.prefix)).sort()
    const start = input.after ? keys.indexOf(input.after) + 1 : 0
    const page = keys.slice(start, start + (input.limit ?? 100))
    const next = start + page.length < keys.length ? page.at(-1) : undefined
    return {
      entries: page.map((key) => ({ key, value: JSON.parse(JSON.stringify(this.map.get(key))) })),
      ...(next ? { next } : {}),
    }
  }
}

test("custom-port service and TUI share records across project directories without writes", async () => {
  const storage = new MemoryStorage()
  storage.map.set("operations/a", {
    requestID: "req-start",
    kind: "start",
    sessionID: "ses_target",
    state: "submitted",
    delivery: "recorded",
    submittedAt: 1_100,
    createdAt: 1_000,
    updatedAt: 1_100,
    error: null,
  })
  storage.map.set("operations/b", {
    requestID: "req-follow",
    kind: "prompt",
    sessionID: "ses_target",
    state: "unknown",
    delivery: "unknown",
    submittedAt: 2_100,
    createdAt: 2_000,
    updatedAt: 2_100,
    error: "upstream uncertain",
  })

  let sessionCalls = 0
  const fail = async (): Promise<never> => {
    sessionCalls += 1
    throw new Error("session access is forbidden for dispatch inspection")
  }
  const ctx = {
    location: { directory: "/project-a" },
    session: { create: fail, get: fail, context: fail, prompt: fail, interrupt: fail, wait: fail },
    storage,
  } as unknown as Ctx

  const server = startMcpServer({ port: 0, ctx })
  try {
    const ping = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    })
    expect(ping.ok).toBe(true)
    expect(server.port).toBeGreaterThan(0)

    let registered: { definition: unknown; handlers: Record<string, any> } | undefined
    const registrar: DispatchRpcRegistrar = {
      async register(definition, handlers) {
        registered = { definition, handlers }
        return { dispose: async () => {} }
      },
    }
    await registerDispatchRpc(registrar, storage)

    const client: DispatchRpcClient = {
      rpc(definition) {
        expect(definition).toBe(registered!.definition)
        return {
          inspectDispatch: (input, options) => {
            expect(options?.location).toEqual({ directory: "/project-b" })
            return registered!.handlers.inspectDispatch(input, {})
          },
        }
      },
    }

    const view = await loadDispatchInspection(client, { sessionID: "ses_target" }, {
      directory: "/project-b",
    })
    expect(view.state).toBe("ready")
    if (view.state === "ready") {
      expect(view.inspection.operation?.requestID).toBe("req-follow")
      expect(view.inspection.operation?.delivery).toBe("unknown")
    }
    expect(sessionCalls).toBe(0)
    expect(storage.writes).toBe(0)
  } finally {
    server.stop()
  }
})
