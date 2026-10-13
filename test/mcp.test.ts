import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Integration test: requires a running endpoint (default http://127.0.0.1:4787/mcp,
// override with MCP_URL). Skipped when MCP_URL is absent and the default endpoint
// is unreachable.
const url = process.env.MCP_URL ?? "http://127.0.0.1:4787/mcp"

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
const maybe = up ? describe : describe.skip

maybe("codex-mcp endpoint", () => {
  test("initialize, list tools, call ping", async () => {
    const client = new Client({ name: "codex-mcp-test", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toContain("opencode_ping")

    const result = await client.callTool({ name: "opencode_ping", arguments: {} })
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (part) => part.type === "text",
    )?.text
    expect(JSON.parse(text ?? "{}").pong).toBe(true)

    await client.close()
  })
})
