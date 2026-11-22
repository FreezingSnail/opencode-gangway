import type { FileDiffInfo } from "@opencode/client"
import { sanitizeTerminalText } from "./tui-preview"

// Pure state and projections for the latest-turn changes view. Keep this module
// free of Solid/JSX so the view can be tested without a terminal host.

export const CHANGES_PAGE = "gangway.changes"
export const LATEST_TURN_LABEL = "Latest turn changes"
/** Diff context lines; the endpoint also accepts from/to anchors we do not use. */
export const DIFF_CONTEXT = 3

/** Plugin route pinned to the session whose latest turn is shown. */
export function changesDestination(sessionID: string) {
  return { type: "plugin" as const, name: CHANGES_PAGE, data: { sessionID } }
}

export type ChangeStatus = "added" | "modified" | "deleted" | "unknown"
export type KnownChangeStatus = Exclude<ChangeStatus, "unknown">

export interface FileChange {
  readonly file: string
  readonly patch: string
  readonly additions?: number
  readonly deletions?: number
  readonly status: ChangeStatus
}

export interface ChangesTotals {
  readonly files: number
  readonly added: number
  readonly modified: number
  readonly deleted: number
  readonly unknown: number
  readonly additions: number
  readonly deletions: number
  readonly hasLineCounts: boolean
  readonly lineCountsComplete: boolean
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function knownStatus(value: unknown): ChangeStatus {
  return value === "added" || value === "modified" || value === "deleted" ? value : "unknown"
}

function fileLabel(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "(unknown file)"
}

/**
 * Accept the endpoint's FileDiffInfo array (or an older/partial shape) without
 * trusting optional runtime fields. Missing patches stay empty and missing
 * counts stay unknown so totals can report partial data honestly.
 */
export function normalizeFiles(input: readonly unknown[] | undefined): FileChange[] {
  if (!Array.isArray(input)) return []
  return input.map((entry) => {
    const value = (entry ?? {}) as Partial<FileDiffInfo> & Record<string, unknown>
    return {
      file: fileLabel(value.file),
      patch: typeof value.patch === "string" ? value.patch : "",
      additions: finiteCount(value.additions),
      deletions: finiteCount(value.deletions),
      status: knownStatus(value.status),
    }
  })
}

export function summarizeChanges(files: readonly FileChange[]): ChangesTotals {
  let added = 0
  let modified = 0
  let deleted = 0
  let unknown = 0
  let additions = 0
  let deletions = 0
  let knownAdditions = 0
  let knownDeletions = 0
  for (const file of files) {
    if (file.status === "added") added += 1
    else if (file.status === "modified") modified += 1
    else if (file.status === "deleted") deleted += 1
    else unknown += 1
    if (file.additions !== undefined) {
      additions += file.additions
      knownAdditions += 1
    }
    if (file.deletions !== undefined) {
      deletions += file.deletions
      knownDeletions += 1
    }
  }
  const hasLineCounts = knownAdditions > 0 || knownDeletions > 0
  return {
    files: files.length,
    added,
    modified,
    deleted,
    unknown,
    additions,
    deletions,
    hasLineCounts,
    lineCountsComplete: files.length > 0 && knownAdditions === files.length && knownDeletions === files.length,
  }
}

export function statusMarker(status: ChangeStatus): "A" | "M" | "D" | "?" {
  if (status === "added") return "A"
  if (status === "modified") return "M"
  if (status === "deleted") return "D"
  return "?"
}

export function statusWord(status: ChangeStatus): string {
  return status === "unknown" ? "changed" : status
}

export function formatFileDeltas(file: FileChange): string {
  const parts: string[] = []
  if (file.additions !== undefined) parts.push(`+${file.additions}`)
  if (file.deletions !== undefined) parts.push(`−${file.deletions}`)
  return parts.length > 0 ? parts.join(" ") : "—"
}

export function formatTotals(totals: ChangesTotals): string {
  if (totals.files === 0) return "0 files"
  const noun = totals.files === 1 ? "file" : "files"
  const head = `${totals.files} ${noun} · ${totals.added}A ${totals.modified}M ${totals.deleted}D${totals.unknown > 0 ? ` ${totals.unknown}?` : ""}`
  if (!totals.hasLineCounts) return `${head} · line counts unavailable`
  const partial = totals.lineCountsComplete ? "" : " (partial)"
  return `${head} · +${totals.additions} −${totals.deletions}${partial}`
}

export type ChangesFailureKind =
  | "unsupported"
  | "deleted-worktree"
  | "location-switch"
  | "missing-session"
  | "absent-snapshot"
  | "unreadable"
  | "network"
  | "aborted"
  | "unknown"

export interface ChangesFailure {
  readonly kind: ChangesFailureKind
  readonly message: string
  readonly status?: number
  readonly retryable: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function errorTag(error: unknown): string | undefined {
  const record = asRecord(error)
  const tag = record?._tag ?? record?.tag
  if (typeof tag === "string") return tag
  const name = record?.name
  return typeof name === "string" ? name : undefined
}

function errorStatus(error: unknown): number | undefined {
  const record = asRecord(error)
  if (typeof record?.status === "number") return record.status
  const cause = asRecord(record?.cause)
  if (typeof cause?.status === "number") return cause.status
  const data = asRecord(record?.data)
  if (typeof data?.status === "number") return data.status
  if (typeof record?.statusCode === "number") return record.statusCode
  return undefined
}

function errorMessage(error: unknown): string {
  const record = asRecord(error)
  if (typeof record?.message === "string" && record.message.length > 0) return record.message
  if (typeof error === "string") return error
  return "request failed"
}

function isAbort(error: unknown): boolean {
  const record = asRecord(error)
  return record?.name === "AbortError" || record?.name === "AbortSignal" || record?.code === "ABORT_ERR"
}

export function classifyDiffError(error: unknown): ChangesFailure {
  const tag = errorTag(error)
  const status = errorStatus(error)
  const message = errorMessage(error)
  const text = `${tag ?? ""} ${message}`.toLowerCase()
  const base = { message, status }

  if (isAbort(error)) return { ...base, kind: "aborted", retryable: false }
  if (/spans a location change|location (was )?switched|mixed location/.test(text)) {
    return { ...base, kind: "location-switch", retryable: true }
  }
  if (tag === "MessageNotFoundError" || /no user message|no.*snapshot|message.*not found|turn.*not found/.test(text)) {
    return { ...base, kind: "absent-snapshot", retryable: true }
  }
  if (tag === "SessionNotFoundError" || /session.*not (found|exist)/.test(text)) {
    return { ...base, kind: "missing-session", retryable: false }
  }
  if (
    tag === "LocationNotFoundError" ||
    /location.*not found|worktree.*(missing|deleted|not found|unavailable)|no such.*worktree/.test(text)
  ) {
    return { ...base, kind: "deleted-worktree", retryable: false }
  }
  if (
    tag === "InvalidRequestError" ||
    status === 400 ||
    /unsupported|not supported|cannot diff|diff unavailable/.test(text)
  ) {
    return { ...base, kind: "unsupported", retryable: false }
  }
  if (tag === "UnknownError" || status === 500 || /unreadable|failed to (read|compute)|diff failed/.test(text)) {
    return { ...base, kind: "unreadable", retryable: true }
  }
  if (tag === "ClientError" && /transport|fetch failed/.test(text)) {
    return { ...base, kind: "network", retryable: true }
  }
  if (status === 404) {
    if (/message|snapshot|turn/.test(text)) return { ...base, kind: "absent-snapshot", retryable: true }
    return { ...base, kind: "missing-session", retryable: false }
  }
  return { ...base, kind: "unknown", retryable: true }
}

export function failureLabel(failure: ChangesFailure): string {
  if (failure.kind === "unsupported") return "Diff unavailable: this session's diff is not supported."
  if (failure.kind === "deleted-worktree") return "Session location unavailable: its worktree may have been deleted."
  if (failure.kind === "location-switch") return "This turn spans a session location change; its diff is unavailable."
  if (failure.kind === "missing-session") return "Session no longer available."
  if (failure.kind === "absent-snapshot") return "No latest-turn snapshot is available for this session."
  if (failure.kind === "unreadable") return "The latest-turn diff could not be read."
  if (failure.kind === "network") return "Diff request failed; the connection is unavailable."
  if (failure.kind === "aborted") return "Refresh cancelled."
  return "Latest-turn diff failed."
}

export function failureDetail(failure: ChangesFailure): string {
  return sanitizeTerminalText(failure.message).replace(/\s+/g, " ").trim().slice(0, 300)
}

/**
 * The endpoint resolves the turn containing the latest user message. Prompts
 * sent while a run is busy can share that turn, and a running turn can expose
 * in-progress worktree changes.
 */
export function changesScopeNote(running: boolean): string {
  return running
    ? "Latest turn · prompts sent while busy can share this turn · a running turn may include in-progress worktree changes"
    : "Latest turn · prompts sent while busy can share this turn"
}

export type ChangesPhase = "idle" | "loading" | "ready" | "error"

export interface ChangesState {
  readonly open: boolean
  readonly sessionID?: string
  readonly phase: ChangesPhase
  readonly files: readonly FileChange[]
  readonly totals: ChangesTotals
  readonly loading: boolean
  readonly stale: boolean
  readonly failure?: ChangesFailure
  readonly fetchedAt?: number
  readonly running: boolean
  readonly location?: string
  readonly snapshotDirectory?: string
  readonly locationChanged: boolean
  readonly hasSnapshot: boolean
}

export type ChangesNoticeKind = "loading" | "empty" | "error" | "stale" | "ready" | "closed"

export interface ChangesNotice {
  readonly kind: ChangesNoticeKind
  readonly message: string
}

/** Honest state text: empty results are distinct from unavailable snapshots. */
export function changesNotice(state: ChangesState): ChangesNotice {
  if (!state.open) return { kind: "closed", message: "No session selected." }
  if (state.loading && !state.hasSnapshot) return { kind: "loading", message: "Loading latest turn changes…" }
  if (state.stale && state.failure) {
    const detail = failureDetail(state.failure)
    return {
      kind: "stale",
      message: `Showing the last snapshot; refresh failed: ${failureLabel(state.failure)}${detail ? ` (${detail})` : ""}`,
    }
  }
  if (state.phase === "error" && state.failure) {
    const detail = failureDetail(state.failure)
    return {
      kind: "error",
      message: `${failureLabel(state.failure)}${detail ? ` (${detail})` : ""}`,
    }
  }
  if (state.loading) return { kind: "loading", message: "Refreshing latest turn changes…" }
  if (state.phase === "ready" && state.files.length === 0) {
    return { kind: "empty", message: "No file changes in the latest turn." }
  }
  return { kind: "ready", message: "" }
}

// ---------------------------------------------------------------------------
// Patch display

export type PatchUnavailableReason = "binary" | "patchless"

export interface PatchAvailability {
  readonly available: boolean
  readonly reason?: PatchUnavailableReason
}

export const DEFAULT_PATCH_LINES = 1200
export const DEFAULT_PATCH_CHARS = 160_000
export const DEFAULT_PATCH_LINE_CHARS = 500

export interface PatchBounds {
  readonly maxLines?: number
  readonly maxChars?: number
  readonly maxLineChars?: number
}

export interface PatchDisplay {
  readonly available: boolean
  readonly reason?: PatchUnavailableReason
  readonly lines: readonly string[]
  readonly text: string
  readonly totalLines: number
  readonly shownLines: number
  readonly omittedLines: number
  readonly truncated: boolean
  readonly cue?: string
}

export function patchAvailability(patch: string | undefined): PatchAvailability {
  const value = typeof patch === "string" ? patch : ""
  if (value.trim().length === 0) return { available: false, reason: "patchless" }
  if (value.includes("\u0000") || /^Binary files .* differ$/m.test(value) || /^GIT binary patch$/m.test(value)) {
    return { available: false, reason: "binary" }
  }
  return { available: true }
}

export function patchUnavailableText(reason: PatchUnavailableReason | undefined): string {
  if (reason === "binary") return "No textual patch: this file is binary."
  return "No textual patch for this file."
}

function boundedLine(line: string, maxLineChars: number): { line: string; clipped: boolean } {
  if (line.length <= maxLineChars) return { line, clipped: false }
  return { line: `${line.slice(0, Math.max(1, maxLineChars - 1))}…`, clipped: true }
}

/**
 * Bound a unified patch for terminal rendering. Returns sanitized lines plus
 * an explicit cue when lines, characters or long lines were omitted. Callers
 * can scroll the bounded line array without touching unbounded patch text.
 */
export function boundPatch(patch: string | undefined, bounds: PatchBounds = {}): PatchDisplay {
  const availability = patchAvailability(patch)
  if (!availability.available) {
    return {
      available: false,
      reason: availability.reason,
      lines: [],
      text: "",
      totalLines: 0,
      shownLines: 0,
      omittedLines: 0,
      truncated: false,
    }
  }
  const maxLines = Math.max(1, Math.floor(bounds.maxLines ?? DEFAULT_PATCH_LINES))
  const maxChars = Math.max(2, Math.floor(bounds.maxChars ?? DEFAULT_PATCH_CHARS))
  const maxLineChars = Math.max(2, Math.floor(bounds.maxLineChars ?? DEFAULT_PATCH_LINE_CHARS))
  const all = sanitizeTerminalText(patch!).replace(/\n+$/, "").split("\n")
  const totalLines = all.length
  const kept: string[] = []
  let used = 0
  let longLineClipped = false
  let stoppedAt = all.length
  for (let index = 0; index < all.length; index += 1) {
    const clipped = boundedLine(all[index]!, maxLineChars)
    if (clipped.clipped) longLineClipped = true
    const cost = clipped.line.length + (kept.length === 0 ? 0 : 1)
    if (kept.length >= maxLines || used + cost > maxChars) {
      stoppedAt = index
      break
    }
    kept.push(clipped.line)
    used += cost
  }
  const omittedLines = Math.max(0, totalLines - stoppedAt)
  const truncated = omittedLines > 0 || longLineClipped
  let cue: string | undefined
  if (omittedLines > 0) {
    cue = `… Patch truncated: showing ${stoppedAt} of ${totalLines} lines (${omittedLines} more omitted).`
  } else if (longLineClipped) {
    cue = "… Patch truncated: long lines are clipped for display."
  }
  const lines = cue ? [...kept, cue] : kept
  return {
    available: true,
    lines,
    text: lines.join("\n"),
    totalLines,
    shownLines: kept.length,
    omittedLines,
    truncated,
    cue,
  }
}

export interface PatchWindow {
  readonly start: number
  readonly end: number
  readonly offset: number
  readonly maxOffset: number
  readonly lines: readonly string[]
}

/** Clamp a patch scroll offset to the bounded line array. */
export function patchWindow(lines: readonly string[], offset: number, height: number): PatchWindow {
  const size = Math.max(1, Math.floor(height))
  const maxOffset = Math.max(0, lines.length - size)
  const start = Math.min(Math.max(0, Math.floor(offset)), maxOffset)
  const end = Math.min(lines.length, start + size)
  return { start, end, offset: start, maxOffset, lines: lines.slice(start, end) }
}

/** Render only a window of list rows so large turns stay responsive. */
export function windowAround(index: number, length: number, size: number): { start: number; end: number } {
  if (length <= 0 || size <= 0) return { start: 0, end: 0 }
  if (length <= size) return { start: 0, end: length }
  const half = Math.floor(size / 2)
  const start = Math.min(Math.max(0, index - half), length - size)
  return { start, end: start + size }
}

// ---------------------------------------------------------------------------
// Fetch state

export interface ChangesFeedOpenInput {
  readonly sessionID: string
  readonly running?: boolean
  readonly location?: string
}

export interface ChangesFeedOptions {
  readonly fetchDiff: (sessionID: string, signal: AbortSignal) => Promise<readonly unknown[]>
  /**
   * Best-effort check used only when the diff is empty. The endpoint returns an
   * empty array both for a turn with no changed files and for a session with no
   * user message/snapshot; the latest-user lookup is the available signal that
   * separates those outcomes.
   */
  readonly hasTurn?: (sessionID: string, signal: AbortSignal) => Promise<boolean | undefined>
  /**
   * Best-effort capability check used only when the diff is empty. OpenCode
   * snapshots are disabled outside a Git worktree, which the diff route reports
   * as an empty array. VCS provider info is the available signal for that case.
   */
  readonly supportsDiff?: (sessionID: string, signal: AbortSignal) => Promise<boolean | undefined>
  readonly now?: () => number
  readonly debounceMs?: number
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface ChangesFeed {
  state(): ChangesState
  subscribe(listener: (state: ChangesState) => void): () => void
  open(input: ChangesFeedOpenInput): void
  close(): void
  refresh(): void
  scheduleRefresh(): void
  noteRunning(running: boolean): void
  noteLocation(location: string | undefined): void
  noteTurnChanged(): void
  noteGone(): void
}

function emptyState(): ChangesState {
  return {
    open: false,
    phase: "idle",
    files: [],
    totals: summarizeChanges([]),
    loading: false,
    stale: false,
    running: false,
    locationChanged: false,
    hasSnapshot: false,
  }
}

/**
 * Session-scoped, abortable fetch state. Only the latest request for the
 * currently open session can publish; a failed refresh keeps the previous
 * snapshot and marks it stale. Updates are coalesced through a debounce and
 * fetch only while open.
 */
export function createChangesFeed(options: ChangesFeedOptions): ChangesFeed {
  const now = options.now ?? Date.now
  const debounceMs = options.debounceMs ?? 300
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms) as unknown)
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))
  const listeners = new Set<(state: ChangesState) => void>()
  let current = emptyState()
  let token = 0
  let timer: unknown | undefined
  let inFlight: AbortController | undefined

  const emit = () => {
    for (const listener of listeners) listener(current)
  }
  const set = (next: ChangesState) => {
    current = next
    emit()
  }
  const clearPending = () => {
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
  }
  const isCurrent = (candidate: number, sessionID: string) =>
    candidate === token && current.open && current.sessionID === sessionID
  const schedule = (ms: number) => {
    if (!current.open) return
    clearPending()
    // A relevant update makes any request already in flight out of date. Ignore
    // it now rather than letting it land before the coalesced refetch starts.
    token += 1
    inFlight?.abort()
    inFlight = undefined
    timer = setTimer(() => {
      timer = undefined
      start()
    }, Math.max(0, ms))
  }

  const start = () => {
    if (!current.open || !current.sessionID) return
    const sessionID = current.sessionID
    const request = ++token
    clearPending()
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    const hasSnapshot = current.hasSnapshot
    set({
      ...current,
      phase: hasSnapshot ? "ready" : "loading",
      loading: true,
      failure: hasSnapshot ? current.failure : undefined,
    })
    void Promise.resolve()
      .then(() => options.fetchDiff(sessionID, controller.signal))
      .then(
        async (files) => {
          if (!isCurrent(request, sessionID)) return
          const normalized = normalizeFiles(files)
          let failure: ChangesFailure | undefined
          if (normalized.length === 0) {
            let supported: boolean | undefined
            if (options.supportsDiff) {
              try {
                supported = await options.supportsDiff(sessionID, controller.signal)
              } catch {
                supported = undefined
              }
              if (!isCurrent(request, sessionID)) return
            }
            if (supported === false) {
              failure = {
                kind: "unsupported",
                message: "session snapshots require a Git worktree",
                retryable: false,
              }
            } else if (options.hasTurn) {
              let hasTurn: boolean | undefined
              try {
                hasTurn = await options.hasTurn(sessionID, controller.signal)
              } catch {
                hasTurn = undefined
              }
              if (!isCurrent(request, sessionID)) return
              if (hasTurn === false) {
                failure = {
                  kind: "absent-snapshot",
                  message: "no user message in this session",
                  retryable: true,
                }
              }
            }
          }
          inFlight = undefined
          if (failure) {
            if (current.hasSnapshot) {
              set({ ...current, phase: "ready", loading: false, stale: true, failure })
            } else {
              set({ ...current, phase: "error", loading: false, stale: false, failure })
            }
            return
          }
          set({
            ...current,
            phase: "ready",
            files: normalized,
            totals: summarizeChanges(normalized),
            loading: false,
            stale: false,
            failure: undefined,
            fetchedAt: now(),
            hasSnapshot: true,
            snapshotDirectory: current.location,
            locationChanged: false,
          })
        },
        (error: unknown) => {
          if (!isCurrent(request, sessionID)) return
          inFlight = undefined
          const failure = classifyDiffError(error)
          if (failure.kind === "aborted") return
          if (current.hasSnapshot) {
            set({ ...current, phase: "ready", loading: false, stale: true, failure })
          } else {
            set({ ...current, phase: "error", loading: false, stale: false, failure })
          }
        },
      )
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(input) {
      token += 1
      clearPending()
      inFlight?.abort()
      inFlight = undefined
      current = {
        ...emptyState(),
        open: true,
        sessionID: input.sessionID,
        phase: "loading",
        running: input.running === true,
        location: input.location,
        loading: true,
      }
      emit()
      start()
    },
    close() {
      token += 1
      clearPending()
      inFlight?.abort()
      inFlight = undefined
      current = emptyState()
      emit()
    },
    refresh() {
      if (!current.open) return
      start()
    },
    scheduleRefresh() {
      schedule(debounceMs)
    },
    noteRunning(running) {
      if (!current.open || current.running === running) return
      const wentIdle = current.running && !running
      set({ ...current, running })
      schedule(wentIdle ? 0 : debounceMs)
    },
    noteLocation(location) {
      if (!current.open || current.location === location) return
      const changed = current.hasSnapshot && current.snapshotDirectory !== location
      set({
        ...current,
        location,
        locationChanged: changed,
        stale: changed ? true : current.stale,
      })
      schedule(changed ? 0 : debounceMs)
    },
    noteTurnChanged() {
      schedule(debounceMs)
    },
    noteGone() {
      if (!current.open) return
      token += 1
      clearPending()
      inFlight?.abort()
      inFlight = undefined
      set({
        ...current,
        phase: "error",
        loading: false,
        stale: current.hasSnapshot,
        failure: {
          kind: "missing-session",
          message: "session deleted",
          retryable: false,
        },
      })
    },
  }
}
