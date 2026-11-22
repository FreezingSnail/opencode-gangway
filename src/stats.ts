import type { SessionInfo } from "@opencode/client"
import { formatAge, isGangwaySession } from "./tui-helpers"

// Pure aggregation for the Gangway Stats page. Everything here is
// side-effect free: the TUI feeds the shared session store plus the timestamps
// it observed from live events, and this module derives the mutually exclusive
// live buckets, directory breakdown, oldest waits, longest runs and the recent
// terminal-outcome window. No transcript is fetched here.

export const DAY_MS = 24 * 60 * 60 * 1000

export type LiveBucket = "permission" | "question" | "running" | "idle"

export const LIVE_BUCKETS: readonly LiveBucket[] = ["permission", "question", "running", "idle"]

export const LIVE_BUCKET_LABELS: Record<LiveBucket, string> = {
  permission: "Permission",
  question: "Question",
  running: "Running",
  idle: "Idle",
}

export type StatsAttentionKind = "permission" | "question"

export type StatsOutcome = "succeeded" | "failed" | "interrupted"

export const STATS_OUTCOMES: readonly StatsOutcome[] = ["succeeded", "failed", "interrupted"]

export const STATS_OUTCOME_LABELS: Record<StatsOutcome, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  interrupted: "Interrupted",
}

export type StatsScope = "all" | "current"

/**
 * A timestamp this TUI can defend. `event` came from a live permission, form
 * or execution-start event. `first-seen` is the fallback used when no event
 * was observed; the UI must label it as this TUI's first sighting, never as
 * the session's creation or last-update time.
 */
export interface ObservedAt {
  readonly at: number
  readonly source: "event" | "first-seen"
}

export interface StatsSessionInput {
  readonly session: SessionInfo
  readonly running: boolean
  /** Permission wins over question; both win over running and idle. */
  readonly attention?: StatsAttentionKind
  /** False when either permission or form data is unsynced. */
  readonly attentionKnown: boolean
  /** Oldest observed prompt timestamp for this session's pending prompts. */
  readonly wait?: ObservedAt
  /** Execution-start timestamp for a live run. */
  readonly run?: ObservedAt
}

export interface StatsSession {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly bucket: LiveBucket
  readonly attentionKnown: boolean
  readonly wait?: ObservedAt
  readonly run?: ObservedAt
  readonly outcome?: StatsOutcome
  readonly idleAt?: number
}

export interface StatsBucketRow {
  readonly bucket: LiveBucket
  readonly label: string
  readonly count: number
  readonly sessions: readonly StatsSession[]
}

export interface StatsDirectoryRow {
  readonly directory: string
  readonly total: number
  readonly counts: Readonly<Record<LiveBucket, number>>
  readonly sessions: readonly StatsSession[]
}

export interface StatsOutcomeRow {
  readonly outcome: StatsOutcome
  readonly label: string
  readonly count: number
  readonly sessions: readonly StatsSession[]
}

export interface StatsSnapshot {
  readonly now: number
  readonly scope: StatsScope
  readonly scopeDirectory?: string
  readonly scopeLabel: string
  readonly historyNote: string
  readonly total: number
  readonly buckets: readonly StatsBucketRow[]
  readonly directories: readonly StatsDirectoryRow[]
  readonly recent: readonly StatsOutcomeRow[]
  readonly waits: readonly StatsSession[]
  readonly active: readonly StatsSession[]
  /** Sessions whose attention queues are not fully synced. */
  readonly unsynced: number
}

export type StatsFilter =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "bucket"; readonly bucket: LiveBucket }
  | { readonly kind: "outcome"; readonly outcome: StatsOutcome }

export interface StatsDrilldown {
  readonly filter: StatsFilter
  readonly title: string
  readonly scopeLabel: string
  readonly count: number
  readonly sessions: readonly StatsSession[]
}

export interface StatsBuildInput {
  readonly sessions: readonly StatsSessionInput[]
  readonly now: number
  readonly scope?: StatsScope
  readonly currentDirectory?: string
  readonly historyLimit?: number
}

function bucketRank(bucket: LiveBucket): number {
  return LIVE_BUCKETS.indexOf(bucket)
}

/** Four mutually exclusive live buckets; attention outranks running. */
export function liveBucket(running: boolean, attention?: StatsAttentionKind): LiveBucket {
  if (attention === "permission") return "permission"
  if (attention === "question") return "question"
  return running ? "running" : "idle"
}

/**
 * A timestamp is inside the recent window when it is known, not in the future,
 * and no more than 24 hours old. Exactly 24 hours old is outside the window.
 */
export function inRecentWindow(idleAt: number | undefined, now: number): boolean {
  return (
    typeof idleAt === "number" &&
    Number.isFinite(idleAt) &&
    idleAt <= now &&
    idleAt > now - DAY_MS
  )
}

function usable(observed: ObservedAt | undefined): ObservedAt | undefined {
  if (!observed) return undefined
  if (!Number.isFinite(observed.at) || observed.at <= 0) return undefined
  return observed
}

function scopeLabel(scope: StatsScope, currentDirectory: string | undefined): string {
  if (scope === "all") return "all directories"
  return currentDirectory ? "current directory" : "current directory (unknown)"
}

function historyNote(limit: number | undefined): string {
  return limit === undefined || limit <= 0
    ? "Loaded history: whatever the shared store holds"
    : `Loaded history: latest ${limit} sessions`
}

function waitComparator(a: StatsSession, b: StatsSession): number {
  // Known timestamps first, oldest first. Unknown waits stay visible last.
  if (a.wait && b.wait) return a.wait.at - b.wait.at || a.id.localeCompare(b.id)
  if (a.wait) return -1
  if (b.wait) return 1
  return a.id.localeCompare(b.id)
}

function runComparator(a: StatsSession, b: StatsSession): number {
  // Earliest start means longest run, so ascending start time.
  if (a.run && b.run) return a.run.at - b.run.at || a.id.localeCompare(b.id)
  if (a.run) return -1
  if (b.run) return 1
  return a.id.localeCompare(b.id)
}

function idleComparator(a: StatsSession, b: StatsSession): number {
  return (b.idleAt ?? 0) - (a.idleAt ?? 0) || a.id.localeCompare(b.id)
}

function sessionComparator(a: StatsSession, b: StatsSession): number {
  const rank = bucketRank(a.bucket) - bucketRank(b.bucket)
  if (rank !== 0) return rank
  if (a.bucket === "permission" || a.bucket === "question") return waitComparator(a, b)
  if (a.bucket === "running") return runComparator(a, b)
  return idleComparator(a, b)
}

/** Derive the whole Stats view from one live store snapshot. */
export function buildStatsSnapshot(input: StatsBuildInput): StatsSnapshot {
  const scope = input.scope ?? "all"
  const currentDirectory = input.currentDirectory
  const now = input.now
  const scoped: StatsSession[] = []

  for (const item of input.sessions) {
    const session = item.session
    // Match the panel: Gangway roots only, including legacy markers, and no
    // child/subagent sessions.
    if (!isGangwaySession(session) || session.parentID) continue
    if (scope === "current" && (!currentDirectory || session.location.directory !== currentDirectory)) {
      continue
    }
    const bucket = liveBucket(item.running, item.attention)
    const idleAt = typeof session.time?.idle === "number" ? session.time.idle : undefined
    scoped.push({
      id: session.id,
      title: session.title ?? "(untitled)",
      directory: session.location.directory,
      bucket,
      attentionKnown: item.attentionKnown,
      wait: bucket === "permission" || bucket === "question" ? usable(item.wait) : undefined,
      run: bucket === "running" ? usable(item.run) : undefined,
      outcome: session.outcome,
      idleAt,
    })
  }

  const buckets: StatsBucketRow[] = LIVE_BUCKETS.map((bucket) => {
    const sessions = scoped.filter((session) => session.bucket === bucket)
    return { bucket, label: LIVE_BUCKET_LABELS[bucket], count: sessions.length, sessions }
  })

  const directoryMap = new Map<string, StatsSession[]>()
  for (const session of scoped) {
    const list = directoryMap.get(session.directory)
    if (list) list.push(session)
    else directoryMap.set(session.directory, [session])
  }
  const directories: StatsDirectoryRow[] = [...directoryMap.entries()]
    .map(([directory, sessions]) => {
      const counts: Record<LiveBucket, number> = { permission: 0, question: 0, running: 0, idle: 0 }
      for (const session of sessions) counts[session.bucket] += 1
      return {
        directory,
        total: sessions.length,
        counts,
        sessions: [...sessions].sort(sessionComparator),
      }
    })
    .sort((a, b) => b.total - a.total || a.directory.localeCompare(b.directory))

  const recentBuckets = new Map<StatsOutcome, StatsSession[]>(
    STATS_OUTCOMES.map((outcome) => [outcome, [] as StatsSession[]]),
  )
  for (const session of scoped) {
    // Live state and recorded outcome are separate. Only a session that is
    // genuinely idle, with authoritative attention data, a terminal outcome
    // and a known past idle time belongs in the recent window.
    if (session.bucket !== "idle" || !session.attentionKnown) continue
    if (session.outcome === undefined) continue
    if (!inRecentWindow(session.idleAt, now)) continue
    recentBuckets.get(session.outcome)?.push(session)
  }
  const recent: StatsOutcomeRow[] = STATS_OUTCOMES.map((outcome) => {
    const sessions = (recentBuckets.get(outcome) ?? []).sort(idleComparator)
    return { outcome, label: STATS_OUTCOME_LABELS[outcome], count: sessions.length, sessions }
  })

  const waits = scoped
    .filter((session) => session.bucket === "permission" || session.bucket === "question")
    .sort(waitComparator)
  const active = scoped.filter((session) => session.bucket === "running").sort(runComparator)
  const unsynced = scoped.filter((session) => !session.attentionKnown).length

  return {
    now,
    scope,
    ...(currentDirectory === undefined ? {} : { scopeDirectory: currentDirectory }),
    scopeLabel: scopeLabel(scope, currentDirectory),
    historyNote: historyNote(input.historyLimit),
    total: scoped.length,
    buckets,
    directories,
    recent,
    waits,
    active,
    unsynced,
  }
}

/** Human age for an observed timestamp, with the first-sighting fallback named. */
export function observedAgeLabel(observed: ObservedAt | undefined, now: number): string {
  if (!usable(observed)) return "unknown"
  const age = formatAge(observed.at, now)
  const text = age === "now" ? "just now" : `${age} ago`
  return observed.source === "first-seen" ? `first seen ${text}` : text
}

/** Rows addressed by a directory, live bucket or terminal outcome. */
export function drilldown(snapshot: StatsSnapshot, filter: StatsFilter): StatsDrilldown {
  if (filter.kind === "directory") {
    const row = snapshot.directories.find((directory) => directory.directory === filter.directory)
    return {
      filter,
      title: `Directory · ${filter.directory}`,
      scopeLabel: snapshot.scopeLabel,
      count: row?.total ?? 0,
      sessions: row?.sessions ?? [],
    }
  }
  if (filter.kind === "bucket") {
    const row = snapshot.buckets.find((bucket) => bucket.bucket === filter.bucket)
    return {
      filter,
      title: `State · ${row?.label ?? LIVE_BUCKET_LABELS[filter.bucket]}`,
      scopeLabel: snapshot.scopeLabel,
      count: row?.count ?? 0,
      sessions: row?.sessions ?? [],
    }
  }
  const row = snapshot.recent.find((outcome) => outcome.outcome === filter.outcome)
  return {
    filter,
    title: `Outcome · ${row?.label ?? STATS_OUTCOME_LABELS[filter.outcome]}`,
    scopeLabel: `past 24h · ${snapshot.scopeLabel}`,
    count: row?.count ?? 0,
    sessions: row?.sessions ?? [],
  }
}

/** Compact per-directory count cell used by the table and drilldown headers. */
export function bucketCountsLabel(counts: Readonly<Record<LiveBucket, number>>): string {
  return LIVE_BUCKETS.map((bucket) => `${LIVE_BUCKET_LABELS[bucket][0]}${counts[bucket]}`).join(" ")
}
