import type { MessageListInput, SessionInfo, SessionListInput, SessionMessageInfo } from "@opencode/client"
import { hasGangwayMarker } from "./tui-helpers"

// Historical Gangway usage for the panel's Usage page (gangway-26r).
//
// Everything in this module is side-effect free and testable without Solid or a
// live server: range windows, per-assistant-step extraction, deduplication,
// aggregation and bounded paging. The TUI component in `tui-usage-page.tsx`
// owns only rendering, debouncing and stale-result guards.
//
// Scope is deliberately narrow: Gangway root sessions only, assistant-step
// usage only. The installed aggregate `session.stats` endpoint filters by
// date/project but cannot filter by the Gangway marker, so this page derives
// Gangway-only data from `session.list` + paged assistant messages instead.
// Title-generation, compaction and child-session usage stay out: they are not
// assistant messages in a Gangway root session.

export type UsageRangeDays = 7 | 30
export type UsageScope = "all" | "current"

export const USAGE_RANGES: readonly UsageRangeDays[] = [7, 30]

/** Token fields kept explicit so an unavailable field never becomes zero. */
export interface UsageTokens {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const
export type UsageTokenField = (typeof TOKEN_FIELDS)[number]

export const TOKEN_LABELS: Record<UsageTokenField, string> = {
  input: "in",
  output: "out",
  reasoning: "reason",
  cacheRead: "cache r",
  cacheWrite: "cache w",
}

/** One recorded assistant step. `cost` and each token field may be unavailable. */
export interface UsageRecord {
  readonly sessionID: string
  readonly messageID: string
  readonly created: number
  readonly model: string
  readonly directory: string
  readonly cost?: number
  readonly tokens: UsageTokens
}

export interface UsageWindow {
  readonly days: UsageRangeDays
  /** Inclusive local-midnight boundary. */
  readonly start: number
  /** Exclusive local-midnight boundary (tomorrow). */
  readonly end: number
  /** Minutes east of UTC at the window start, for display/debug only. */
  readonly timezoneOffsetMinutes: number
}

export interface UsageDay {
  readonly key: string
  readonly label: string
  readonly start: number
  readonly cost?: number
  readonly tokens: UsageTokens
  readonly totalTokens?: number
  readonly steps: number
  readonly measuredCostSteps: number
  readonly measuredTokenSteps: number
}

export interface UsageBreakdown {
  readonly key: string
  readonly label: string
  readonly cost?: number
  readonly tokens: UsageTokens
  readonly totalTokens?: number
  readonly steps: number
}

export interface UsageCoverage {
  /** True whenever any page cap, failure or unresolved attribution was hit. */
  readonly partial: boolean
  readonly reasons: readonly string[]
  readonly scannedSessions: number
  readonly matchedSessions: number
  readonly skippedSessions: number
  readonly failedSessions: number
  readonly cappedSessions: number
  readonly sessionPages: number
  readonly messagePages: number
}

export interface UsageTotals {
  readonly cost?: number
  readonly tokens: UsageTokens
  readonly totalTokens?: number
  readonly steps: number
  readonly measuredCostSteps: number
  readonly measuredTokenSteps: number
}

export interface UsageSummary {
  readonly range: UsageRangeDays
  readonly scope: UsageScope
  readonly directory?: string
  readonly window: UsageWindow
  readonly generatedAt: number
  readonly totals: UsageTotals
  readonly days: readonly UsageDay[]
  readonly models: readonly UsageBreakdown[]
  readonly directories: readonly UsageBreakdown[]
  readonly coverage: UsageCoverage
}

export interface UsageCaps {
  readonly sessionPageSize: number
  readonly messagePageSize: number
  readonly maxSessionPages: number
  readonly maxMessagePages: number
  readonly concurrency: number
}

/**
 * Bounded on-open work. A session history longer than these caps is still
 * reported, but `coverage.partial` says its subtotals are not full coverage.
 */
export const DEFAULT_USAGE_CAPS: UsageCaps = {
  sessionPageSize: 100,
  messagePageSize: 100,
  maxSessionPages: 10,
  maxMessagePages: 20,
  concurrency: 4,
}

export interface UsageClient {
  session: {
    list(
      input: SessionListInput,
      requestOptions?: { readonly signal?: AbortSignal },
    ): Promise<{ readonly data: SessionInfo[]; readonly cursor?: { readonly next?: string | null } }>
    /** Optional but lets fork boundaries resolve without scanning inherited history. */
    message?: {
      get(
        input: { readonly sessionID: string; readonly messageID: string },
        requestOptions?: { readonly signal?: AbortSignal },
      ): Promise<{ readonly time?: { readonly created?: number } }>
    }
  }
  message: {
    list(
      input: MessageListInput,
      requestOptions?: { readonly signal?: AbortSignal },
    ): Promise<{ readonly data: SessionMessageInfo[]; readonly cursor?: { readonly next?: string | null } }>
  }
}

/** Structural session shape accepted by the pure helpers and fake clients. */
export interface UsageSession {
  readonly id: string
  readonly parentID?: string
  readonly fork?: {
    readonly sessionID: string
    readonly boundary: { readonly type: "before" | "through"; readonly messageID: string }
  }
  readonly time: { readonly created: number; readonly updated: number }
  readonly title?: string | null
  readonly metadata?: Record<string, unknown> | null
  readonly location?: { readonly directory?: string } | null
}

/** Structural assistant-message shape accepted by the pure helpers. */
export interface UsageMessage {
  readonly id: string
  readonly type: string
  readonly time?: { readonly created?: number }
  readonly model?: { readonly id?: string; readonly providerID?: string; readonly variant?: string }
  readonly cost?: number
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly reasoning?: number
    readonly cache?: { readonly read?: number; readonly write?: number }
  }
}

export class UsageAbortedError extends Error {
  constructor() {
    super("usage load aborted")
    this.name = "UsageAbortedError"
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function numberOrUndefined(value: unknown): number | undefined {
  return finite(value) ? value : undefined
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UsageAbortedError()
}

/** Local midnight for the calendar day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Half-open local-time window: `[start, end)` covers today plus the previous
 * `days - 1` calendar days. `end` is the next local midnight, so a step at
 * exactly midnight belongs to the new day, never to both.
 */
export function usageWindow(now: number, days: UsageRangeDays): UsageWindow {
  const endDate = new Date(now)
  endDate.setHours(0, 0, 0, 0)
  endDate.setDate(endDate.getDate() + 1)
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - days)
  const start = startDate.getTime()
  return {
    days,
    start,
    end: endDate.getTime(),
    timezoneOffsetMinutes: new Date(now).getTimezoneOffset(),
  }
}

export function localDayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function localDayLabel(ms: number): string {
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function localDayLabels(window: UsageWindow): UsageDay[] {
  const days: UsageDay[] = []
  const cursor = new Date(window.start)
  cursor.setHours(0, 0, 0, 0)
  for (let index = 0; index < window.days; index += 1) {
    const start = cursor.getTime()
    days.push({
      key: localDayKey(start),
      label: localDayLabel(start),
      start,
      tokens: {},
      steps: 0,
      measuredCostSteps: 0,
      measuredTokenSteps: 0,
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export function isInUsageWindow(created: number, window: UsageWindow): boolean {
  return created >= window.start && created < window.end
}

function extractTokens(tokens: UsageMessage["tokens"]): UsageTokens {
  const result: UsageTokens = {}
  const input = numberOrUndefined(tokens?.input)
  if (input !== undefined) result.input = input
  const output = numberOrUndefined(tokens?.output)
  if (output !== undefined) result.output = output
  const reasoning = numberOrUndefined(tokens?.reasoning)
  if (reasoning !== undefined) result.reasoning = reasoning
  const cacheRead = numberOrUndefined(tokens?.cache?.read)
  if (cacheRead !== undefined) result.cacheRead = cacheRead
  const cacheWrite = numberOrUndefined(tokens?.cache?.write)
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite
  return result
}

export function modelLabel(model: UsageMessage["model"]): string {
  const id = model?.id
  if (!id) return "unavailable"
  const provider = model?.providerID
  // Provider helps distinguish same-named local/remote models in the breakdown.
  return provider ? `${provider}/${id}` : id
}

/**
 * Extract one assistant step's recorded usage. Unavailable measurements stay
 * absent; explicit zeros stay zero. Records outside the half-open window are
 * dropped so raw messages never need to be retained.
 */
export function extractUsageRecord(
  raw: UsageMessage,
  session: UsageSession,
  window: UsageWindow,
): UsageRecord | undefined {
  if (raw.type !== "assistant") return undefined
  const created = numberOrUndefined(raw.time?.created)
  if (created === undefined || !isInUsageWindow(created, window)) return undefined
  const messageID = raw.id
  if (!messageID) return undefined
  return {
    sessionID: session.id,
    messageID,
    created,
    model: modelLabel(raw.model),
    directory: session.location?.directory ?? "unavailable",
    cost: numberOrUndefined(raw.cost),
    tokens: extractTokens(raw.tokens),
  }
}

export function sumKnownTokens(tokens: UsageTokens): number | undefined {
  let total: number | undefined
  for (const field of TOKEN_FIELDS) {
    const value = tokens[field]
    if (value === undefined) continue
    total = (total ?? 0) + value
  }
  return total
}

interface Accumulator {
  cost?: number
  tokens: UsageTokens
  steps: number
  measuredCostSteps: number
  measuredTokenSteps: number
}

function emptyAccumulator(): Accumulator {
  return { tokens: {}, steps: 0, measuredCostSteps: 0, measuredTokenSteps: 0 }
}

function addRecord(target: Accumulator, record: UsageRecord): void {
  target.steps += 1
  if (record.cost !== undefined) {
    target.cost = (target.cost ?? 0) + record.cost
    target.measuredCostSteps += 1
  }
  let measuredTokens = false
  for (const field of TOKEN_FIELDS) {
    const value = record.tokens[field]
    if (value === undefined) continue
    target.tokens[field] = (target.tokens[field] ?? 0) + value
    measuredTokens = true
  }
  if (measuredTokens) target.measuredTokenSteps += 1
}

function finalizeTotals(target: Accumulator): UsageTotals {
  return {
    cost: target.cost,
    tokens: { ...target.tokens },
    totalTokens: sumKnownTokens(target.tokens),
    steps: target.steps,
    measuredCostSteps: target.measuredCostSteps,
    measuredTokenSteps: target.measuredTokenSteps,
  }
}

function breakdown(target: Accumulator, key: string): UsageBreakdown {
  return {
    key,
    label: key,
    cost: target.cost,
    tokens: { ...target.tokens },
    totalTokens: sumKnownTokens(target.tokens),
    steps: target.steps,
  }
}

function compareBreakdown(left: UsageBreakdown, right: UsageBreakdown): number {
  const costDelta = (right.cost ?? -1) - (left.cost ?? -1)
  if (costDelta !== 0) return costDelta
  const tokenDelta = (right.totalTokens ?? -1) - (left.totalTokens ?? -1)
  if (tokenDelta !== 0) return tokenDelta
  return left.key.localeCompare(right.key)
}

/**
 * Deduplicate and aggregate extracted records.
 *
 * The canonical key is session ID + message ID, so overlapping cursors and a
 * root listed twice never inflate totals. A message ID repeated under another
 * session (inherited fork history) is also counted once, regardless of which
 * session is scanned first.
 */
export function aggregateUsage(
  records: readonly UsageRecord[],
  options: {
    readonly range: UsageRangeDays
    readonly scope: UsageScope
    readonly directory?: string
    readonly window: UsageWindow
    readonly now?: number
    readonly coverage?: Partial<UsageCoverage>
  },
): UsageSummary {
  const window = options.window
  const totalsAccumulator = emptyAccumulator()
  const dayMap = new Map<string, Accumulator>()
  for (const day of localDayLabels(window)) dayMap.set(day.key, emptyAccumulator())
  const modelMap = new Map<string, Accumulator>()
  const directoryMap = new Map<string, Accumulator>()
  const seenKeys = new Set<string>()
  const seenMessageIDs = new Set<string>()

  for (const record of records) {
    if (!isInUsageWindow(record.created, window)) continue
    const key = `${record.sessionID}\u0000${record.messageID}`
    if (seenKeys.has(key)) continue
    // A message ID is globally unique; seeing it under a second session means
    // inherited fork history or a duplicated root. Count the first occurrence.
    if (seenMessageIDs.has(record.messageID)) continue
    seenKeys.add(key)
    seenMessageIDs.add(record.messageID)

    addRecord(totalsAccumulator, record)
    const dayKey = localDayKey(record.created)
    let day = dayMap.get(dayKey)
    if (!day) {
      day = emptyAccumulator()
      dayMap.set(dayKey, day)
    }
    addRecord(day, record)

    let model = modelMap.get(record.model)
    if (!model) {
      model = emptyAccumulator()
      modelMap.set(record.model, model)
    }
    addRecord(model, record)

    let directory = directoryMap.get(record.directory)
    if (!directory) {
      directory = emptyAccumulator()
      directoryMap.set(record.directory, directory)
    }
    addRecord(directory, record)
  }

  const dayTotals = new Map<string, UsageTotals>()
  for (const [key, accumulator] of dayMap) dayTotals.set(key, finalizeTotals(accumulator))
  const days = localDayLabels(window).map((day) => {
    const total = dayTotals.get(day.key) ?? finalizeTotals(emptyAccumulator())
    return {
      ...day,
      cost: total.cost,
      tokens: total.tokens,
      totalTokens: total.totalTokens,
      steps: total.steps,
      measuredCostSteps: total.measuredCostSteps,
      measuredTokenSteps: total.measuredTokenSteps,
    }
  })

  const models = [...modelMap.entries()]
    .map(([key, accumulator]) => breakdown(accumulator, key))
    .sort(compareBreakdown)
  const directories = [...directoryMap.entries()]
    .map(([key, accumulator]) => breakdown(accumulator, key))
    .sort(compareBreakdown)

  const coverage = coverageFor(options.coverage)
  return {
    range: options.range,
    scope: options.scope,
    directory: options.directory,
    window,
    generatedAt: options.now ?? Date.now(),
    totals: finalizeTotals(totalsAccumulator),
    days,
    models,
    directories,
    coverage,
  }
}

function coverageFor(input: Partial<UsageCoverage> | undefined): UsageCoverage {
  const reasons = [...new Set(input?.reasons ?? [])]
  return {
    partial: input?.partial ?? reasons.length > 0,
    reasons,
    scannedSessions: input?.scannedSessions ?? 0,
    matchedSessions: input?.matchedSessions ?? 0,
    skippedSessions: input?.skippedSessions ?? 0,
    failedSessions: input?.failedSessions ?? 0,
    cappedSessions: input?.cappedSessions ?? 0,
    sessionPages: input?.sessionPages ?? 0,
    messagePages: input?.messagePages ?? 0,
  }
}

// ── loader ─────────────────────────────────────────────────────────────────

export interface LoadUsageOptions {
  readonly client: UsageClient
  readonly range: UsageRangeDays
  readonly scope: UsageScope
  /** Required for `scope: "current"`; absent means an empty current scope. */
  readonly directory?: string
  readonly now?: number
  readonly caps?: Partial<UsageCaps>
  readonly signal?: AbortSignal
  readonly cache?: UsageCache
  readonly cacheTTL?: number
  readonly force?: boolean
  readonly onProgress?: (progress: UsageProgress) => void
}

export interface UsageProgress {
  readonly scannedSessions: number
  readonly totalSessions: number
  readonly messagePages: number
}

interface SessionScan {
  readonly sessions: UsageSession[]
  readonly skippedSessions: number
  readonly failed: boolean
  readonly capped: boolean
  readonly partial: boolean
  readonly pages: number
  readonly cutoffApplied: boolean
  readonly reason?: string
}

interface MessageScan {
  readonly session: UsageSession
  readonly records: UsageRecord[]
  readonly failed: boolean
  readonly capped: boolean
  readonly forkUnverified: boolean
  readonly pages: number
}

function isAbortError(error: unknown): boolean {
  return error instanceof UsageAbortedError
}

async function scanSessions(options: {
  client: UsageClient
  window: UsageWindow
  scope: UsageScope
  directory?: string
  caps: UsageCaps
  signal?: AbortSignal
}): Promise<SessionScan> {
  const { client, window, scope, directory, caps, signal } = options
  const sessions: UsageSession[] = []
  const seen = new Set<string>()
  let skippedSessions = 0
  let failed = false
  let capped = false
  let pages = 0
  let cursor: string | undefined
  let monotonic = true
  let lastUpdated = Number.POSITIVE_INFINITY

  while (true) {
    checkAbort(signal)
    let response: Awaited<ReturnType<UsageClient["session"]["list"]>>
    try {
      // Newest-first cursor. `parentID: null` requests roots; the marker and
      // parent checks below stay authoritative in case a host ignores it.
      response = await client.session.list(
        {
          parentID: null,
          limit: caps.sessionPageSize,
          order: "desc",
          ...(cursor === undefined ? {} : { cursor }),
          ...(scope === "current" ? { directory: directory ?? "" } : {}),
        },
        { signal },
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      failed = true
      break
    }
    pages += 1
    const data = response?.data ?? []

    for (const item of data) {
      const session = item as unknown as UsageSession
      const updated = numberOrUndefined(session.time?.updated)
      if (updated !== undefined) {
        if (updated > lastUpdated) monotonic = false
        lastUpdated = updated
      }
      if (seen.has(session.id)) continue
      seen.add(session.id)
      if (session.parentID) continue
      if (!hasGangwayMarker(session)) continue
      if (scope === "current" && session.location?.directory !== directory) continue
      // A session created before the window still qualifies when it was
      // updated inside it; older updates cannot own newer assistant steps.
      if (updated === undefined || updated < window.start) {
        skippedSessions += 1
        continue
      }
      sessions.push(session)
    }

    const next = response?.cursor?.next ?? undefined
    if (!next) break

    // Early cutoff is safe only after the stream has shown monotonic
    // newest-first ordering across at least two pages.
    const allOlder = data.length > 0 && data.every((item) => (item.time?.updated ?? 0) < window.start)
    if (monotonic && pages >= 2 && allOlder) {
      return {
        sessions,
        skippedSessions,
        failed,
        capped,
        partial: false,
        pages,
        cutoffApplied: true,
      }
    }

    if (pages >= caps.maxSessionPages) {
      capped = true
      break
    }
    cursor = next
  }

  const reasons: string[] = []
  if (failed) reasons.push("session-list-failed")
  if (capped) reasons.push("session-page-cap")
  return {
    sessions,
    skippedSessions,
    failed,
    capped,
    partial: reasons.length > 0,
    pages,
    cutoffApplied: false,
    reason: reasons.join(",") || undefined,
  }
}

async function resolveBoundary(
  client: UsageClient,
  session: UsageSession,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const fork = session.fork
  if (!fork) return undefined
  const get = client.session.message?.get
  if (!get) return undefined
  try {
    const message = await get(
      { sessionID: fork.sessionID, messageID: fork.boundary.messageID },
      { signal },
    )
    return numberOrUndefined(message?.time?.created)
  } catch (error) {
    if (isAbortError(error)) throw error
    return undefined
  }
}

async function scanMessages(options: {
  client: UsageClient
  session: UsageSession
  window: UsageWindow
  caps: UsageCaps
  signal?: AbortSignal
}): Promise<MessageScan> {
  const { client, session, window, caps, signal } = options
  const records: UsageRecord[] = []
  const seen = new Set<string>()
  let pages = 0
  let cursor: string | undefined
  let failed = false
  let capped = false
  let monotonic = true
  let lastCreated = Number.POSITIVE_INFINITY
  let forkUnverified = false
  let boundaryCreated = await resolveBoundary(client, session, signal)
  const boundaryID = session.fork?.boundary.messageID

  while (true) {
    checkAbort(signal)
    let response: Awaited<ReturnType<UsageClient["message"]["list"]>>
    try {
      response = await client.message.list(
        {
          sessionID: session.id,
          limit: caps.messagePageSize,
          order: "desc",
          type: "assistant",
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal },
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      failed = true
      break
    }
    pages += 1
    const data = response?.data ?? []

    for (const item of data) {
      const raw = item as unknown as UsageMessage
      const created = numberOrUndefined(raw.time?.created)
      if (created !== undefined) {
        if (created > lastCreated) monotonic = false
        lastCreated = created
      }
      if (raw.type !== "assistant") continue
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      if (boundaryID !== undefined && raw.id === boundaryID && created !== undefined) {
        boundaryCreated = created
      }
      const record = extractUsageRecord(raw, session, window)
      if (!record) continue
      records.push(record)
    }

    const next = response?.cursor?.next ?? undefined
    if (!next) break

    const allOlder = data.length > 0 && data.every((item) => (item.time?.created ?? 0) < window.start)
    if (monotonic && pages >= 2 && allOlder) break

    if (pages >= caps.maxMessagePages) {
      capped = true
      break
    }
    cursor = next
  }

  // Inherited fork history is anything at or before the fork boundary.
  // Resolve the boundary message's timestamp when possible; otherwise the
  // report is marked partial so fork attribution cannot read as complete.
  if (session.fork) {
    if (boundaryCreated === undefined) forkUnverified = true
    else {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index].created <= boundaryCreated) records.splice(index, 1)
      }
    }
  }

  return { session, records, failed, capped, forkUnverified, pages }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** Deterministic merge order: older root first, non-forks before forks. */
function compareSessions(left: UsageSession, right: UsageSession): number {
  const createdDelta = left.time.created - right.time.created
  if (createdDelta !== 0) return createdDelta
  const forkDelta = Number(Boolean(left.fork)) - Number(Boolean(right.fork))
  if (forkDelta !== 0) return forkDelta
  return left.id.localeCompare(right.id)
}

export async function loadUsage(options: LoadUsageOptions): Promise<UsageSummary> {
  const now = options.now ?? Date.now()
  const window = usageWindow(now, options.range)
  const cacheKey = usageCacheKey(options.range, options.scope, options.directory, window)
  if (!options.force) {
    const cached = options.cache?.get(cacheKey, now)
    if (cached) return cached
  }

  const caps: UsageCaps = { ...DEFAULT_USAGE_CAPS, ...options.caps }
  const reasons = new Set<string>()
  if (options.scope === "current" && !options.directory) reasons.add("no-directory-scope")

  const sessionScan = await scanSessions({
    client: options.client,
    window,
    scope: options.scope,
    directory: options.directory,
    caps,
    signal: options.signal,
  })
  if (sessionScan.reason) for (const reason of sessionScan.reason.split(",")) reasons.add(reason)
  options.onProgress?.({
    scannedSessions: 0,
    totalSessions: sessionScan.sessions.length,
    messagePages: 0,
  })

  let scannedSessions = 0
  let messagePages = 0
  let failedSessions = sessionScan.failed ? 1 : 0
  let cappedSessions = sessionScan.capped ? 1 : 0
  let matchedSessions = 0
  let forkUnverified = false

  const scans = await mapLimit(sessionScan.sessions.slice().sort(compareSessions), caps.concurrency, async (session) => {
    const scan = await scanMessages({
      client: options.client,
      session,
      window,
      caps,
      signal: options.signal,
    })
    scannedSessions += 1
    messagePages += scan.pages
    if (scan.failed) {
      failedSessions += 1
      reasons.add("message-list-failed")
    }
    if (scan.capped) {
      cappedSessions += 1
      reasons.add("message-page-cap")
    }
    if (scan.forkUnverified) {
      forkUnverified = true
      reasons.add("fork-history-unverified")
    }
    if (scan.records.length > 0) matchedSessions += 1
    options.onProgress?.({ scannedSessions, totalSessions: sessionScan.sessions.length, messagePages })
    return scan
  })

  // Merge in the deterministic session order, then dedupe by session+message
  // and globally by message ID. Raw messages are dropped with each scan.
  const records: UsageRecord[] = []
  const seenKeys = new Set<string>()
  const seenMessageIDs = new Set<string>()
  for (const scan of scans) {
    for (const record of scan.records) {
      const key = `${record.sessionID}\u0000${record.messageID}`
      if (seenKeys.has(key) || seenMessageIDs.has(record.messageID)) continue
      seenKeys.add(key)
      seenMessageIDs.add(record.messageID)
      records.push(record)
    }
  }

  const summary = aggregateUsage(records, {
    range: options.range,
    scope: options.scope,
    directory: options.directory,
    window,
    now,
    coverage: {
      partial: reasons.size > 0 || forkUnverified,
      reasons: [...reasons],
      scannedSessions,
      matchedSessions,
      skippedSessions: sessionScan.skippedSessions,
      failedSessions,
      cappedSessions,
      sessionPages: sessionScan.pages,
      messagePages,
    },
  })

  // Cache only complete scans; partial data is retried on revisit so a cap or
  // transient failure cannot be mistaken for settled coverage.
  if (!summary.coverage.partial) {
    options.cache?.set(cacheKey, summary, now, options.cacheTTL)
  }
  return summary
}

export function usageCacheKey(
  range: UsageRangeDays,
  scope: UsageScope,
  directory: string | undefined,
  window: UsageWindow,
): string {
  return `${range}|${scope}|${directory ?? ""}|${window.start}|${window.end}`
}

export class UsageCache {
  private readonly entries = new Map<string, { summary: UsageSummary; expires: number }>()

  get(key: string, now: number): UsageSummary | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.summary
  }

  set(key: string, summary: UsageSummary, now: number, ttl = 5 * 60_000): void {
    this.entries.set(key, { summary, expires: now + ttl })
  }

  clear(): void {
    this.entries.clear()
  }
}

// ── formatting (pure so narrow-terminal rules stay testable) ───────────────

export function formatCost(value: number | undefined): string {
  if (value === undefined) return "—"
  if (value === 0) return "$0.00"
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function formatNumber(value: number | undefined): string {
  if (value === undefined) return "—"
  return value.toLocaleString("en-US")
}

export function formatTokenFields(tokens: UsageTokens): string {
  return TOKEN_FIELDS.map((field) => `${TOKEN_LABELS[field]} ${formatNumber(tokens[field])}`).join(" · ")
}

/** Filled cells for a value; `0` stays empty, unavailable stays empty. */
export function usageBar(value: number | undefined, max: number | undefined, width: number): string {
  if (value === undefined || max === undefined || max <= 0 || width <= 0 || value <= 0) return ""
  const cells = Math.max(1, Math.min(width, Math.round((value / max) * width)))
  return "█".repeat(cells)
}
