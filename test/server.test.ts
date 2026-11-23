import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMcpServer, type ResolvedContext } from "../src/mcp"
import type { Ctx } from "../src/tools"

// Multi-instance safety: OpenCode loads the plugin once per location, but only one
// instance can own the port; the others must fail fast so the plugin can skip.
describe("mcp server lifecycle", () => {
  test("bind collision throws and stop releases the port", () => {
    const first = startMcpServer({ port: 0 })
    try {
      expect(() => startMcpServer({ port: first.port })).toThrow()
    } finally {
      first.stop()
    }
  })
})

describe("per-request context resolution", () => {
  test("ping and tools stay available when context resolution fails", async () => {
    let resolutions = 0
    const server = startMcpServer({
      port: 0,
      context: () => {
        resolutions += 1
        throw new Error("location evicted")
      },
    })
    async function rpc(method: string, params?: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      })
      return (await response.json()) as any
    }
    try {
      const ping = await rpc("tools/call", { name: "opencode_ping", arguments: {} })
      expect(JSON.parse(ping.result.content[0].text).pong).toBe(true)

      const list = await rpc("tools/list")
      const names = (list.result.tools as Array<{ name: string }>).map((tool) => tool.name)
      expect(names).toContain("opencode_start_session")
      expect(names).toContain("opencode_status")
      // Ping/tools-list must not boot or probe a location.
      expect(resolutions).toBe(0)

      const status = await rpc("tools/call", {
        name: "opencode_status",
        arguments: { sessionID: "ses_missing" },
      })
      expect(status.result.isError).toBe(true)
      expect(status.result.content[0].text).toContain("OpenCode context unavailable")
      // One eager attempt for the request plus one lazy retry in the tool.
      expect(resolutions).toBe(2)
    } finally {
      server.stop()
    }
  })

  test("directory hints tolerate JSON-RPC batches and malformed bodies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gangway-batch-"))
    const seen: Array<string | undefined> = []
    const server = startMcpServer({
      port: 0,
      context: (request) => {
        seen.push(request?.directory)
        return undefined
      },
    })
    async function post(body: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body,
      })
    }
    try {
      await post(JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "opencode_ping", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "opencode_start_session",
            arguments: { prompt: "batched", directory },
          },
        },
      ]))
      // The pre-build parse found the batch's start-session directory. The lazy
      // facade may ask again when the batched tool call executes.
      expect(seen[0]).toBe(directory)
      expect(seen.every((value) => value === directory)).toBe(true)

      seen.length = 0
      await post(JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "opencode_delivery",
          arguments: { requestID: "existing-operation", action: "inspect", directory },
        },
      }))
      expect(seen[0]).toBe(directory)
      expect(seen.every((value) => value === directory)).toBe(true)

      seen.length = 0
      await post("{not-json")
      expect(seen).toEqual([])

      const ping = await post(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "opencode_ping", arguments: {} },
      }))
      const body: any = await ping.json()
      expect(JSON.parse(body.result.content[0].text).pong).toBe(true)
      expect(seen).toEqual([])
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a resolver with no current context still serves tools and resolves lazily", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gangway-lazy-"))
    const seen: Array<string | undefined> = []
    const sessions = new Map<string, { title: string; messages: any[] }>()
    let created = 0
    const ctx = {
      location: { directory },
      session: {
        create: async (input: Record<string, unknown>) => {
          const id = `ses_lazy_${++created}`
          sessions.set(id, { title: String(input.title ?? "lazy"), messages: [] })
          return { id }
        },
        get: async ({ sessionID }: { sessionID: string }) => ({
          title: sessions.get(sessionID)?.title ?? "lazy",
          time: { updated: 0, idle: null },
        }),
        context: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID)?.messages ?? [],
        prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
          const found = sessions.get(sessionID)
          if (!found) throw new Error("missing session")
          found.messages.push({ type: "user", text })
          found.messages.push({ type: "idle", outcome: "succeeded" })
          return {}
        },
        interrupt: async () => ({}),
        wait: async () => ({}),
      },
      storage: {
        set: async () => {},
        get: async () => null,
        scan: async () => ({ entries: [] }),
      },
    } as Ctx

    const server = startMcpServer({
      port: 0,
      // The first call (while building the per-request server) has no context.
      // The tool call retries lazily through the facade and resolves.
      context: (request): ResolvedContext | undefined => {
        seen.push(request?.directory)
        return seen.length === 1 ? undefined : { ctx, pluginOptions: {} }
      },
      knownDirectory: () => directory,
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "opencode_start_session",
            arguments: { prompt: "lazy dispatch", directory },
          },
        }),
      })
      const body: any = await response.json()
      expect(body.result.isError).not.toBe(true)
      const result = JSON.parse(body.result.content[0].text)
      expect(result.sessionID).toStartWith("ses_lazy_")
      expect(result.status).toBe("started")
      // The directory parsed from the JSON-RPC body reaches both resolver calls.
      expect(seen).toEqual([directory, directory])
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
