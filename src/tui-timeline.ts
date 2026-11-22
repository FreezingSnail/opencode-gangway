import { sanitizeTerminalText } from "./tui-preview"

// Pure reducer for the gangway session activity timeline. The view feeds it
// OpenCode's durable session log plus live server events; everything here is
// side-effect free so overlap, ordering and eviction stay testable outside
// Solid. Only small display strings and timestamps are retained: never
// transcripts, tool inputs/results or provider error payloads.

/** Newest events kept for the visible trail. */
export const TIMELINE_EVENT_LIMIT = 80
/** Hard cap on log items consumed for one on-demand history read. */
export const TIMELINE_HISTORY_LIMIT = 2000
/** Log items kept while a history read is still streaming. */
export const TIMELINE_RETAIN_LIMIT = TIMELINE_EVENT_LIMIT
/** Correlated tool names kept for start/completion labels. */
export const TIMELINE_TOOL_LIMIT = 200

export type TimelineTone = "neutral" | "info" | "success" | "warning" | "attention" | "muted"

export type TimelineEventKind =
  | "prompt"
  | "run.start"
  | "run.finish"
  | "run.fail"
  | "run.interrupt"
  | "tool.start"
  | "tool.finish"
  | "tool.fail"
  | "attention.request"
  | "attention.resolve"
  | "retry"
  | "idle"

export interface TimelineEvent {
  /** Stable identity shared by the durable log and the live event. */
  readonly key: string
  readonly kind: TimelineEventKind
  readonly at: number
  readonly seq?: number
  readonly label: string
  readonly tone: TimelineTone
}

export interface TimelineToolName {
  readonly key: string
  readonly name: string
}

export type TimelineCoverage =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly partial: boolean }
  | { readonly status: "unsupported" }
  | { readonly status: "error"; readonly detail?: string }

export interface TimelineState {
  readonly sessionID: string
  /** Newest first, deduplicated, bounded. */
  readonly events: readonly TimelineEvent[]
  readonly toolNames: readonly TimelineToolName[]
  readonly coverage: TimelineCoverage
  /** True once the bounded trail dropped older retained events. */
  readonly evicted: boolean
  readonly lastActivityAt?: number
}

/**
 * Structural subset of `SessionLogItem` / `OpenCodeEvent`. Keeping the reducer
 * independent of the generated unions makes both history and live server
 * events feed the same path and keeps fixtures small.
 */
export interface TimelineInputEvent {
  readonly id?: string
  readonly created?: number
  readonly type: string
  readonly durable?: {
    readonly aggregateID?: string
    readonly seq?: number
  }
  readonly data?: unknown
}

export interface TimelineHistoryRead {
  /** Retained items in original (oldest first) log order. */
  readonly items: readonly TimelineInputEvent[]
  readonly total: number
  readonly partial: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function displayText(value: unknown, max = 40): string {
  if (typeof value !== "string") return ""
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim().slice(0, max)
}

function sessionIDOf(event: TimelineInputEvent): string | undefined {
  const value = asRecord(event.data).sessionID
  return typeof value === "string" ? value : undefined
}

function eventKey(event: TimelineInputEvent): string | undefined {
  const durable = event.durable
  if (durable && typeof durable.aggregateID === "string" && typeof durable.seq === "number") {
    return `d:${durable.aggregateID}:${durable.seq}`
  }
  if (typeof event.id === "string" && event.id.length > 0) return `e:${event.id}`
  return undefined
}

function eventTime(event: TimelineInputEvent): number {
  return finiteNumber(event.created) ?? 0
}

function toolKey(data: Record<string, unknown>): string | undefined {
  const id = typeof data.id === "string" ? data.id : undefined
  if (!id) return undefined
  const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
  return messageID ? `${messageID}:${id}` : id
}

function toolName(toolNames: readonly TimelineToolName[], key: string | undefined): string | undefined {
  if (!key) return undefined
  return toolNames.find((entry) => entry.key === key)?.name
}

function upsertToolName(
  toolNames: readonly TimelineToolName[],
  key: string,
  name: string,
): readonly TimelineToolName[] {
  const trimmed = displayText(name)
  if (!trimmed) return toolNames
  const index = toolNames.findIndex((entry) => entry.key === key)
  if (index === -1) {
    const next = [...toolNames, { key, name: trimmed }]
    return next.length > TIMELINE_TOOL_LIMIT ? next.slice(next.length - TIMELINE_TOOL_LIMIT) : next
  }
  if (toolNames[index]!.name === trimmed) return toolNames
  const next = [...toolNames]
  next[index] = { key, name: trimmed }
  return next
}

interface Projection {
  readonly name?: TimelineToolName
  readonly event?: TimelineEvent
}

export function createTimelineState(sessionID: string): TimelineState {
  return {
    sessionID,
    events: [],
    toolNames: [],
    coverage: { status: "loading" },
    evicted: false,
  }
}

export function setTimelineCoverage(state: TimelineState, coverage: TimelineCoverage): TimelineState {
  return { ...state, coverage }
}

function projectEvent(event: TimelineInputEvent, state: TimelineState): Projection | undefined {
  const data = asRecord(event.data)
  const key = eventKey(event)
  const at = eventTime(event)
  const seq = event.durable?.seq
  const make = (kind: TimelineEventKind, label: string, tone: TimelineTone): Projection => ({
    event: {
      key: key ?? `x:${event.type}:${at}:${typeof data.id === "string" ? data.id : ""}`,
      kind,
      at,
      ...(typeof seq === "number" ? { seq } : {}),
      label,
      tone,
    },
  })

  switch (event.type) {
    case "session.inbox.delivered":
      return make("prompt", "Prompt delivered", "info")

    case "session.execution.started":
      return make("run.start", "Run started", "info")

    case "session.execution.succeeded":
      return make("run.finish", "Run finished", "success")

    case "session.execution.failed":
      return make("run.fail", "Run failed", "warning")

    case "session.execution.interrupted": {
      const reason = displayText(data.reason, 20)
      return make("run.interrupt", reason ? `Run interrupted (${reason})` : "Run interrupted", "warning")
    }

    case "session.tool.input.started": {
      const key = toolKey(data)
      const name = displayText(data.name)
      if (!key || !name) return undefined
      return { name: { key, name } }
    }

    case "session.tool.called": {
      const name = toolName(state.toolNames, toolKey(data))
      return make("tool.start", name ? `Tool ${name} started` : "Tool started", "neutral")
    }

    case "session.tool.success": {
      const name = toolName(state.toolNames, toolKey(data))
      return make("tool.finish", name ? `Tool ${name} finished` : "Tool finished", "success")
    }

    case "session.tool.failed": {
      const name = toolName(state.toolNames, toolKey(data))
      return make("tool.fail", name ? `Tool ${name} failed` : "Tool failed", "warning")
    }

    case "session.retry.scheduled": {
      const attempt = finiteNumber(data.attempt)
      return make("retry", attempt ? `Retry scheduled (attempt ${attempt})` : "Retry scheduled", "warning")
    }

    case "session.idle":
      return make("idle", "Session idle", "muted")

    case "permission.asked": {
      const question = data.action === "question"
      return make("attention.request", question ? "Question asked" : "Permission requested", question ? "attention" : "warning")
    }

    case "permission.replied":
      return make("attention.resolve", "Permission resolved", "muted")

    case "form.created":
      return make("attention.request", "Question asked", "attention")

    case "form.replied":
      return make("attention.resolve", "Question answered", "muted")

    case "form.cancelled":
      return make("attention.resolve", "Question cancelled", "muted")

    default:
      return undefined
  }
}

function compareNewestFirst(a: TimelineEvent, b: TimelineEvent): number {
  if (a.at !== b.at) return b.at - a.at
  const aSeq = a.seq ?? -1
  const bSeq = b.seq ?? -1
  if (aSeq !== bSeq) return bSeq - aSeq
  if (a.key === b.key) return 0
  return a.key < b.key ? 1 : -1
}

/**
 * Merge one history or live event. Replayed events collapse on their durable
 * identity, late events land in timestamp order, and the retained trail stays
 * bounded. Events for other sessions are ignored.
 */
export function applyTimelineEvent(state: TimelineState, input: TimelineInputEvent): TimelineState {
  if (!state.sessionID) return state
  if (typeof input?.type !== "string") return state
  if (input.type === "log.synced") return state
  if (sessionIDOf(input) !== state.sessionID) return state

  const projection = projectEvent(input, state)
  if (!projection) return state

  let next = state
  if (projection.name) {
    const toolNames = upsertToolName(state.toolNames, projection.name.key, projection.name.name)
    if (toolNames !== state.toolNames) next = { ...next, toolNames }
  }
  const event = projection.event
  if (!event) return next
  if (next.events.some((existing) => existing.key === event.key)) return next

  const events = [...next.events, event].sort(compareNewestFirst)
  const evicted = events.length > TIMELINE_EVENT_LIMIT
  const bounded = evicted ? events.slice(0, TIMELINE_EVENT_LIMIT) : events
  const lastActivityAt =
    next.lastActivityAt === undefined || event.at > next.lastActivityAt ? event.at : next.lastActivityAt
  return {
    ...next,
    events: bounded,
    evicted: next.evicted || evicted,
    lastActivityAt,
  }
}

/** Apply a whole history page in log order without replacing live events. */
export function applyTimelineHistory(
  state: TimelineState,
  items: readonly TimelineInputEvent[],
): TimelineState {
  let next = state
  for (const item of items) next = applyTimelineEvent(next, item)
  return next
}

/** True when the retained trail is known to be shorter than the session log. */
export function timelineIsPartial(state: TimelineState): boolean {
  return state.evicted || (state.coverage.status === "ready" && state.coverage.partial)
}

export interface TimelineNotice {
  readonly text: string
  readonly warning: boolean
}

/**
 * Honest coverage copy for the header. Unsupported or failed history reads
 * stay visibly labelled while live events keep the view usable.
 */
export function timelineNotice(state: TimelineState): TimelineNotice | undefined {
  const count = state.events.length
  if (state.coverage.status === "loading") {
    return { text: count > 0 ? "Refreshing history…" : "Loading history…", warning: false }
  }
  if (state.coverage.status === "unsupported") {
    return { text: "History unavailable; showing observed live activity only.", warning: true }
  }
  if (state.coverage.status === "error") {
    const detail = state.coverage.detail
    return {
      text:
        count > 0
          ? `History may be incomplete${detail ? `: ${detail}` : "."}`
          : `History unavailable; showing observed live activity only.${detail ? ` (${detail})` : ""}`,
      warning: true,
    }
  }
  if (timelineIsPartial(state)) {
    if (state.evicted) {
      return { text: `Showing the newest ${count} events; older activity is hidden.`, warning: false }
    }
    return { text: "History is partial; older activity is not retained.", warning: false }
  }
  if (count === 0) return { text: "No activity observed yet.", warning: false }
  return undefined
}

/**
 * Read one non-following log stream with a hard consumption cap. The newest
 * items are retained in a ring while the total is counted, so a long log is
 * bounded without keeping the oldest page.
 */
export async function readTimelineHistory(
  stream: AsyncIterable<TimelineInputEvent>,
  options: { readonly limit?: number; readonly retain?: number; readonly signal?: AbortSignal } = {},
): Promise<TimelineHistoryRead> {
  const limit = Math.max(1, Math.floor(options.limit ?? TIMELINE_HISTORY_LIMIT))
  const retain = Math.max(1, Math.floor(options.retain ?? TIMELINE_RETAIN_LIMIT))
  const retained: TimelineInputEvent[] = []
  let total = 0
  let partial = false

  for await (const item of stream) {
    if (options.signal?.aborted) {
      partial = true
      break
    }
    if (!item || typeof item.type !== "string" || item.type === "log.synced") continue
    total += 1
    retained.push(item)
    if (retained.length > retain) retained.shift()
    if (total > limit) {
      partial = true
      break
    }
  }

  if (total > retained.length) partial = true
  return { items: retained, total, partial }
}

/**
 * Explicit end state for the header: the store's live status wins, otherwise
 * the newest terminal event decides. Idle is surfaced instead of guessed.
 */
export function timelineOutcome(
  events: readonly TimelineEvent[],
  liveStatus: "idle" | "running",
): "running" | "finished" | "failed" | "interrupted" | "idle" {
  if (liveStatus === "running") return "running"
  for (const event of events) {
    if (event.kind === "run.finish") return "finished"
    if (event.kind === "run.fail") return "failed"
    if (event.kind === "run.interrupt") return "interrupted"
    if (event.kind === "idle") return "idle"
  }
  return "idle"
}
