import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { registerBridgeTools, type Ctx } from "./tools"

export const DEFAULT_PORT = 4787

export interface McpServerHandle {
  port: number
  stop(): void
}

export interface ContextRequest {
  // Directory parsed from `opencode_start_session` when present. It lets the
  // resolver boot or reacquire an existing OpenCode location before dispatch.
  directory?: string
}

export interface ResolvedContext {
  ctx: Ctx
  pluginOptions: Record<string, unknown>
}

export interface StartOptions {
  port?: number
  hostname?: string
  ctx?: Ctx
  pluginOptions?: Record<string, unknown>
  // Resolve the current plugin owner when each request arrives. Async resolvers
  // may boot/reacquire an OpenCode location; throwing is treated like "no current
  // context" so ping still answers and tools can retry lazily.
  context?: (
    request?: ContextRequest,
  ) => ResolvedContext | null | undefined | Promise<ResolvedContext | null | undefined>
  // Most recent known location directory for the lazy context facade.
  knownDirectory?: () => string | undefined
}

interface RequestHint {
  // A real tool call (not ping, initialize, or tools/list) may need a live
  // location. Health checks must not boot an idle location as a side effect.
  resolve: boolean
  // Only `opencode_start_session` carries a directory that may need booting.
  directory?: string
}

// Parse the JSON-RPC body (single message or batch) without consuming the
// original request. Malformed/non-JSON bodies are ignored.
async function requestHint(request: Request): Promise<RequestHint> {
  try {
    const body: unknown = await request.clone().json()
    const messages = Array.isArray(body) ? body : [body]
    let resolve = false
    let directory: string | undefined
    for (const message of messages) {
      if (!message || typeof message !== "object") continue
      const call = message as { method?: unknown; params?: unknown }
      if (call.method !== "tools/call" || !call.params || typeof call.params !== "object") continue
      const params = call.params as { name?: unknown; arguments?: unknown }
      if (typeof params.name !== "string" || params.name === "opencode_ping") continue
      resolve = true
      if (params.name !== "opencode_start_session") continue
      if (!params.arguments || typeof params.arguments !== "object") continue
      const candidate = (params.arguments as { directory?: unknown }).directory
      if (typeof candidate === "string" && candidate) directory = candidate
    }
    return { resolve, ...(directory ? { directory } : {}) }
  } catch {
    // Not JSON (or a body the transport will reject itself): no hint.
    return { resolve: false }
  }
}

function contextUnavailable(error: unknown, requested?: string): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(
    `OpenCode context unavailable${requested ? ` for ${requested}` : ""}: ${detail}`,
  )
}

// Registering tools requires a Ctx object, but no location may currently be
// live. The facade defers the first method call to the resolver, then caches the
// resolved context for the rest of the request. `location` is synchronous: it
// reports the resolved directory, else the most recent known one.
function lazyContext(
  resolve: NonNullable<StartOptions["context"]>,
  knownDirectory: (() => string | undefined) | undefined,
  requested: string | undefined,
): Ctx {
  let current: Ctx | undefined
  let pending: Promise<Ctx> | undefined

  function load(): Promise<Ctx> {
    if (current) return Promise.resolve(current)
    if (!pending) {
      pending = (async () => {
        let resolved: ResolvedContext | null | undefined
        try {
          resolved = await resolve({ ...(requested ? { directory: requested } : {}) })
        } catch (error) {
          throw contextUnavailable(error, requested)
        }
        if (!resolved?.ctx) {
          throw contextUnavailable(
            new Error(
              "no live context is available; pass opencode_start_session arguments.directory or open a project",
            ),
            requested,
          )
        }
        current = resolved.ctx
        return current
      })()
      // A failed resolution is retried by the next method call in this request.
      pending.catch(() => {
        pending = undefined
      })
    }
    return pending
  }

  function methods(name: "session" | "storage") {
    return new Proxy({}, {
      get(_target, property) {
        if (property === "then") return undefined
        return (...args: unknown[]) =>
          load().then((ctx) => {
            const group = ctx[name] as unknown as Record<PropertyKey, unknown> | undefined
            const method = group?.[property]
            if (typeof method !== "function") {
              throw new Error(`OpenCode context has no ${name}.${String(property)} method`)
            }
            return (method as (...args: unknown[]) => unknown).apply(group, args)
          })
      },
    })
  }

  return {
    get location(): { directory?: string } | undefined {
      const live = current?.location?.directory
      if (typeof live === "string" && live) return { directory: live }
      const recent = knownDirectory?.()
      if (typeof recent === "string" && recent) return { directory: recent }
      return requested ? { directory: requested } : undefined
    },
    get options(): Record<string, unknown> | undefined {
      return current?.options
    },
    session: methods("session") as Ctx["session"],
    storage: methods("storage") as Ctx["storage"],
  }
}

function buildServer(ctx: Ctx | undefined, pluginOptions: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: "gangway", version: "0.2.0" })

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
    const titlePrefix =
      typeof pluginOptions.titlePrefix === "string" ? (pluginOptions.titlePrefix as string) : undefined
    registerBridgeTools(server, ctx, {
      defaultWaitMs: configured,
      inheritPermissions: pluginOptions.inheritPermissions === true,
      ...(titlePrefix ? { titlePrefix } : {}),
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

      // Resolve before building the stateless per-request server so a real tool
      // call can reacquire a live location and use the correct context
      // immediately. Ping/initialize/tools-list stay context-free.
      const hint = await requestHint(request)
      let current: ResolvedContext | undefined
      if (hint.resolve && options.context) {
        try {
          current = (await options.context({ ...(hint.directory ? { directory: hint.directory } : {}) })) ?? undefined
        } catch {
          // Keep ping and tools/list available. Tool calls retry through the lazy
          // facade, which surfaces the resolution error to the caller.
        }
      }
      if (!current && options.ctx) {
        current = { ctx: options.ctx, pluginOptions }
      }
      const ctx = current?.ctx ??
        (options.context ? lazyContext(options.context, options.knownDirectory, hint.directory) : undefined)

      // Stateless mode: fresh server + transport per request.
      const server = buildServer(ctx, current?.pluginOptions ?? pluginOptions)
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
