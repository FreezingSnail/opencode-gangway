import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireEndpoint, ensureLocationViaService, shutdownEndpoints } from "../src/lifecycle"
import { startMcpServer } from "../src/mcp"
import type { Ctx } from "../src/tools"

// Deterministic offline lifecycle tests: no real OpenCode service, no provider.
// Endpoints are process-lifetime now, so every case calls shutdownEndpoints in
// finally to release listeners and the shared recent-directory state.

interface EndpointInfo {
  url: string
  port: number
  pid: number
}

function context(title: string, directory?: string): Ctx {
  const sessions = new Map<string, { title: string; messages: any[] }>()
  let created = 0
  function session(sessionID: string) {
    let existing = sessions.get(sessionID)
    if (!existing) {
      existing = {
        title,
        messages: [
          {
            type: "assistant",
            id: `msg_${sessionID}`,
            content: [{ type: "text", text: `${title}-output` }],
            time: { created: 1, completed: 1 },
          },
          { type: "idle", outcome: "succeeded" },
        ],
      }
      sessions.set(sessionID, existing)
    }
    return existing
  }
  return {
    ...(directory ? { location: { directory } } : {}),
    session: {
      create: async (input: Record<string, unknown>) => {
        const id = `ses_${title}_${++created}`
        sessions.set(id, { title: String(input.title ?? title), messages: [] })
        return { id }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        title: session(sessionID).title,
        time: { updated: 0, idle: null },
      }),
      context: async ({ sessionID }: { sessionID: string }) => session(sessionID).messages,
      prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        const found = session(sessionID)
        found.messages.push({ type: "user", text })
        found.messages.push({
          type: "assistant",
          id: `msg_${sessionID}_reply`,
          content: [{ type: "text", text: `${title}-output` }],
          time: { created: 2, completed: 2 },
        })
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
}

function infoAt(rendezvous: string): EndpointInfo {
  return JSON.parse(readFileSync(rendezvous, "utf8")) as EndpointInfo
}

async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const body: any = await response.json()
  return body.result
}

function textOf(result: any): string {
  return ((result?.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
}

function payload(result: any): any {
  return JSON.parse(textOf(result))
}

async function statusTitle(url: string, directory?: string): Promise<string> {
  const result = await callTool(url, "opencode_status", {
    sessionID: "ses_example",
    ...(directory ? { directory } : {}),
  })
  expect(result.isError).not.toBe(true)
  return payload(result).title
}

test("status directory hint selects and reacquires the exact location", async () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-status-location-"))
  const firstDirectory = join(root, "first")
  const requestedDirectory = join(root, "requested")
  const rendezvous = join(root, "endpoint.json")
  mkdirSync(firstDirectory)
  mkdirSync(requestedDirectory)
  let info: EndpointInfo | undefined
  let first: (() => void) | undefined
  let requested: (() => void) | undefined
  let revived: (() => void) | undefined
  const ensureCalls: string[] = []
  const ensure = async (directory: string) => {
    ensureCalls.push(directory)
    revived ??= acquireEndpoint({
      port: info!.port,
      rendezvous,
      ctx: context("requested-revived", requestedDirectory),
      pluginOptions: {},
      ensureLocation: ensure,
    })
  }
  try {
    first = acquireEndpoint({
      port: 0,
      rendezvous,
      ctx: context("first", firstDirectory),
      pluginOptions: {},
      ensureLocation: ensure,
    })
    info = infoAt(rendezvous)
    requested = acquireEndpoint({
      port: info.port,
      rendezvous,
      ctx: context("requested", requestedDirectory),
      pluginOptions: {},
      ensureLocation: ensure,
    })

    expect(await statusTitle(info.url, requestedDirectory)).toBe("requested")
    requested()
    requested = undefined
    expect(await statusTitle(info.url, requestedDirectory)).toBe("requested-revived")
    expect(ensureCalls).toEqual([requestedDirectory])
  } finally {
    first?.()
    requested?.()
    revived?.()
    shutdownEndpoints()
    rmSync(root, { recursive: true, force: true })
  }
})

test("final owner unload keeps the endpoint and reacquires a live context", async () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-lifecycle-"))
  const project = join(root, "project")
  const rendezvous = join(root, "endpoint.json")
  mkdirSync(project)
  let info: EndpointInfo | undefined
  let first: (() => void) | undefined
  let second: (() => void) | undefined
  let revived: (() => void) | undefined
  const ensureCalls: string[] = []
  const ensure = async (directory: string) => {
    ensureCalls.push(directory)
    revived ??= acquireEndpoint({
      port: info!.port,
      rendezvous,
      ctx: context("revived", project),
      pluginOptions: {},
      ensureLocation: ensure,
    })
  }
  try {
    first = acquireEndpoint({
      port: 0,
      rendezvous,
      ctx: context("first", project),
      pluginOptions: {},
      ensureLocation: ensure,
    })
    info = infoAt(rendezvous)
    const modified = statSync(rendezvous).mtimeMs
    second = acquireEndpoint({
      port: info.port,
      rendezvous,
      ctx: context("second", project),
      pluginOptions: {},
      ensureLocation: ensure,
    })
    expect(statSync(rendezvous).mtimeMs).toBe(modified)

    // Multi-owner handover: first live instance wins, then the survivor.
    expect(await statusTitle(info.url)).toBe("first")
    first()
    expect(existsSync(rendezvous)).toBe(true)
    expect(await statusTitle(info.url)).toBe("second")
    first() // Repeated cleanup must not remove another owner's lease.
    expect(await statusTitle(info.url)).toBe("second")

    // Final owner unload keeps the listener and rendezvous. A later request
    // picks the most recent known directory and reacquires through the hook.
    second()
    second()
    expect(existsSync(rendezvous)).toBe(true)
    const pong = payload(await callTool(info.url, "opencode_ping", {}))
    expect(pong.pong).toBe(true)
    // Health checks must not boot an idle location.
    expect(ensureCalls).toEqual([])
    expect(await statusTitle(info.url)).toBe("revived")
    expect(ensureCalls).toEqual([project])
  } finally {
    first?.()
    second?.()
    revived?.()
    shutdownEndpoints()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a deleted directory is rejected without calling ensureLocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-deleted-"))
  const project = join(root, "project")
  const rendezvous = join(root, "endpoint.json")
  mkdirSync(project)
  let release: (() => void) | undefined
  let ensureCalls = 0
  try {
    release = acquireEndpoint({
      port: 0,
      rendezvous,
      ctx: context("owner", project),
      pluginOptions: {},
      ensureLocation: async () => {
        ensureCalls += 1
      },
    })
    const info = infoAt(rendezvous)
    rmSync(project, { recursive: true, force: true })

    // The still-leased owner points at a removed worktree: it must not be reused
    // or reacquired, even though the live instance map still holds it.
    const live = await callTool(info.url, "opencode_status", { sessionID: "ses_example" })
    expect(live.isError).toBe(true)
    expect(textOf(live)).toContain("OpenCode context unavailable")
    expect(ensureCalls).toBe(0)

    // An explicit deleted target is rejected even while another live context
    // exists; it must not silently fall back to that context.
    const targeted = await callTool(info.url, "opencode_start_session", {
      prompt: "task in a deleted worktree",
      directory: project,
    })
    expect(targeted.isError).toBe(true)
    expect(textOf(targeted)).toContain("does not exist")
    expect(ensureCalls).toBe(0)

    release()
    const result = await callTool(info.url, "opencode_start_session", {
      prompt: "task in a deleted worktree",
      directory: project,
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("does not exist")
    expect(ensureCalls).toBe(0)

    // The endpoint remains healthy after refusing the deleted location.
    expect(payload(await callTool(info.url, "opencode_ping", {})).pong).toBe(true)
  } finally {
    release?.()
    shutdownEndpoints()
    rmSync(root, { recursive: true, force: true })
  }
})

test("reload on the same port reuses the listener; shutdown removes it and frees the port", async () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-reload-"))
  const project = join(root, "project")
  const rendezvous = join(root, "endpoint.json")
  mkdirSync(project)
  let first: (() => void) | undefined
  let second: (() => void) | undefined
  let rebound: ReturnType<typeof startMcpServer> | undefined
  try {
    first = acquireEndpoint({
      port: 0,
      rendezvous,
      ctx: context("first", project),
      pluginOptions: {},
      ensureLocation: async () => {},
    })
    const info = infoAt(rendezvous)
    second = acquireEndpoint({
      port: info.port,
      rendezvous,
      ctx: context("second", project),
      pluginOptions: {},
      ensureLocation: async () => {},
    })
    // A second listener would collide; successful attach proves reuse.
    expect(() => startMcpServer({ port: info.port })).toThrow()
    first()
    expect(await statusTitle(info.url)).toBe("second")
    second()

    shutdownEndpoints()
    expect(existsSync(rendezvous)).toBe(false)
    shutdownEndpoints() // Idempotent.
    rebound = startMcpServer({ port: info.port })
    expect(rebound.port).toBe(info.port)
  } finally {
    rebound?.stop()
    first?.()
    second?.()
    shutdownEndpoints()
    rmSync(root, { recursive: true, force: true })
  }
})

test("external port collisions are reported as setup failures", () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-collision-"))
  const rendezvous = join(root, "endpoint.json")
  const server = startMcpServer({ port: 0 })
  try {
    expect(() => acquireEndpoint({
      port: server.port,
      rendezvous,
      ctx: context("blocked"),
      pluginOptions: {},
    })).toThrow()
    expect(existsSync(rendezvous)).toBe(false)
  } finally {
    server.stop()
    shutdownEndpoints()
    rmSync(root, { recursive: true, force: true })
  }
})

test("ensureLocationViaService verifies pid and calls the location API", async () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-service-"))
  const state = join(root, "state")
  const service = join(state, "opencode", "service.json")
  mkdirSync(join(state, "opencode"), { recursive: true })
  const previous = process.env.XDG_STATE_HOME
  const calls: Array<{ url: string; authorization: string | null }> = []
  let status = 200
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      calls.push({ url: request.url, authorization: request.headers.get("authorization") })
      if (url.pathname !== "/api/location") return new Response("not found", { status: 404 })
      return new Response("{}", { status, headers: { "content-type": "application/json" } })
    },
  })
  try {
    process.env.XDG_STATE_HOME = state
    const base = `http://127.0.0.1:${target.port}`
    writeFileSync(service, JSON.stringify({ url: base, pid: process.pid, password: "local-secret" }))
    const directory = join(root, "project with spaces")
    mkdirSync(directory)

    await ensureLocationViaService(directory)
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(
      `${base}/api/location?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    )
    const expectedAuth = `Basic ${Buffer.from("opencode:local-secret").toString("base64")}`
    expect(calls[0].authorization).toBe(expectedAuth)

    status = 503
    await expect(ensureLocationViaService(directory)).rejects.toThrow("HTTP 503")
  } finally {
    target.stop(true)
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("ensureLocationViaService refuses missing or foreign service metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "gangway-service-missing-"))
  const state = join(root, "state")
  const service = join(state, "opencode", "service.json")
  mkdirSync(join(state, "opencode"), { recursive: true })
  const previous = process.env.XDG_STATE_HOME
  try {
    process.env.XDG_STATE_HOME = state
    await expect(ensureLocationViaService(root)).rejects.toThrow("cannot read OpenCode service info")

    writeFileSync(service, JSON.stringify({
      url: "http://127.0.0.1:1",
      pid: process.pid + 1,
      password: "wrong-process",
    }))
    await expect(ensureLocationViaService(root)).rejects.toThrow("does not match process pid")
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})
