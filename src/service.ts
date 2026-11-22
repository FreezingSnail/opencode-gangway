import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Shared access to the local OpenCode service. The service file is local-only
// state; its password is a local secret and is never logged.

export interface ServiceInfo {
  url?: unknown
  pid?: unknown
  password?: unknown
}

export interface ServiceConfig {
  base: string
  password?: string
  file: string
}

export function serviceFile(): string {
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  )
}

export function readServiceConfig(): ServiceConfig {
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

  return {
    base: info.url.replace(/\/+$/, ""),
    ...(typeof info.password === "string" ? { password: info.password } : {}),
    file,
  }
}

export function serviceHeaders(config: ServiceConfig): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" }
  if (typeof config.password === "string") {
    headers.authorization =
      "Basic " + Buffer.from(`opencode:${config.password}`).toString("base64")
  }
  return headers
}

/**
 * Authenticated request against the local service. Reads `service.json` unless a
 * caller already resolved the config, so a missing/foreign file fails the same
 * way everywhere. Callers own error wrapping; the password is never included in
 * a thrown message.
 */
export async function serviceFetch(
  path: string,
  options: { timeoutMs?: number; config?: ServiceConfig } = {},
): Promise<Response> {
  const config = options.config ?? readServiceConfig()
  return fetch(`${config.base}${path}`, {
    headers: serviceHeaders(config),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  })
}
