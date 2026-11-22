import type { SessionInfo } from "@opencode/client"

export const TITLE_TAG = "[gangway]"
/** Prefix written by bridge versions before the neutral markers landed. */
export const LEGACY_TITLE_TAG = "[codex]"

export interface GangwayMarkerInput {
  metadata?: Record<string, unknown> | null
  title?: string | null
}

/**
 * True for sessions started (or attached to) by the gangway MCP bridge.
 * New sessions carry `metadata.gangway` and a `[gangway]` title prefix.
 * Sessions from older bridge versions carry `metadata.codexMcp` and/or a
 * `[codex]` title prefix; both legacy markers are accepted so history stays
 * visible in the panel.
 */
export function hasGangwayMarker(session: GangwayMarkerInput): boolean {
  return (
    session.metadata?.gangway === true ||
    session.metadata?.codexMcp === true ||
    session.title?.startsWith(TITLE_TAG) === true ||
    session.title?.startsWith(LEGACY_TITLE_TAG) === true
  )
}

export function isGangwaySession(session: SessionInfo): boolean {
  return hasGangwayMarker(session)
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

/** A stall that needs the user: a permission prompt or a question form. */
export interface NeedsInput {
  readonly kind: "permission" | "question"
}

export interface PendingAttentionSources {
  /** Permission requests for one session; `undefined` means "not synced yet". */
  readonly permissions?: readonly { readonly action: string }[] | undefined
  /** Pending forms for one session; `undefined` means "not synced yet". */
  readonly forms?: readonly unknown[] | undefined
}

/**
 * Classify a session's pending prompts. Permission wins ties: a real permission
 * request outranks a question form, while an `action: "question"` permission
 * (the SDK's question prompt) and any form both read as questions.
 * Unsynced (`undefined`) lists never create attention.
 */
export function classifyNeedsInput(sources: PendingAttentionSources): NeedsInput | undefined {
  const permissions = sources.permissions
  if (permissions !== undefined) {
    if (permissions.some((permission) => permission.action !== "question")) return { kind: "permission" }
    if (permissions.length > 0) return { kind: "question" }
  }
  if (sources.forms !== undefined && sources.forms.length > 0) return { kind: "question" }
  return undefined
}

export type SessionStatus = (session: SessionInfo) => "idle" | "running"
export type SessionAttention = (session: SessionInfo) => NeedsInput | undefined

/**
 * A session counts as active while it is busy or stalled on an unanswered
 * prompt. Completed, answered sessions are evicted from the active views
 * immediately; they stay reachable in "all".
 */
export function isActiveSession(status: "idle" | "running", needsInput?: NeedsInput): boolean {
  return status === "running" || needsInput !== undefined
}

/** Row glyph: prompt attention first, then the existing busy/idle markers. */
export function sessionGlyph(status: "idle" | "running", needsInput?: NeedsInput): "!" | "?" | "▶" | "○" {
  if (needsInput?.kind === "permission") return "!"
  if (needsInput?.kind === "question") return "?"
  return status === "running" ? "▶" : "○"
}

export function countWaitingSessions(
  sessions: readonly SessionInfo[],
  attention: SessionAttention | undefined,
): number {
  if (!attention) return 0
  return sessions.filter((session) => attention(session) !== undefined).length
}

function waitingFirst(sessions: readonly SessionInfo[], attention: SessionAttention | undefined): SessionInfo[] {
  if (!attention) return [...sessions]
  const waiting = sessions.filter((session) => attention(session) !== undefined)
  if (waiting.length === 0) return [...sessions]
  return [...waiting, ...sessions.filter((session) => attention(session) === undefined)]
}

export function applyGangwayFilter(
  sessions: readonly SessionInfo[],
  filter: GangwayFilter,
  options: { readonly directory?: string; readonly status: SessionStatus; readonly attention?: SessionAttention },
): SessionInfo[] {
  const active = sessions.filter((session) =>
    isActiveSession(options.status(session), options.attention?.(session)),
  )
  if (filter === "active") return waitingFirst(active, options.attention)
  if (filter === "here") {
    const directory = options.directory
    const scoped = directory === undefined ? active : active.filter((session) => session.location.directory === directory)
    return waitingFirst(scoped, options.attention)
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
