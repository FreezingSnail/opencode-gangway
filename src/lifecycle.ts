import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { startMcpServer, type McpServerHandle } from "./mcp"
import type { Ctx } from "./tools"

interface Instance {
  ctx: Ctx
  pluginOptions: Record<string, unknown>
}

interface Endpoint {
  server: McpServerHandle
  instances: Map<symbol, Instance>
  rendezvous: string
}

// OpenCode can re-evaluate this module on reload. Keep endpoint leases on the
// process so old and new module generations share the same listener.
const key = Symbol.for("gangway.endpoints.v1")
const shared = globalThis as typeof globalThis & { [key]?: Map<number, Endpoint> }
const endpoints = shared[key] ??= new Map<number, Endpoint>()

export function acquireEndpoint(options: Instance & { port: number; rendezvous: string }): () => void {
  const token = Symbol("gangway instance")
  let endpoint = endpoints.get(options.port)
  if (!endpoint) {
    const instances = new Map<symbol, Instance>([[token, options]])
    const server = startMcpServer({
      port: options.port,
      context: () => instances.values().next().value!,
    })
    endpoint = { server, instances, rendezvous: options.rendezvous }
    endpoints.set(options.port, endpoint)
    try {
      mkdirSync(dirname(options.rendezvous), { recursive: true })
      writeFileSync(options.rendezvous, JSON.stringify({
        url: `http://127.0.0.1:${server.port}/mcp`, port: server.port, pid: process.pid,
      }, null, 2))
    } catch (error) {
      console.error("[gangway] rendezvous write failed:", error)
    }
    console.error(`[gangway] listening on http://127.0.0.1:${server.port}/mcp`)
  } else {
    endpoint.instances.set(token, options)
  }
  const owned = endpoint
  return () => {
    if (!owned.instances.delete(token) || owned.instances.size) return
    endpoints.delete(options.port)
    owned.server.stop()
    try { rmSync(owned.rendezvous, { force: true }) } catch {}
    console.error("[gangway] stopped after final instance unloaded")
  }
}
