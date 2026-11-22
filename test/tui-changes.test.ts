import { expect, test } from "bun:test"
import {
  CHANGES_PAGE,
  boundPatch,
  changesDestination,
  changesNotice,
  changesScopeNote,
  classifyDiffError,
  createChangesFeed,
  failureLabel,
  formatFileDeltas,
  formatTotals,
  normalizeFiles,
  patchAvailability,
  patchWindow,
  statusMarker,
  statusWord,
  summarizeChanges,
  windowAround,
  type ChangesState,
} from "../src/tui-changes"

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

interface FakeCall {
  readonly sessionID: string
  readonly signal: AbortSignal
  readonly result: Deferred<readonly unknown[]>
}

function fakeDiff() {
  const calls: FakeCall[] = []
  return {
    calls,
    fetchDiff: (sessionID: string, signal: AbortSignal) => {
      const result = deferred<readonly unknown[]>()
      calls.push({ sessionID, signal, result })
      return result.promise
    },
  }
}

function fakeTimers() {
  let next = 1
  const timers = new Map<number, { run: () => void; ms: number }>()
  return {
    timers,
    setTimer: (run: () => void, ms: number) => {
      const handle = next++
      timers.set(handle, { run, ms })
      return handle
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    runAll() {
      const pending = [...timers.values()]
      timers.clear()
      for (const timer of pending) timer.run()
      return pending
    },
  }
}

test("changes route is a pinned plugin destination, not a chat session route", () => {
  expect(changesDestination("ses_abc")).toEqual({
    type: "plugin",
    name: CHANGES_PAGE,
    data: { sessionID: "ses_abc" },
  })
  expect(changesDestination("ses_abc").type).not.toBe("session")
})

test("normalizeFiles trusts only known statuses and finite counts", () => {
  const files = normalizeFiles([
    { file: "a.ts", patch: "+a", additions: 2, deletions: 0, status: "added" },
    { file: "", patch: 1, additions: Number.NaN, deletions: -3, status: "weird" },
    null,
  ])
  expect(files).toHaveLength(3)
  expect(files[0]).toMatchObject({ file: "a.ts", status: "added", additions: 2, deletions: 0 })
  expect(files[1]).toMatchObject({ file: "(unknown file)", patch: "", status: "unknown" })
  expect(files[1]?.additions).toBeUndefined()
  expect(files[1]?.deletions).toBeUndefined()
  expect(files[2]).toMatchObject({ file: "(unknown file)", status: "unknown" })
})

test("totals sum per-file statuses and line deltas", () => {
  const totals = summarizeChanges(
    normalizeFiles([
      { file: "a.ts", patch: "", additions: 2, deletions: 0, status: "added" },
      { file: "b.ts", patch: "", additions: 3, deletions: 1, status: "modified" },
      { file: "c.ts", patch: "", additions: 0, deletions: 4, status: "deleted" },
    ]),
  )
  expect(totals).toMatchObject({
    files: 3,
    added: 1,
    modified: 1,
    deleted: 1,
    unknown: 0,
    additions: 5,
    deletions: 5,
    hasLineCounts: true,
    lineCountsComplete: true,
  })
  expect(formatTotals(totals)).toBe("3 files · 1A 1M 1D · +5 −5")
})

test("totals distinguish partial and unavailable line counts", () => {
  const partial = summarizeChanges(
    normalizeFiles([
      { file: "a.ts", patch: "", additions: 2, deletions: 0, status: "modified" },
      { file: "b.ts", patch: "", status: "modified" },
    ]),
  )
  expect(partial.hasLineCounts).toBe(true)
  expect(partial.lineCountsComplete).toBe(false)
  expect(formatTotals(partial)).toBe("2 files · 0A 2M 0D · +2 −0 (partial)")

  const missing = summarizeChanges(normalizeFiles([{ file: "a.ts", patch: "", status: "modified" }]))
  expect(missing.hasLineCounts).toBe(false)
  expect(formatTotals(missing)).toBe("1 file · 0A 1M 0D · line counts unavailable")

  expect(formatTotals(summarizeChanges([]))).toBe("0 files")
})

test("per-file markers and deltas stay explicit", () => {
  expect(statusMarker("added")).toBe("A")
  expect(statusMarker("modified")).toBe("M")
  expect(statusMarker("deleted")).toBe("D")
  expect(statusMarker("unknown")).toBe("?")
  expect(statusWord("unknown")).toBe("changed")
  expect(formatFileDeltas({ file: "a", patch: "", additions: 4, deletions: 2, status: "modified" })).toBe("+4 −2")
  expect(formatFileDeltas({ file: "a", patch: "", additions: 4, status: "modified" })).toBe("+4")
  expect(formatFileDeltas({ file: "a", patch: "", status: "modified" })).toBe("—")
})

test("diff failures map to honest unavailable states", () => {
  expect(classifyDiffError({ _tag: "LocationNotFoundError", message: "location missing" }).kind).toBe(
    "deleted-worktree",
  )
  expect(classifyDiffError({ _tag: "SessionNotFoundError", message: "no session" }).kind).toBe("missing-session")
  expect(classifyDiffError({ _tag: "MessageNotFoundError", message: "no user message" }).kind).toBe(
    "absent-snapshot",
  )
  expect(classifyDiffError({ _tag: "InvalidRequestError", message: "unsupported diff" }).kind).toBe("unsupported")
  expect(classifyDiffError({ _tag: "UnknownError", message: "failed to read" }).kind).toBe("unreadable")
  expect(
    classifyDiffError({ _tag: "Session.TurnRangeError", message: "Turn range spans a location change" }).kind,
  ).toBe("location-switch")
  expect(classifyDiffError({ name: "ClientError", message: "Transport: fetch failed" }).kind).toBe("network")
  expect(classifyDiffError({ name: "AbortError", message: "aborted" }).kind).toBe("aborted")
  expect(classifyDiffError({ name: "ClientError", cause: { status: 404 }, message: "no user message" }).kind).toBe(
    "absent-snapshot",
  )
  expect(classifyDiffError({ name: "ClientError", cause: { status: 404 }, message: "session missing" }).kind).toBe(
    "missing-session",
  )
  expect(failureLabel(classifyDiffError({ _tag: "MessageNotFoundError", message: "no user message" }))).toContain(
    "No latest-turn snapshot",
  )
})

test("patch availability separates binary and patchless files", () => {
  expect(patchAvailability("diff --git a/x b/x\n+hello")).toEqual({ available: true })
  expect(patchAvailability("")).toEqual({ available: false, reason: "patchless" })
  expect(patchAvailability("   \n")).toEqual({ available: false, reason: "patchless" })
  expect(patchAvailability("Binary files a/x and b/x differ")).toEqual({ available: false, reason: "binary" })
  expect(patchAvailability("GIT binary patch\nliteral 0")).toEqual({ available: false, reason: "binary" })
  expect(patchAvailability("a\u0000b")).toEqual({ available: false, reason: "binary" })
})

test("boundPatch bounds long patches and emits an explicit truncation cue", () => {
  const patch = Array.from({ length: 5000 }, (_, index) => `+line ${index + 1}`).join("\n")
  const display = boundPatch(patch, { maxLines: 10, maxChars: 100_000 })
  expect(display.available).toBe(true)
  expect(display.shownLines).toBe(10)
  expect(display.totalLines).toBe(5000)
  expect(display.omittedLines).toBe(4990)
  expect(display.truncated).toBe(true)
  expect(display.cue).toContain("Patch truncated")
  expect(display.lines).toHaveLength(11)
  expect(display.lines.at(-1)).toBe(display.cue!)
  expect(display.text).toContain("showing 10 of 5000 lines")
})

test("boundPatch clips characters and long lines without unbounded output", () => {
  const byChars = boundPatch(Array.from({ length: 100 }, (_, index) => `+${index}`).join("\n"), {
    maxLines: 100,
    maxChars: 30,
  })
  expect(byChars.truncated).toBe(true)
  expect(byChars.shownLines).toBeLessThan(100)
  expect(byChars.text).toContain("Patch truncated")

  const longLine = boundPatch("+" + "x".repeat(2000), { maxChars: 10_000, maxLineChars: 40 })
  expect(longLine.available).toBe(true)
  expect(longLine.shownLines).toBe(1)
  expect(longLine.lines[0]!.length).toBeLessThanOrEqual(40)
  expect(longLine.truncated).toBe(true)
  expect(longLine.cue).toContain("long lines are clipped")

  const unavailable = boundPatch("Binary files a/x and b/x differ")
  expect(unavailable.available).toBe(false)
  expect(unavailable.reason).toBe("binary")
  expect(unavailable.lines).toEqual([])
})

test("patchWindow clamps scrolling to the bounded line array", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`)
  expect(patchWindow(lines, 0, 10)).toMatchObject({ start: 0, end: 10, offset: 0, maxOffset: 90 })
  expect(patchWindow(lines, 95, 10)).toMatchObject({ start: 90, end: 100, offset: 90 })
  expect(patchWindow(lines, 999, 10)).toMatchObject({ start: 90, end: 100, offset: 90 })
  expect(patchWindow(lines, -5, 10)).toMatchObject({ start: 0, end: 10, offset: 0 })
  expect(patchWindow([], 0, 10)).toMatchObject({ start: 0, end: 0, lines: [] })
})

test("windowAround keeps the selection visible with many files", () => {
  expect(windowAround(0, 100, 10)).toEqual({ start: 0, end: 10 })
  expect(windowAround(50, 100, 10)).toEqual({ start: 45, end: 55 })
  expect(windowAround(99, 100, 10)).toEqual({ start: 90, end: 100 })
  expect(windowAround(2, 5, 10)).toEqual({ start: 0, end: 5 })
  expect(windowAround(2, 0, 10)).toEqual({ start: 0, end: 0 })
})

test("scope note always names the latest turn and explains running work", () => {
  expect(changesScopeNote(false)).toContain("Latest turn")
  expect(changesScopeNote(false)).not.toContain("in-progress")
  expect(changesScopeNote(true)).toContain("in-progress worktree changes")
})

test("feed loads once only while open and publishes a ready snapshot", async () => {
  const diff = fakeDiff()
  const feed = createChangesFeed({ fetchDiff: diff.fetchDiff, debounceMs: 0 })
  expect(feed.state().open).toBe(false)
  expect(changesNotice(feed.state()).kind).toBe("closed")

  feed.open({ sessionID: "ses_a", running: true, location: "/work/a" })
  expect(feed.state().open).toBe(true)
  expect(feed.state().phase).toBe("loading")
  expect(changesNotice(feed.state()).kind).toBe("loading")
  await flush()
  expect(diff.calls).toHaveLength(1)
  expect(diff.calls[0]!.sessionID).toBe("ses_a")

  diff.calls[0]!.result.resolve([{ file: "a.ts", patch: "+a", additions: 1, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().phase).toBe("ready")
  expect(feed.state().files).toHaveLength(1)
  expect(feed.state().totals.additions).toBe(1)
  expect(feed.state().hasSnapshot).toBe(true)
  expect(feed.state().stale).toBe(false)
  expect(changesNotice(feed.state()).kind).toBe("ready")

  feed.refresh()
  await flush()
  feed.close()
  expect(feed.state().open).toBe(false)
  expect(diff.calls[1]!.signal.aborted).toBe(true)
})

test("empty results are distinct from absent snapshots", async () => {
  const emptyDiff = fakeDiff()
  const empty = createChangesFeed({
    fetchDiff: emptyDiff.fetchDiff,
    hasTurn: async () => true,
    supportsDiff: async () => true,
    debounceMs: 0,
  })
  empty.open({ sessionID: "ses_empty" })
  await flush()
  emptyDiff.calls[0]!.result.resolve([])
  await flush()
  expect(empty.state().phase).toBe("ready")
  expect(empty.state().files).toEqual([])
  expect(empty.state().failure).toBeUndefined()
  expect(changesNotice(empty.state())).toEqual({
    kind: "empty",
    message: "No file changes in the latest turn.",
  })

  const absentDiff = fakeDiff()
  const absent = createChangesFeed({
    fetchDiff: absentDiff.fetchDiff,
    hasTurn: async () => false,
    supportsDiff: async () => true,
    debounceMs: 0,
  })
  absent.open({ sessionID: "ses_no_turn" })
  await flush()
  absentDiff.calls[0]!.result.resolve([])
  await flush()
  expect(absent.state().phase).toBe("error")
  expect(absent.state().failure?.kind).toBe("absent-snapshot")
  expect(changesNotice(absent.state()).kind).toBe("error")
  expect(changesNotice(absent.state()).message).toContain("No latest-turn snapshot")

  const unsupportedDiff = fakeDiff()
  const unsupported = createChangesFeed({
    fetchDiff: unsupportedDiff.fetchDiff,
    hasTurn: async () => true,
    supportsDiff: async () => false,
    debounceMs: 0,
  })
  unsupported.open({ sessionID: "ses_no_git" })
  await flush()
  unsupportedDiff.calls[0]!.result.resolve([])
  await flush()
  expect(unsupported.state().phase).toBe("error")
  expect(unsupported.state().failure?.kind).toBe("unsupported")
  expect(changesNotice(unsupported.state()).message).toContain("not supported")

  const missingDiff = fakeDiff()
  const missing = createChangesFeed({ fetchDiff: missingDiff.fetchDiff, debounceMs: 0 })
  missing.open({ sessionID: "ses_missing" })
  await flush()
  missingDiff.calls[0]!.result.reject({ _tag: "MessageNotFoundError", message: "no user message" })
  await flush()
  expect(missing.state().phase).toBe("error")
  expect(missing.state().failure?.kind).toBe("absent-snapshot")
  expect(changesNotice(missing.state()).kind).toBe("error")
  expect(changesNotice(missing.state()).message).toContain("No latest-turn snapshot")
})

test("a failed refresh retains the previous snapshot with stale status", async () => {
  const diff = fakeDiff()
  const feed = createChangesFeed({ fetchDiff: diff.fetchDiff, debounceMs: 0 })
  feed.open({ sessionID: "ses_a" })
  await flush()
  diff.calls[0]!.result.resolve([{ file: "a.ts", patch: "+a", additions: 1, deletions: 0, status: "added" }])
  await flush()

  feed.refresh()
  await flush()
  expect(diff.calls).toHaveLength(2)
  diff.calls[1]!.result.reject({ _tag: "UnknownError", message: "failed to read" })
  await flush()

  expect(feed.state().phase).toBe("ready")
  expect(feed.state().files).toHaveLength(1)
  expect(feed.state().stale).toBe(true)
  expect(feed.state().failure?.kind).toBe("unreadable")
  expect(changesNotice(feed.state())).toMatchObject({ kind: "stale" })
  expect(changesNotice(feed.state()).message).toContain("last snapshot")
})

test("an out-of-date response cannot overwrite the current view", async () => {
  const diff = fakeDiff()
  const feed = createChangesFeed({ fetchDiff: diff.fetchDiff, debounceMs: 0 })
  feed.open({ sessionID: "ses_a" })
  await flush()
  feed.refresh()
  await flush()
  expect(diff.calls).toHaveLength(2)
  expect(diff.calls[0]!.signal.aborted).toBe(true)

  diff.calls[1]!.result.resolve([{ file: "new.ts", patch: "+new", additions: 1, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().files[0]?.file).toBe("new.ts")

  diff.calls[0]!.result.resolve([{ file: "old.ts", patch: "+old", additions: 9, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().files[0]?.file).toBe("new.ts")
  expect(feed.state().totals.additions).toBe(1)
})

test("every fetch and reused result stays scoped to the open session ID", async () => {
  const diff = fakeDiff()
  const feed = createChangesFeed({ fetchDiff: diff.fetchDiff, debounceMs: 0 })
  feed.open({ sessionID: "ses_a" })
  await flush()
  feed.open({ sessionID: "ses_b" })
  await flush()
  expect(diff.calls).toHaveLength(2)
  expect(diff.calls[0]!.signal.aborted).toBe(true)
  expect(diff.calls[1]!.sessionID).toBe("ses_b")

  diff.calls[0]!.result.resolve([{ file: "a.ts", patch: "+a", additions: 1, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().sessionID).toBe("ses_b")
  expect(feed.state().files).toEqual([])

  diff.calls[1]!.result.resolve([{ file: "b.ts", patch: "+b", additions: 2, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().files[0]?.file).toBe("b.ts")
})

test("scheduled updates coalesce into one fetch", async () => {
  const timers = fakeTimers()
  const diff = fakeDiff()
  const feed = createChangesFeed({
    fetchDiff: diff.fetchDiff,
    debounceMs: 250,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  feed.open({ sessionID: "ses_a" })
  await flush()
  expect(diff.calls).toHaveLength(1)

  feed.scheduleRefresh()
  feed.scheduleRefresh()
  feed.scheduleRefresh()
  expect(timers.timers.size).toBe(1)
  expect([...timers.timers.values()][0]!.ms).toBe(250)
  expect(diff.calls[0]!.signal.aborted).toBe(true)

  timers.runAll()
  await flush()
  expect(diff.calls).toHaveLength(2)
  expect(diff.calls[0]!.signal.aborted).toBe(true)
})

test("a scheduled turn update ignores an in-flight response for the old turn", async () => {
  const timers = fakeTimers()
  const diff = fakeDiff()
  const feed = createChangesFeed({
    fetchDiff: diff.fetchDiff,
    debounceMs: 250,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  feed.open({ sessionID: "ses_a" })
  await flush()
  feed.noteTurnChanged()
  expect(diff.calls[0]!.signal.aborted).toBe(true)

  diff.calls[0]!.result.resolve([{ file: "old.ts", patch: "+old", additions: 1, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().files).toEqual([])
  expect(feed.state().loading).toBe(true)

  timers.runAll()
  await flush()
  expect(diff.calls).toHaveLength(2)
  diff.calls[1]!.result.resolve([{ file: "new.ts", patch: "+new", additions: 1, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().files[0]?.file).toBe("new.ts")
})

test("active-to-idle refreshes immediately and updates state", async () => {
  const timers = fakeTimers()
  const diff = fakeDiff()
  const feed = createChangesFeed({
    fetchDiff: diff.fetchDiff,
    debounceMs: 500,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  feed.open({ sessionID: "ses_a", running: true })
  await flush()
  diff.calls[0]!.result.resolve([])
  await flush()
  expect(feed.state().running).toBe(true)

  feed.noteRunning(false)
  expect(feed.state().running).toBe(false)
  expect(timers.timers.size).toBe(1)
  expect([...timers.timers.values()][0]!.ms).toBe(0)

  timers.runAll()
  await flush()
  expect(diff.calls).toHaveLength(2)
  expect(diff.calls[0]!.signal.aborted).toBe(false)
  expect(diff.calls[1]!.sessionID).toBe("ses_a")
})

test("a location switch marks the old snapshot stale until the refetch succeeds", async () => {
  const timers = fakeTimers()
  const diff = fakeDiff()
  const feed = createChangesFeed({
    fetchDiff: diff.fetchDiff,
    debounceMs: 500,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  feed.open({ sessionID: "ses_a", location: "/work/a" })
  await flush()
  diff.calls[0]!.result.resolve([{ file: "a.ts", patch: "+a", additions: 1, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().snapshotDirectory).toBe("/work/a")

  feed.noteLocation("/work/b")
  expect(feed.state().location).toBe("/work/b")
  expect(feed.state().locationChanged).toBe(true)
  expect(feed.state().stale).toBe(true)

  timers.runAll()
  await flush()
  expect(diff.calls).toHaveLength(2)
  diff.calls[1]!.result.resolve([{ file: "b.ts", patch: "+b", additions: 2, deletions: 0, status: "added" }])
  await flush()
  expect(feed.state().locationChanged).toBe(false)
  expect(feed.state().snapshotDirectory).toBe("/work/b")
  expect(feed.state().files[0]?.file).toBe("b.ts")
})

test("a deleted session is an error but a retained snapshot is labelled stale", async () => {
  const diff = fakeDiff()
  const feed = createChangesFeed({ fetchDiff: diff.fetchDiff, debounceMs: 0 })
  feed.open({ sessionID: "ses_a" })
  await flush()
  diff.calls[0]!.result.resolve([{ file: "a.ts", patch: "+a", additions: 1, deletions: 0, status: "added" }])
  await flush()

  feed.noteGone()
  const state: ChangesState = feed.state()
  expect(state.phase).toBe("error")
  expect(state.stale).toBe(true)
  expect(state.failure?.kind).toBe("missing-session")
  expect(state.files).toHaveLength(1)
  expect(changesNotice(state).message).toContain("Session no longer available")
})
