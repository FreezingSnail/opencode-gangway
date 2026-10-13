import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Integration tests against a running gangway endpoint
// (default http://127.0.0.1:4787/mcp, override with MCP_URL).
//
// The static suite runs whenever the endpoint answers. The live suite spawns real
// OpenCode sessions on the configured model and only runs with RUN_LIVE=1.

const url = process.env.MCP_URL ?? "http://127.0.0.1:4787/mcp"
const RUN_LIVE = process.env.RUN_LIVE === "1"

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      signal: AbortSignal.timeout(1500),
    })
    return res.status < 500
  } catch {
    return false
  }
}

const up = await reachable()

async function connect(): Promise<Client> {
  const client = new Client({ name: "gangway-test", version: "0.0.1", requestTimeout: 55_000 })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean }

function textOf(result: unknown): string {
  const content = (result as ToolResult).content ?? []
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
}

const maybe = up ? describe : describe.skip

maybe("gangway endpoint", () => {
  test("initialize, list tools, call ping", async () => {
    const client = await connect()

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    expect(names).toContain("opencode_ping")
    for (const tool of [
      "opencode_start_session",
      "opencode_prompt",
      "opencode_wait",
      "opencode_status",
      "opencode_result",
      "opencode_interrupt",
      "opencode_list",
    ]) {
      expect(names).toContain(tool)
    }

    const result = await client.callTool({ name: "opencode_ping", arguments: {} })
    expect(JSON.parse(textOf(result)).pong).toBe(true)

    await client.close()
  })

  test("rejects malformed model references", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "opencode_start_session",
      arguments: { prompt: "noop", model: "not-a-model-ref" },
    })
    expect((result as ToolResult).isError).toBe(true)
    expect(textOf(result)).toContain("provider/modelID")
    await client.close()
  })

  test("reports unknown sessions as errors", async () => {
    const client = await connect()
    const result = await client.callTool({
      name: "opencode_status",
      arguments: { sessionID: "ses_00000000000000000000000000" },
    })
    expect((result as ToolResult).isError).toBe(true)
    await client.close()
  })
})

const live = up && RUN_LIVE ? describe : describe.skip

live("session tools (live)", () => {
  test(
    "starts a deepseek-v4.1-flash session and returns its output",
    async () => {
      const client = await connect()
      const result = await client.callTool({
        name: "opencode_start_session",
        arguments: { prompt: "Reply with exactly: OK", wait: true, timeoutMs: 50_000 },
      })
      const parsed = JSON.parse(textOf(result))
      expect(parsed.sessionID).toStartWith("ses_")
      expect(parsed.status).toBe("idle")
      expect(parsed.text).toContain("OK")
      expect(parsed.model.id).toBe("deepseek-v4.1-flash")
      expect(parsed.model.providerID).toBe("opencode-go")
      await client.close()
    },
    120_000,
  )

  test(
    "denies git push through the unattended ruleset without stalling",
    async () => {
      const client = await connect()
      const result = await client.callTool({
        name: "opencode_start_session",
        arguments: {
          prompt: "Use the shell tool to run exactly: git push. Report the exact error message, nothing else.",
          wait: true,
          timeoutMs: 50_000,
        },
      })
      const parsed = JSON.parse(textOf(result))
      expect(parsed.status).toBe("idle")
      expect(parsed.text).toContain("Permission denied")
      await client.close()
    },
    120_000,
  )

  test(
    "lists sessions started through the bridge",
    async () => {
      const client = await connect()
      const result = await client.callTool({ name: "opencode_list", arguments: { limit: 5 } })
      const parsed = JSON.parse(textOf(result))
      expect(Array.isArray(parsed.sessions)).toBe(true)
      expect(parsed.sessions[0]?.sessionID).toStartWith("ses_")
      await client.close()
    },
    60_000,
  )
})
