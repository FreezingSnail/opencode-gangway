import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

export const DEFAULT_PORT = 4787

export interface McpServerHandle {
  port: number
  stop(): void
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "opencode-codex-mcp", version: "0.1.0" })

  server.registerTool(
    "opencode_ping",
    {
      description: "Health check for the OpenCode MCP bridge. Returns pong and a timestamp.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ pong: true, time: Date.now() }) }],
    }),
  )

  return server
}

export function startMcpServer(options: { port?: number; hostname?: string } = {}): McpServerHandle {
  const port = options.port ?? DEFAULT_PORT
  const hostname = options.hostname ?? "127.0.0.1"

  const httpServer = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") {
        return new Response("not found", { status: 404 })
      }
      // Stateless mode: fresh server + transport per request.
      const server = buildServer()
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  })

  return {
    port: httpServer.port,
    stop() {
      httpServer.stop(true)
    },
  }
}
