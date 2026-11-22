// Read-only projection of Gangway's durable dispatch operation records.
//
// Operations are stored by requestID hash (`operations/<hash>`), so a session's
// later follow-up cannot be found through the `sessions/<id>` registry alone.
// This module owns the bounded scan and the allowlisted, terminal-safe summary
// that the TUI consumes. It never writes and never touches OpenCode sessions.

export const DISPATCH_SCAN_PAGE = 100
/** On-demand lookup cap. Hitting it is reported as limited coverage. */
export const DISPATCH_SCAN_MAX = 500

export type DispatchKind = "start" | "follow-up" | "unknown"
export type DispatchState =
  | "intent"
  | "created"
  | "submitting"
  | "submitted"
  | "completed"
  | "failed"
  | "unknown"
export type DispatchStatus = "pending" | "running" | "completed" | "failed" | "unknown"
export type DispatchDelivery = "pending" | "recorded" | "unknown"
export type DispatchCoverage = "complete" | "limited"
export type DispatchReason = "recorded" | "legacy" | "none"

export interface DispatchStorage {
  scan(input: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }>
  get(key: string): Promise<unknown>
}

export interface DispatchSummary {
  readonly requestID: string
  readonly kind: DispatchKind
  readonly state: DispatchState
  readonly status: DispatchStatus
  readonly delivery: DispatchDelivery
  readonly submittedAt: number | null
  readonly createdAt: number | null
  readonly updatedAt: number | null
  readonly error: string | null
  readonly warning: string | null
}

export interface DispatchLookup {
  readonly sessionID: string
  readonly coverage: DispatchCoverage
  readonly reason: DispatchReason
  readonly operation: DispatchSummary | null
  /** Entries examined. Internal only; never part of the RPC response. */
  readonly scanned: number
}

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/
const STATES = new Set<DispatchState>([
  "intent",
  "created",
  "submitting",
  "submitted",
  "completed",
  "failed",
  "unknown",
])
const DELIVERIES = new Set<DispatchDelivery>(["pending", "recorded", "unknown"])

export function isDispatchSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value)
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Single-line terminal-safe text; null when nothing printable remains. */
export function terminalSafeText(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null
  const clean = value
    .replace(/\r\n?/g, "\n")
    // OSC and CSI sequences, then any remaining escape/control bytes. The
    // summary is single-line terminal text, not an interpreted transcript.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean) return null
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean
}

/** Bound an error/warning and redact common credential shapes before display. */
export function safeDetailText(value: unknown, max = 140): string | null {
  const clean = terminalSafeText(value, max)
  if (!clean) return null
  return clean
    .replace(
      /\b(password|passwd|token|secret|authorization|api[_-]?key)\b\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]")
}

function stateOf(value: unknown): DispatchState {
  return typeof value === "string" && STATES.has(value as DispatchState)
    ? (value as DispatchState)
    : "unknown"
}

function deliveryOf(value: unknown): DispatchDelivery {
  return typeof value === "string" && DELIVERIES.has(value as DispatchDelivery)
    ? (value as DispatchDelivery)
    : "unknown"
}

function statusOf(state: DispatchState): DispatchStatus {
  if (state === "completed" || state === "failed") return state
  if (state === "submitting" || state === "unknown") return "unknown"
  if (state === "submitted") return "running"
  return "pending"
}

function kindOf(value: unknown): DispatchKind {
  if (value === "start") return "start"
  if (value === "prompt") return "follow-up"
  return "unknown"
}

function warningOf(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const entry of value) {
    const clean = safeDetailText(entry, 140)
    if (clean) return clean
  }
  return null
}

/**
 * Allowlisted projection. Raw operation identity, prompt, transcript,
 * completion, full error text, message ids and credentials never leave here.
 */
export function summarizeDispatch(value: unknown): DispatchSummary | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const requestID = terminalSafeText(raw.requestID, 128)
  if (!requestID) return null
  const state = stateOf(raw.state)
  return {
    requestID,
    kind: kindOf(raw.kind),
    state,
    status: statusOf(state),
    delivery: deliveryOf(raw.delivery),
    submittedAt: finite(raw.submittedAt),
    createdAt: finite(raw.createdAt),
    updatedAt: finite(raw.updatedAt),
    error: safeDetailText(raw.error, 140),
    warning: warningOf(raw.warnings),
  }
}

/** Deterministic newest-first comparison with a stable requestID tiebreak. */
function newer(candidate: DispatchSummary, current: DispatchSummary): boolean {
  const candidateCreated = candidate.createdAt ?? -Infinity
  const currentCreated = current.createdAt ?? -Infinity
  if (candidateCreated !== currentCreated) return candidateCreated > currentCreated
  const candidateUpdated = candidate.updatedAt ?? -Infinity
  const currentUpdated = current.updatedAt ?? -Infinity
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated
  return candidate.requestID > current.requestID
}

/**
 * Scan operation records for one session. Every candidate is checked against
 * the requested sessionID; foreign records are ignored even when they sort
 * first. The scan stops at DISPATCH_SCAN_MAX entries and reports limited
 * coverage instead of claiming the candidate is the globally latest record.
 */
export async function lookupLatestDispatch(
  storage: DispatchStorage | undefined,
  sessionID: string,
): Promise<DispatchLookup> {
  if (!isDispatchSessionID(sessionID)) {
    throw new Error("invalid sessionID for dispatch lookup")
  }
  if (!storage || typeof storage.scan !== "function") {
    throw new Error("dispatch record storage is unavailable")
  }

  let after: string | undefined
  let scanned = 0
  let exhausted = false
  let latest: DispatchSummary | null = null

  while (scanned < DISPATCH_SCAN_MAX) {
    const limit = Math.min(DISPATCH_SCAN_PAGE, DISPATCH_SCAN_MAX - scanned)
    const page = await storage.scan({
      prefix: "operations/",
      ...(after ? { after } : {}),
      limit,
    })
    const entries = Array.isArray(page?.entries) ? page.entries : []
    for (const entry of entries) {
      scanned += 1
      const raw = entry?.value
      if (!raw || typeof raw !== "object") continue
      if ((raw as Record<string, unknown>).sessionID !== sessionID) continue
      const summary = summarizeDispatch(raw)
      if (summary && (!latest || newer(summary, latest))) latest = summary
    }

    const next = typeof page?.next === "string" && page.next && page.next !== after ? page.next : undefined
    if (!next || entries.length === 0) {
      exhausted = true
      break
    }
    after = next
  }

  let legacy = false
  if (!latest && typeof storage.get === "function") {
    const record = await storage.get(`sessions/${sessionID}`)
    legacy = record !== null && record !== undefined
  }

  return {
    sessionID,
    coverage: exhausted ? "complete" : "limited",
    reason: latest ? "recorded" : legacy ? "legacy" : "none",
    operation: latest,
    scanned,
  }
}
