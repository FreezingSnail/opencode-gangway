import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { startMcpServer, type McpServerHandle, type StartOptions } from "./mcp"
import type { Ctx } from "./tools"

interface Instance {
  ctx: Ctx
  pluginOptions: Record<string, unknown>
}

export type EnsureLocation = (directory: string) => Promise<void>

interface Endpoint {
  server: McpServerHandle
  instances: Map<symbol, Instance>
  rendezvous: string
  // Older module generations created endpoints without this field. Attach and
  // resolution fill it in so a hot reload keeps the same listener.
  ensureLocation?: EnsureLocation
}

// OpenCode can re-evaluate this module on reload. Keep endpoint leases on the
// same process-global key used by earlier generations, so old and new modules
// share one listener instead of colliding on the port. The listener is
// process-lifetime: the final plugin lease releasing does not stop it.
const endpointsKey = Symbol.for("gangway.endpoints.v1")
const shared = globalThis as typeof globalThis & { [endpointsKey]?: Map<number, Endpoint> }
const endpoints = shared[endpointsKey] ??= new Map<number, Endpoint>()

// Most recent first. Kept after instance leases release so a new request can
// reacquire an existing location. Entries are never treated as live contexts
// and deleted directories are skipped at request time. A separate key keeps the
// endpoint map's old shape compatible across module generations.
const recentKey = Symbol.for("gangway.recent-locations.v1")
const sharedRecent = globalThis as typeof globalThis & { [recentKey]?: string[] }
const recent = sharedRecent[recentKey] ??= []

export interface AcquireEndpointOptions extends Instance {
  port: number
  rendezvous: string
  // Test seam / custom bootstrap. Defaults to the installed OpenCode service API.
  ensureLocation?: EnsureLocation
}

function canonicalDirectory(directory: string): string | null {
  try {
    const canonical = realpathSync(directory)
    return statSync(canonical).isDirectory() ? canonical : null
  } catch {
    return null
  }
}

function requireDirectory(directory: string): string {
  let canonical: string
  try {
    canonical = realpathSync(directory)
  } catch {
    throw new Error(`OpenCode location directory does not exist: ${directory}`)
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`OpenCode location path is not a directory: ${directory}`)
  }
  return canonical
}

function rememberDirectory(directory: unknown): void {
  if (typeof directory !== "string" || !directory) return
  const index = recent.indexOf(directory)
  if (index >= 0) recent.splice(index, 1)
  recent.unshift(directory)
  if (recent.length > 20) recent.length = 20
}

function knownDirectory(): string | undefined {
  for (const directory of recent) {
    if (canonicalDirectory(directory)) return directory
  }
  return undefined
}

function isLiveInstance(instance: Instance): boolean {
  const directory = instance.ctx.location?.directory
  // Instances without a directory are usable. A location whose directory was
  // deleted is not: never route new work into a removed worktree.
  return typeof directory !== "string" || !directory || canonicalDirectory(directory) !== null
}

function knownDirectoryFor(endpoint: Endpoint): string | undefined {
  for (const instance of endpoint.instances.values()) {
    const directory = instance.ctx.location?.directory
    if (typeof directory === "string" && directory && canonicalDirectory(directory)) return directory
  }
  return knownDirectory()
}

function findInstance(endpoint: Endpoint, requested?: string): Instance | undefined {
  const wanted = requested ? canonicalDirectory(requested) : null
  const live = [...endpoint.instances.values()].filter(isLiveInstance)
  if (wanted) {
    for (const instance of live) {
      const directory = instance.ctx.location?.directory
      if (typeof directory === "string" && canonicalDirectory(directory) === wanted) return instance
    }
  }
  return live[0]
}

function findEndpoint(port: number): Endpoint | undefined {
  const direct = endpoints.get(port)
  if (direct) return direct
  // Port 0 acquires are keyed as 0; also match an already-bound real port so a
  // reload can attach instead of attempting a second listener.
  for (const endpoint of endpoints.values()) {
    if (endpoint.server.port === port) return endpoint
  }
  return undefined
}

async function resolveContext(
  endpoint: Endpoint,
  requested?: string,
): Promise<{ ctx: Ctx; pluginOptions: Record<string, unknown> }> {
  // An explicitly requested location must exist even when another live context
  // could serve the request: never route work into a deleted worktree.
  if (requested) requireDirectory(requested)
  const live = findInstance(endpoint, requested)
  if (live) {
    return { ctx: live.ctx, pluginOptions: live.pluginOptions }
  }

  let directory: string | undefined
  if (requested) {
    directory = requested
  } else {
    directory = recent.find((candidate) => canonicalDirectory(candidate))
  }
  if (!directory) {
    throw new Error(
      "no live OpenCode context is available and no directory was supplied; " +
        "pass opencode_start_session arguments.directory or open a project",
    )
  }

  // Never boot a deleted/missing path or revive a deleted worktree.
  requireDirectory(directory)

  const ensure = endpoint.ensureLocation ?? ensureLocationViaService
  try {
    await ensure(directory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to reacquire OpenCode location ${directory}: ${message}`)
  }

  const reacquired = findInstance(endpoint, directory)
  if (!reacquired) {
    throw new Error(`no live OpenCode context after reacquiring location ${directory}`)
  }
  return { ctx: reacquired.ctx, pluginOptions: reacquired.pluginOptions }
}

function serviceFile(): string {
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  )
}

interface ServiceInfo {
  url?: unknown
  pid?: unknown
  password?: unknown
}

/**
 * Default location reacquisition: ask the running OpenCode service to boot the
 * requested location through its public HTTP API.
 *
 * The service file is local-only state. Values are not secrets beyond the local
 * service password, which is never logged.
 */
export async function ensureLocationViaService(directory: string): Promise<void> {
  const file = serviceFile()
  let info: ServiceInfo
  try {
    info = JSON.parse(readFileSync(file, "utf8")) as ServiceInfo
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read OpenCode service info at ${file}: ${message}`)
  }

  if (typeof info.url !== "string" || !info.url) {
    throw new Error(`OpenCode service info at ${file} has no url`)
  }
  if (info.pid !== process.pid) {
    throw new Error(
      `OpenCode service pid ${String(info.pid)} does not match process pid ${process.pid}; ` +
        "refusing to reacquire a location through another process",
    )
  }

  const base = info.url.replace(/\/+$/, "")
  const url = `${base}/api/location?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  const headers: Record<string, string> = { accept: "application/json" }
  if (typeof info.password === "string") {
    headers.authorization =
      "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64")
  }

  let response: Response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`OpenCode location request failed: ${message}`)
  }
  if (!response.ok) {
    throw new Error(`OpenCode location request for ${directory} returned HTTP ${response.status}`)
  }
}

export function acquireEndpoint(options: AcquireEndpointOptions): () => void {
  const token = Symbol("gangway instance")
  let endpoint = findEndpoint(options.port)

  if (!endpoint) {
    const instances = new Map<symbol, Instance>([[token, options]])
    rememberDirectory(options.ctx.location?.directory)
    let created: Endpoint | undefined
    const server = startMcpServer({
      port: options.port,
      context: (request) => resolveContext(created!, request?.directory),
      knownDirectory: () => knownDirectoryFor(created!),
    } satisfies StartOptions)
    created = {
      server,
      instances,
      rendezvous: options.rendezvous,
      ensureLocation: options.ensureLocation ?? ensureLocationViaService,
    }
    endpoint = created
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
    endpoint.ensureLocation ??= options.ensureLocation ?? ensureLocationViaService
    if (options.ensureLocation) endpoint.ensureLocation = options.ensureLocation
    rememberDirectory(options.ctx.location?.directory)
  }

  const owned = endpoint
  let released = false
  return () => {
    if (released) return
    released = true
    owned.instances.delete(token)
    // Process-lifetime ownership: the endpoint stays up after the final lease
    // releases so an idle host can still serve new Codex requests.
  }
}

/**
 * Stop every listener associated with this process, remove its rendezvous file,
 * and clear the recent-location list. Idempotent.
 */
export function shutdownEndpoints(): void {
  for (const endpoint of endpoints.values()) {
    try { endpoint.server.stop() } catch {}
    try { rmSync(endpoint.rendezvous, { force: true }) } catch {}
  }
  endpoints.clear()
  recent.length = 0
}

// Register intentional-shutdown cleanup once per process, module reload safe.
// SIGKILL cannot run handlers; a stale rendezvous is overwritten by the next
// startup. Do not install SIGINT/SIGTERM handlers: the host owns those signals.
const cleanupKey = Symbol.for("gangway.endpoint-cleanup.v1")
const cleanupRegistered = globalThis as typeof globalThis & { [cleanupKey]?: boolean }
if (!cleanupRegistered[cleanupKey]) {
  cleanupRegistered[cleanupKey] = true
  process.once("exit", () => shutdownEndpoints())
  process.once("beforeExit", () => shutdownEndpoints())
}
