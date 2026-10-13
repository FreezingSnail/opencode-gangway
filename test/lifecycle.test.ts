import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireEndpoint } from "../src/lifecycle"
import { startMcpServer } from "../src/mcp"
import type { Ctx } from "../src/tools"

function context(title: string): Ctx {
  return {
    session: {
      get: async () => ({ title }),
      context: async () => [{ type: "idle", outcome: "succeeded" }],
    },
  } as Ctx
}

test("endpoint survives owner unload and routes requests through the remaining context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gangway-lifecycle-"))
  const rendezvous = join(directory, "endpoint.json")
  const first = acquireEndpoint({ port: 0, rendezvous, ctx: context("first"), pluginOptions: {} })
  const info = JSON.parse(readFileSync(rendezvous, "utf8"))
  const modified = statSync(rendezvous).mtimeMs
  const second = acquireEndpoint({ port: 0, rendezvous, ctx: context("second"), pluginOptions: {} })
  async function title() {
    const response = await fetch(info.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "opencode_status", arguments: { sessionID: "ses_example" },
      } }),
    })
    const result: any = await response.json()
    return JSON.parse(result.result.content[0].text).title
  }
  try {
    expect(statSync(rendezvous).mtimeMs).toBe(modified)
    expect(await title()).toBe("first")
    first()
    expect(existsSync(rendezvous)).toBe(true)
    expect(await title()).toBe("second")
    first() // Repeated cleanup must not stop another instance's endpoint.
    expect(await title()).toBe("second")
    second()
    expect(existsSync(rendezvous)).toBe(false)
    const rebound = startMcpServer({ port: info.port })
    rebound.stop()
  } finally {
    first()
    second()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("external port collisions are reported as setup failures", () => {
  const server = startMcpServer({ port: 0 })
  try {
    expect(() => acquireEndpoint({
      port: server.port, rendezvous: "/private/tmp/gangway-unused.json",
      ctx: context("blocked"), pluginOptions: {},
    })).toThrow()
  } finally {
    server.stop()
  }
})
