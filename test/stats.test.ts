import { expect, test } from "bun:test"
import {
  DAY_MS,
  LIVE_BUCKETS,
  buildStatsSnapshot,
  bucketCountsLabel,
  drilldown,
  inRecentWindow,
  liveBucket,
  observedAgeLabel,
  type StatsSessionInput,
} from "../src/stats"
import type { SessionInfo } from "@opencode/client"

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_1",
    projectID: "prj_1",
    cost: 0,
    tokens: { input: 0, output: 0 },
    metadata: { gangway: true },
    time: { created: 1_000, updated: 1_000 },
    location: { directory: "/work/foo" },
    ...overrides,
  } as SessionInfo
}

function input(session: SessionInfo, overrides: Partial<StatsSessionInput> = {}): StatsSessionInput {
  return { session, running: false, attentionKnown: true, ...overrides }
}

const NOW = 1_000_000_000_000

function bucketIDs(snapshot: ReturnType<typeof buildStatsSnapshot>): string[] {
  return snapshot.buckets.flatMap((bucket) => bucket.sessions.map((session) => session.id))
}

test("four live buckets are mutually exclusive and attention outranks running", () => {
  const sessions = [
    input(makeSession({ id: "perm", title: "[gangway] perm" }), {
      running: true,
      attention: "permission",
      wait: { at: NOW - 60_000, source: "event" },
    }),
    input(makeSession({ id: "question", title: "[gangway] question" }), {
      running: true,
      attention: "question",
      wait: { at: NOW - 30_000, source: "event" },
    }),
    input(makeSession({ id: "running", title: "[codex] running" }), { running: true }),
    input(makeSession({ id: "idle", title: "idle session" }), { running: false }),
    input(makeSession({ id: "waiting-idle", title: "[gangway] stalled idle" }), {
      running: false,
      attention: "permission",
    }),
    input(makeSession({ id: "child", parentID: "running", title: "[gangway] child" })),
    input(makeSession({ id: "other", title: "ordinary session", metadata: { gangway: false } })),
  ]

  expect(liveBucket(true, "permission")).toBe("permission")
  expect(liveBucket(true, "question")).toBe("question")
  expect(liveBucket(true)).toBe("running")
  expect(liveBucket(false)).toBe("idle")

  const snapshot = buildStatsSnapshot({ sessions, now: NOW })
  expect(snapshot.total).toBe(5)
  expect(snapshot.buckets.map((bucket) => [bucket.bucket, bucket.count])).toEqual([
    ["permission", 2],
    ["question", 1],
    ["running", 1],
    ["idle", 1],
  ])
  expect(bucketIDs(snapshot).sort()).toEqual(["idle", "perm", "question", "running", "waiting-idle"])
  expect(new Set(bucketIDs(snapshot)).size).toBe(snapshot.total)
  expect(snapshot.total).toBe(snapshot.directories.reduce((total, row) => total + row.total, 0))
  expect(snapshot.total).toBe(snapshot.buckets.reduce((total, row) => total + row.count, 0))
  expect(LIVE_BUCKETS).toHaveLength(4)
})

test("directory scope narrows totals and the breakdown agrees", () => {
  const sessions = [
    input(makeSession({ id: "a-run", location: { directory: "/work/a" } }), { running: true }),
    input(makeSession({ id: "a-idle", location: { directory: "/work/a" } })),
    input(makeSession({ id: "b-idle", location: { directory: "/work/b" } })),
    input(makeSession({ id: "child", parentID: "a-run", location: { directory: "/work/a" } })),
    input(makeSession({ id: "plain", location: { directory: "/work/a" }, metadata: { gangway: false } })),
  ]

  const all = buildStatsSnapshot({ sessions, now: NOW, scope: "all" })
  expect(all.total).toBe(3)
  expect(all.scopeLabel).toBe("all directories")
  expect(all.directories.map((row) => [row.directory, row.total])).toEqual([
    ["/work/a", 2],
    ["/work/b", 1],
  ])
  expect(all.directories[0]?.counts).toEqual({ permission: 0, question: 0, running: 1, idle: 1 })

  const current = buildStatsSnapshot({
    sessions,
    now: NOW,
    scope: "current",
    currentDirectory: "/work/a",
  })
  expect(current.total).toBe(2)
  expect(current.scopeLabel).toBe("current directory")
  expect(current.directories.map((row) => row.directory)).toEqual(["/work/a"])
  expect(current.total).toBe(current.buckets.reduce((total, row) => total + row.count, 0))

  const unknown = buildStatsSnapshot({ sessions, now: NOW, scope: "current" })
  expect(unknown.total).toBe(0)
  expect(unknown.scopeLabel).toBe("current directory (unknown)")
})

test("recent outcomes use the strict 24-hour idle window and stay separate from live state", () => {
  const sessions = [
    input(makeSession({ id: "recent-ok", outcome: "succeeded", time: { created: 1, updated: 2, idle: NOW - 1_000 } })),
    input(makeSession({ id: "edge-ok", outcome: "failed", time: { created: 1, updated: 2, idle: NOW - DAY_MS + 1 } })),
    input(makeSession({ id: "too-old", outcome: "interrupted", time: { created: 1, updated: 2, idle: NOW - DAY_MS } })),
    input(makeSession({ id: "future", outcome: "succeeded", time: { created: 1, updated: 2, idle: NOW + 1 } })),
    input(makeSession({ id: "no-idle", outcome: "succeeded", time: { created: 1, updated: 2 } })),
    input(makeSession({ id: "no-outcome", time: { created: 1, updated: 2, idle: NOW - 1_000 } })),
    input(makeSession({ id: "still-running", outcome: "succeeded", time: { created: 1, updated: 2, idle: NOW - 1_000 } }), {
      running: true,
    }),
    input(makeSession({ id: "still-waiting", outcome: "succeeded", time: { created: 1, updated: 2, idle: NOW - 1_000 } }), {
      running: true,
      attention: "permission",
    }),
    input(makeSession({ id: "unsynced", outcome: "succeeded", time: { created: 1, updated: 2, idle: NOW - 1_000 } }), {
      attentionKnown: false,
    }),
  ]

  expect(inRecentWindow(NOW - DAY_MS + 1, NOW)).toBe(true)
  expect(inRecentWindow(NOW - DAY_MS, NOW)).toBe(false)
  expect(inRecentWindow(NOW + 1, NOW)).toBe(false)
  expect(inRecentWindow(undefined, NOW)).toBe(false)

  const snapshot = buildStatsSnapshot({ sessions, now: NOW })
  expect(snapshot.recent.map((row) => [row.outcome, row.count, row.sessions.map((s) => s.id)])).toEqual([
    ["succeeded", 1, ["recent-ok"]],
    ["failed", 1, ["edge-ok"]],
    ["interrupted", 0, []],
  ])
  expect(snapshot.unsynced).toBe(1)
  expect(snapshot.historyNote).toContain("shared store")
})

test("missing wait and run timestamps stay unknown instead of borrowing session times", () => {
  const sessions = [
    input(
      makeSession({
        id: "known-wait",
        time: { created: 5, updated: 6 },
      }),
      { attention: "permission", wait: { at: NOW - 600_000, source: "event" } },
    ),
    input(makeSession({ id: "first-seen-wait", time: { created: 7, updated: 8 } }), {
      attention: "question",
      wait: { at: NOW - 60_000, source: "first-seen" },
    }),
    input(makeSession({ id: "unknown-wait", time: { created: 9, updated: 10 } }), {
      attention: "permission",
    }),
    input(makeSession({ id: "known-run", time: { created: 11, updated: 12 } }), {
      running: true,
      run: { at: NOW - 3_600_000, source: "event" },
    }),
    input(makeSession({ id: "unknown-run", time: { created: 13, updated: 14 } }), { running: true }),
  ]

  const snapshot = buildStatsSnapshot({ sessions, now: NOW, historyLimit: 500 })
  expect(snapshot.historyNote).toBe("Loaded history: latest 500 sessions")
  expect(snapshot.waits.map((session) => session.id)).toEqual([
    "known-wait",
    "first-seen-wait",
    "unknown-wait",
  ])
  expect(snapshot.waits.map((session) => session.wait?.source)).toEqual([
    "event",
    "first-seen",
    undefined,
  ])
  expect(snapshot.active.map((session) => session.id)).toEqual(["known-run", "unknown-run"])
  expect(snapshot.active[1]?.run).toBeUndefined()
  expect(snapshot.waits[2]?.wait).toBeUndefined()

  expect(observedAgeLabel(undefined, NOW)).toBe("unknown")
  expect(observedAgeLabel({ at: NOW - 120_000, source: "event" }, NOW)).toBe("2m ago")
  expect(observedAgeLabel({ at: NOW - 120_000, source: "first-seen" }, NOW)).toBe("first seen 2m ago")
})

test("drilldowns select directory, live state and recent outcome rows", () => {
  const sessions = [
    input(makeSession({ id: "a-perm", location: { directory: "/work/a" }, outcome: "succeeded" }), {
      running: true,
      attention: "permission",
    }),
    input(makeSession({ id: "a-ok", location: { directory: "/work/a" }, outcome: "succeeded", time: { created: 1, updated: 2, idle: NOW - 1_000 } })),
    input(makeSession({ id: "b-failed", location: { directory: "/work/b" }, outcome: "failed", time: { created: 1, updated: 2, idle: NOW - 2_000 } })),
  ]
  const snapshot = buildStatsSnapshot({ sessions, now: NOW, scope: "all" })

  const directory = drilldown(snapshot, { kind: "directory", directory: "/work/a" })
  expect(directory.count).toBe(2)
  expect(directory.sessions.map((session) => session.id)).toEqual(["a-perm", "a-ok"])
  expect(directory.scopeLabel).toBe("all directories")

  const permission = drilldown(snapshot, { kind: "bucket", bucket: "permission" })
  expect(permission.count).toBe(1)
  expect(permission.sessions.map((session) => session.id)).toEqual(["a-perm"])

  const failed = drilldown(snapshot, { kind: "outcome", outcome: "failed" })
  expect(failed.count).toBe(1)
  expect(failed.sessions.map((session) => session.id)).toEqual(["b-failed"])
  expect(failed.scopeLabel).toBe("past 24h · all directories")

  const missing = drilldown(snapshot, { kind: "directory", directory: "/work/nope" })
  expect(missing.count).toBe(0)
  expect(missing.sessions).toEqual([])
})

test("directory rows carry compact bucket counts", () => {
  const snapshot = buildStatsSnapshot({
    sessions: [
      input(makeSession({ id: "one", location: { directory: "/a" } }), { running: true }),
      input(makeSession({ id: "two", location: { directory: "/a" } }), { attention: "permission" }),
    ],
    now: NOW,
  })
  expect(bucketCountsLabel(snapshot.directories[0]!.counts)).toBe("P1 Q0 R1 I0")
})
