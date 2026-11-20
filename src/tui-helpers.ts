import type { SessionInfo } from "@opencode/client"

export const TITLE_TAG = "[codex]"

/**
 * True for sessions started (or attached to) by the gangway MCP bridge.
 * New sessions carry `metadata.codexMcp`; older ones only have the
 * `[codex]` title prefix. Both markers are checked so history stays visible.
 */
export function isGangwaySession(session: SessionInfo): boolean {
  return session.metadata?.codexMcp === true || session.title?.startsWith(TITLE_TAG) === true
}

export function titleLabel(session: SessionInfo): string {
  return session.title ?? "(untitled)"
}

export function modelLabel(session: SessionInfo): string {
  return session.model?.id ?? ""
}

export function formatAge(updated: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - updated)
  if (delta < 45_000) return "now"
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const date = new Date(updated)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export type GangwayFilter = "here" | "active" | "all"

export const GANGWAY_FILTERS: readonly GangwayFilter[] = ["here", "active", "all"]

/**
 * A session counts as active only while it is busy. Completed sessions are
 * evicted from the active views immediately; they stay reachable in "all".
 */
export function isActiveSession(status: "idle" | "running"): boolean {
  return status === "running"
}

export type SessionStatus = (session: SessionInfo) => "idle" | "running"

export function applyGangwayFilter(
  sessions: readonly SessionInfo[],
  filter: GangwayFilter,
  options: { readonly directory?: string; readonly status: SessionStatus },
): SessionInfo[] {
  const active = sessions.filter((session) => isActiveSession(options.status(session)))
  if (filter === "active") return active
  if (filter === "here") {
    const directory = options.directory
    return directory === undefined ? active : active.filter((session) => session.location.directory === directory)
  }
  return [...sessions]
}

/** Head-truncate a single token (model ids). */
export function truncateHead(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
}

/** Tail-truncate a path so the directory name stays visible. */
export function truncatePath(value: string, max: number): string {
  return value.length <= max ? value : `…${value.slice(-(max - 1))}`
}
