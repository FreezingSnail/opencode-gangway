import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { registerCodexTools, type Ctx } from "./tools"

export const DEFAULT_PORT = 4787

export interface McpServerHandle {
  port: number
  stop(): void
}

export interface StartOptions {
  port?: number
  hostname?: string
  ctx?: Ctx
  pluginOptions?: Record<string, unknown>
}

function buildServer(ctx: Ctx | undefined, pluginOptions: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: "opencode-codex-mcp", version: "0.2.0" })

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

  if (ctx) {
    const configured =
      typeof pluginOptions.defaultWaitMs === "number" ? (pluginOptions.defaultWaitMs as number) : undefined
    registerCodexTools(server, ctx, {
      defaultWaitMs: configured,
      inheritPermissions: pluginOptions.inheritPermissions === true,
    })
  }

  return server
}

export function startMcpServer(options: StartOptions = {}): McpServerHandle {
  const port = options.port ?? DEFAULT_PORT
  const hostname = options.hostname ?? "127.0.0.1"
  const pluginOptions = options.pluginOptions ?? {}

  const httpServer = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") {
        return new Response("not found", { status: 404 })
      }
      // Stateless mode: fresh server + transport per request.
      const server = buildServer(options.ctx, pluginOptions)
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
