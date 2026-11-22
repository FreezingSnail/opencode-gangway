import { describe, expect, test } from "bun:test"
import {
  DISPATCH_RPC,
  createDispatchHandlers,
  parseDispatchInspection,
  registerDispatchRpc,
  type DispatchRpcRegistrar,
} from "../src/dispatch-rpc"
import type { DispatchStorage } from "../src/dispatch-records"

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

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestID: "req-start",
    kind: "start",
    identity: { prompt: "SECRET PROMPT", directory: "/secret" },
    identityHash: "hash",
    state: "submitted",
    sessionID: "ses_target",
    submittedAt: 1_100,
    submittedMessageID: "msg_secret",
    delivery: "recorded",
    createdAt: 1_000,
    updatedAt: 1_100,
    completion: { text: "SECRET COMPLETION" },
    error: null,
    ...overrides,
  }
}

interface Host {
  registrar: DispatchRpcRegistrar
  client: { rpc(definition: unknown): { inspectDispatch(input: unknown, options?: unknown): Promise<unknown> } }
  calls: Array<{ input: unknown; options?: unknown }>
  definition(): unknown
  disposed: number
}

// Minimal deterministic host fixture. It mirrors the documented promise-plugin
// contract: register(definition, handlers), then call the same portable
// definition through the client with the selected location option. Storage is
// the service-owned object, not a per-TUI copy.
function fakeHost(storage: DispatchStorage): Host {
  let registered: { definition: unknown; handlers: Record<string, any> } | undefined
  let disposed = 0
  const calls: Array<{ input: unknown; options?: unknown }> = []

  const registrar: DispatchRpcRegistrar = {
    async register(definition, handlers) {
      registered = { definition, handlers }
      return {
        dispose: async () => {
          disposed += 1
        },
      }
    },
  }

  const client = {
    rpc(definition: unknown) {
      if (!registered || registered.definition !== definition) {
        throw new Error("rpc.unavailable: plugin RPC is not registered")
      }
      return {
        async inspectDispatch(input: unknown, options?: unknown) {
          calls.push({ input, options })
          return registered!.handlers.inspectDispatch(input, { signal: new AbortController().signal })
        },
      }
    },
  }

  return {
    registrar,
    client,
    calls,
    definition: () => registered?.definition,
    get disposed() {
      return disposed
    },
  }
}

describe("dispatch RPC registration", () => {
  test("registers the compact definition and serves the selected session's records", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/a", operation())
    storage.map.set(
      "operations/b",
      operation({ requestID: "req-follow", kind: "prompt", createdAt: 2_000, updatedAt: 2_100 }),
    )
    storage.map.set("operations/c", operation({ requestID: "req-foreign", sessionID: "ses_other" }))
    const host = fakeHost(storage)

    const registration = await registerDispatchRpc(host.registrar, storage)
    expect(registration).toBeDefined()
    expect(host.definition()).toBe(DISPATCH_RPC)
    expect(DISPATCH_RPC.id).toBe("gangway")
    expect(Object.keys(DISPATCH_RPC.methods)).toEqual(["inspectDispatch"])

    const result = (await host.client.rpc(DISPATCH_RPC).inspectDispatch(
      { sessionID: "ses_target" },
      { location: { directory: "/different/project" } },
    )) as any

    expect(result).toMatchObject({
      sessionID: "ses_target",
      coverage: "complete",
      reason: "recorded",
      operation: { requestID: "req-follow", kind: "follow-up" },
    })
    expect(host.calls).toEqual([
      { input: { sessionID: "ses_target" }, options: { location: { directory: "/different/project" } } },
    ])
    expect(storage.writes).toBe(0)

    await registration!.dispose()
    expect(host.disposed).toBe(1)
  })

  test("response is allowlisted and contains no raw prompt, identity or completion", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/a", operation())
    const host = fakeHost(storage)
    await registerDispatchRpc(host.registrar, storage)

    const result = (await host.client.rpc(DISPATCH_RPC).inspectDispatch({ sessionID: "ses_target" })) as any
    expect(Object.keys(result).sort()).toEqual(["coverage", "operation", "reason", "sessionID"])
    expect(Object.keys(result.operation).sort()).toEqual(
      [
        "createdAt",
        "delivery",
        "error",
        "kind",
        "requestID",
        "state",
        "status",
        "submittedAt",
        "updatedAt",
        "warning",
      ].sort(),
    )
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("msg_secret")
    expect(JSON.stringify(result)).not.toContain("identityHash")
  })

  test("foreign sessions and invalid input never leak into the response", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/a", operation({ requestID: "req-foreign", sessionID: "ses_other" }))
    const host = fakeHost(storage)
    await registerDispatchRpc(host.registrar, storage)

    const foreign = (await host.client.rpc(DISPATCH_RPC).inspectDispatch({ sessionID: "ses_target" })) as any
    expect(foreign.operation).toBeNull()
    expect(JSON.stringify(foreign)).not.toContain("req-foreign")

    await expect(host.client.rpc(DISPATCH_RPC).inspectDispatch({ sessionID: "" })).rejects.toThrow(
      "valid sessionID",
    )
    await expect(host.client.rpc(DISPATCH_RPC).inspectDispatch({})).rejects.toThrow("valid sessionID")
  })

  test("an older host without plugin RPC is left unchanged", async () => {
    await expect(registerDispatchRpc(undefined, new MemoryStorage())).resolves.toBeUndefined()
    await expect(
      registerDispatchRpc({} as DispatchRpcRegistrar, new MemoryStorage()),
    ).resolves.toBeUndefined()
  })

  test("missing storage fails registration instead of claiming records exist", async () => {
    const host = fakeHost(new MemoryStorage())
    await expect(registerDispatchRpc(host.registrar, undefined)).rejects.toThrow("storage is unavailable")
  })

  test("handlers can be used directly by a fixture without a transport", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/a", operation())
    const handlers = createDispatchHandlers(storage)
    const result = await handlers.inspectDispatch({ sessionID: "ses_target" }, {})
    expect(result.operation?.requestID).toBe("req-start")
  })
})

describe("parseDispatchInspection", () => {
  test("drops unknown fields from an untrusted response", () => {
    const parsed = parseDispatchInspection({
      sessionID: "ses_target",
      coverage: "complete",
      reason: "recorded",
      operation: {
        ...operation(),
        status: "running",
        transcript: "SECRET",
        warning: "ok",
      },
    })
    expect(Object.keys(parsed).sort()).toEqual(["coverage", "operation", "reason", "sessionID"])
    expect(Object.keys(parsed.operation!).sort()).toEqual(
      [
        "createdAt",
        "delivery",
        "error",
        "kind",
        "requestID",
        "state",
        "status",
        "submittedAt",
        "updatedAt",
        "warning",
      ].sort(),
    )
    expect(JSON.stringify(parsed)).not.toContain("SECRET")
  })

  test("rejects malformed or out-of-enum responses", () => {
    expect(() =>
      parseDispatchInspection({ sessionID: "ses_target", coverage: "huge", reason: "none", operation: null }),
    ).toThrow("coverage")
    expect(() =>
      parseDispatchInspection({
        sessionID: "ses_target",
        coverage: "complete",
        reason: "none",
        operation: { requestID: "r", kind: "start", state: "made-up", status: "pending", delivery: "recorded", submittedAt: null, createdAt: null, updatedAt: null, error: null, warning: null },
      }),
    ).toThrow("state")
  })
})
