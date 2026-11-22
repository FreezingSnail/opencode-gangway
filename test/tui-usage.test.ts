import { describe, expect, test } from "bun:test"
import {
  DEFAULT_USAGE_CAPS,
  UsageAbortedError,
  UsageCache,
  aggregateUsage,
  extractUsageRecord,
  formatCost,
  formatNumber,
  formatTokenFields,
  loadUsage,
  localDayKey,
  localDayLabels,
  usageBar,
  usageWindow,
  type UsageClient,
  type UsageMessage,
  type UsageRecord,
  type UsageSession,
} from "../src/tui-usage"

// Deterministic, offline coverage for the Gangway usage page. Fake clients
// serve explicit pages so cursor overlap, duplicate roots, fork inheritance and
// failed/truncated history are exercised without a live OpenCode service.

const NOW = new Date(2026, 10, 22, 15, 30, 0).getTime() // local 2026-11-22 15:30

function session(overrides: Partial<UsageSession> & { id: string }): UsageSession {
  return {
    time: { created: NOW - 86_400_000, updated: NOW - 3_600_000 },
    title: "[gangway] fixture",
    metadata: { gangway: true },
    location: { directory: "/work/alpha" },
    ...overrides,
  }
}

function assistant(
  id: string,
  created: number,
  overrides: Partial<UsageMessage> = {},
): UsageMessage {
  return {
    id,
    type: "assistant",
    time: { created },
    model: { id: "model-a", providerID: "provider" },
    cost: 0.01,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 1 } },
    ...overrides,
  }
}

function user(id: string, created: number): UsageMessage {
  return { id, type: "user", time: { created } }
}

interface FakeOptions {
  readonly sessionPages: readonly (readonly UsageSession[])[]
  readonly messagePages?: Readonly<Record<string, readonly (readonly UsageMessage[])[]>>
  readonly failMessageSessions?: readonly string[]
  readonly failSessionPage?: number
  readonly boundaryTimes?: Readonly<Record<string, number>>
}

function fakeClient(options: FakeOptions): UsageClient {
  const sessionCalls: unknown[] = []
  return {
    session: {
      async list(input) {
        sessionCalls.push(input)
        const cursor = typeof input.cursor === "string" ? Number(input.cursor.slice(1)) : 0
        if (options.failSessionPage !== undefined && cursor === options.failSessionPage) {
          throw new Error("session list failed")
        }
        const data = [...(options.sessionPages[cursor] ?? [])]
        const hasNext = cursor + 1 < options.sessionPages.length
        return { data, cursor: hasNext ? { next: `s${cursor + 1}` } : { next: null } }
      },
      async get() {
        throw new Error("unused")
      },
      message: {
        async get(input) {
          const created = options.boundaryTimes?.[input.messageID]
          if (created === undefined) throw new Error("boundary not found")
          return { time: { created } }
        },
      },
    },
    message: {
      async list(input) {
        if (options.failMessageSessions?.includes(input.sessionID)) throw new Error("message list failed")
        const pages = options.messagePages?.[input.sessionID] ?? []
        const cursor = typeof input.cursor === "string" ? Number(input.cursor.slice(1)) : 0
        const data = [...(pages[cursor] ?? [])]
        const hasNext = cursor + 1 < pages.length
        return { data, cursor: hasNext ? { next: `p${cursor + 1}` } : { next: null } }
      },
    },
  }
}

function record(
  sessionID: string,
  messageID: string,
  created: number,
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    sessionID,
    messageID,
    created,
    model: "provider/model-a",
    directory: "/work/alpha",
    cost: 0.01,
    tokens: { input: 10, output: 5 },
    ...overrides,
  }
}

describe("usage windows", () => {
  test("7 and 30 day windows are local half-open and include today", () => {
    const seven = usageWindow(NOW, 7)
    expect(seven.start).toBe(new Date(2026, 10, 16, 0, 0, 0, 0).getTime())
    expect(seven.end).toBe(new Date(2026, 10, 23, 0, 0, 0, 0).getTime())
    expect(localDayLabels(seven)).toHaveLength(7)
    expect(localDayLabels(seven)[0].label).toBe("11/16")
    expect(localDayLabels(seven)[6].label).toBe("11/22")

    const thirty = usageWindow(NOW, 30)
    expect(thirty.start).toBe(new Date(2026, 9, 24, 0, 0, 0, 0).getTime())
    expect(thirty.end).toBe(seven.end)
    expect(localDayLabels(thirty)).toHaveLength(30)
  })

  test("start is inclusive and end is exclusive across the midnight edge", () => {
    const window = usageWindow(NOW, 7)
    const start = window.start
    const end = window.end
    const records = [
      record("s", "before", start - 1),
      record("s", "at-start", start),
      record("s", "last-ms", end - 1),
      record("s", "at-end", end),
    ]
    const summary = aggregateUsage(records, { range: 7, scope: "all", window, now: NOW })
    expect(summary.totals.steps).toBe(2)
    expect(summary.totals.cost).toBeCloseTo(0.02)
    expect(summary.days[0].steps).toBe(1)
    expect(summary.days[6].steps).toBe(1)
    expect(localDayKey(end)).not.toBe(localDayKey(end - 1))
  })

  test("zero and unavailable usage stay distinct", () => {
    const window = usageWindow(NOW, 7)
    const records: UsageRecord[] = [
      record("s", "zero", NOW - 1000, {
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      {
        sessionID: "s",
        messageID: "missing",
        created: NOW - 2000,
        model: "provider/model-a",
        directory: "/work/alpha",
        tokens: {},
      },
    ]
    const summary = aggregateUsage(records, { range: 7, scope: "all", window, now: NOW })
    expect(summary.totals.cost).toBe(0)
    expect(summary.totals.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(summary.totals.totalTokens).toBe(0)
    expect(summary.totals.measuredCostSteps).toBe(1)
    expect(summary.totals.measuredTokenSteps).toBe(1)
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(undefined)).toBe("—")
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(undefined)).toBe("—")
    expect(formatTokenFields({ input: 0 })).toBe(
      "in 0 · out — · reason — · cache r — · cache w —",
    )
  })
})

describe("aggregation and deduplication", () => {
  test("a message recorded twice under mixed models counts once under the first model", () => {
    const window = usageWindow(NOW, 7)
    const records = [
      record("s1", "m1", NOW - 1000, { model: "provider/model-a" }),
      record("s1", "m1", NOW - 1000, { model: "provider/model-b", cost: 9 }),
      record("s1", "m2", NOW - 2000, { model: "provider/model-b", cost: 0.02 }),
    ]
    const summary = aggregateUsage(records, { range: 7, scope: "all", window, now: NOW })
    expect(summary.totals.steps).toBe(2)
    expect(summary.totals.cost).toBeCloseTo(0.03)
    expect(summary.models.map((model) => [model.key, model.steps])).toEqual([
      ["provider/model-b", 1],
      ["provider/model-a", 1],
    ])
  })

  test("inherited fork message IDs and duplicate roots never inflate totals", () => {
    const window = usageWindow(NOW, 7)
    const records = [
      record("parent", "shared", NOW - 1000, { directory: "/work/alpha" }),
      record("fork", "shared", NOW - 1000, { directory: "/work/fork", cost: 5 }),
      record("fork", "new", NOW - 500, { directory: "/work/fork", cost: 0.02 }),
      record("parent", "shared", NOW - 1000),
    ]
    const summary = aggregateUsage(records, { range: 7, scope: "all", window, now: NOW })
    expect(summary.totals.steps).toBe(2)
    expect(summary.totals.cost).toBeCloseTo(0.03)
    expect(summary.directories.map((entry) => entry.key)).toEqual(["/work/fork", "/work/alpha"])
  })

  test("model changes attribute to each recorded step's model", () => {
    const window = usageWindow(NOW, 7)
    const records = [
      record("s", "a", NOW - 3000, { model: "provider/model-a", cost: 0.01 }),
      record("s", "b", NOW - 2000, { model: "provider/model-b", cost: 0.02 }),
      record("s", "c", NOW - 1000, { model: "provider/model-a", cost: 0.04 }),
    ]
    const summary = aggregateUsage(records, { range: 7, scope: "all", window, now: NOW })
    expect(summary.models).toEqual([
      expect.objectContaining({ key: "provider/model-a", steps: 2, cost: 0.05 }),
      expect.objectContaining({ key: "provider/model-b", steps: 1, cost: 0.02 }),
    ])
  })

  test("extraction keeps step model and session directory, rejecting non-assistant rows", () => {
    const window = usageWindow(NOW, 7)
    const owner = session({ id: "s", location: { directory: "/work/owner" } })
    const extracted = extractUsageRecord(
      assistant("m1", NOW - 1000, {
        model: { id: "fast", providerID: "local" },
        cost: 0,
        tokens: { input: 0, output: 4 },
      }),
      owner,
      window,
    )
    expect(extracted).toEqual({
      sessionID: "s",
      messageID: "m1",
      created: NOW - 1000,
      model: "local/fast",
      directory: "/work/owner",
      cost: 0,
      tokens: { input: 0, output: 4 },
    })
    expect(extractUsageRecord(user("u1", NOW), owner, window)).toBeUndefined()
    expect(extractUsageRecord(assistant("old", window.start - 1), owner, window)).toBeUndefined()
  })
})

describe("bounded loader", () => {
  test("paged sessions and overlapping cursors do not double count", async () => {
    const alpha = session({ id: "s1" })
    const beta = session({
      id: "s2",
      location: { directory: "/work/beta" },
      time: { created: NOW - 10 * 86_400_000, updated: NOW - 2 * 86_400_000 },
    })
    // The old session qualifies through its recent update even though it was
    // created before the 7-day window.
    const older = session({
      id: "s3",
      location: { directory: "/work/beta" },
      time: { created: NOW - 40 * 86_400_000, updated: NOW - 86_400_000 },
    })
    const unrelated = session({
      id: "u1",
      title: "other work",
      metadata: {},
      location: { directory: "/work/other" },
    })
    const client = fakeClient({
      sessionPages: [
        [alpha, beta],
        [beta, older, unrelated],
      ],
      messagePages: {
        s1: [[assistant("s1m1", NOW - 1000), user("u", NOW - 900)], [assistant("s1m1", NOW - 1000), assistant("s1m2", NOW - 800)]],
        s2: [[assistant("s2m1", NOW - 2 * 86_400_000)]],
        s3: [[assistant("s3m1", NOW - 86_400_000)]],
        u1: [[assistant("um1", NOW - 1000, { cost: 100 })]],
      },
    })
    const summary = await loadUsage({
      client,
      range: 7,
      scope: "all",
      now: NOW,
      caps: { ...DEFAULT_USAGE_CAPS, sessionPageSize: 2, messagePageSize: 10 },
    })
    expect(summary.totals.steps).toBe(4)
    expect(summary.totals.cost).toBeCloseTo(0.04)
    expect(summary.directories.map((entry) => entry.key)).toEqual(["/work/alpha", "/work/beta"])
    expect(summary.coverage.scannedSessions).toBe(3)
    expect(summary.coverage.partial).toBe(false)
    expect(summary.days).toHaveLength(7)
  })

  test("fork inherited steps are excluded and new steps remain", async () => {
    const parent = session({ id: "parent", time: { created: NOW - 5 * 86_400_000, updated: NOW - 1000 } })
    const fork = session({
      id: "fork",
      fork: { sessionID: "parent", boundary: { type: "through", messageID: "parent-m1" } },
      time: { created: NOW - 2 * 86_400_000, updated: NOW - 500 },
    })
    const boundary = NOW - 3 * 86_400_000
    const client = fakeClient({
      sessionPages: [[parent, fork]],
      messagePages: {
        parent: [[assistant("parent-m1", boundary), assistant("parent-m2", boundary + 1000)]],
        fork: [
          [
            assistant("parent-m1", boundary),
            assistant("fork-inherited", boundary - 500),
            assistant("fork-new", boundary + 2000),
          ],
        ],
      },
      boundaryTimes: { "parent-m1": boundary },
    })
    const summary = await loadUsage({
      client,
      range: 7,
      scope: "all",
      now: NOW,
      caps: { ...DEFAULT_USAGE_CAPS, concurrency: 2 },
    })
    expect(summary.totals.steps).toBe(3)
    expect(summary.coverage.partial).toBe(false)
    expect(summary.models).toEqual([expect.objectContaining({ steps: 3 })])
  })

  test("session and message caps mark coverage partial", async () => {
    const s1 = session({ id: "s1" })
    const s2 = session({ id: "s2" })
    const cappedSessions = await loadUsage({
      client: fakeClient({ sessionPages: [[s1], [s2]] }),
      range: 7,
      scope: "all",
      now: NOW,
      caps: { ...DEFAULT_USAGE_CAPS, maxSessionPages: 1 },
    })
    expect(cappedSessions.coverage.partial).toBe(true)
    expect(cappedSessions.coverage.reasons).toContain("session-page-cap")
    expect(cappedSessions.coverage.scannedSessions).toBe(1)

    const cappedMessages = await loadUsage({
      client: fakeClient({
        sessionPages: [[s1]],
        messagePages: {
          s1: [
            [assistant("m1", NOW - 1000)],
            [assistant("m2", NOW - 2000)],
          ],
        },
      }),
      range: 7,
      scope: "all",
      now: NOW,
      caps: { ...DEFAULT_USAGE_CAPS, maxMessagePages: 1 },
    })
    expect(cappedMessages.totals.steps).toBe(1)
    expect(cappedMessages.coverage.partial).toBe(true)
    expect(cappedMessages.coverage.reasons).toContain("message-page-cap")
    expect(cappedMessages.coverage.cappedSessions).toBe(1)
  })

  test("verified monotonic ordering enables an early cutoff without partial coverage", async () => {
    const oldOne = session({
      id: "old-1",
      time: { created: NOW - 60 * 86_400_000, updated: NOW - 9 * 86_400_000 },
    })
    const oldTwo = session({
      id: "old-2",
      time: { created: NOW - 50 * 86_400_000, updated: NOW - 10 * 86_400_000 },
    })
    const summary = await loadUsage({
      client: fakeClient({
        sessionPages: [[oldOne], [oldTwo], [session({ id: "unexpected" })]],
        // If the loader pages past the verified cutoff, this throws and would
        // surface as partial coverage.
        failSessionPage: 2,
      }),
      range: 7,
      scope: "all",
      now: NOW,
    })
    expect(summary.totals.steps).toBe(0)
    expect(summary.coverage.partial).toBe(false)
    expect(summary.coverage.skippedSessions).toBe(2)
    expect(summary.coverage.sessionPages).toBe(2)
  })

  test("failed history is reported, not silently treated as complete", async () => {
    const s1 = session({ id: "s1" })
    const s2 = session({ id: "s2", location: { directory: "/work/beta" } })
    const summary = await loadUsage({
      client: fakeClient({
        sessionPages: [[s1, s2]],
        messagePages: { s1: [[assistant("m1", NOW - 1000)]] },
        failMessageSessions: ["s2"],
      }),
      range: 7,
      scope: "all",
      now: NOW,
    })
    expect(summary.totals.steps).toBe(1)
    expect(summary.coverage.partial).toBe(true)
    expect(summary.coverage.failedSessions).toBe(1)
    expect(summary.coverage.reasons).toContain("message-list-failed")
  })

  test("an aborted load never resolves with partial data", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      loadUsage({
        client: fakeClient({ sessionPages: [[session({ id: "s1" })]] }),
        range: 7,
        scope: "all",
        now: NOW,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(UsageAbortedError)
  })

  test("cache reuses only complete scans for the same local window", async () => {
    const s1 = session({ id: "s1" })
    const client = fakeClient({
      sessionPages: [[s1]],
      messagePages: { s1: [[assistant("m1", NOW - 1000)]] },
    })
    const cache = new UsageCache()
    const first = await loadUsage({ client, range: 7, scope: "all", now: NOW, cache })
    const second = await loadUsage({ client, range: 7, scope: "all", now: NOW + 60_000, cache })
    expect(second).toBe(first)

    const nextDay = new Date(2026, 10, 23, 0, 0, 1).getTime()
    const third = await loadUsage({ client, range: 7, scope: "all", now: nextDay, cache })
    expect(third).not.toBe(first)
    expect(third.window.start).not.toBe(first.window.start)
  })
})

describe("two-directory fixture across both ranges", () => {
  test("current/all scope and 7/30 day windows stay honest", async () => {
    const alpha = session({ id: "a", location: { directory: "/work/alpha" } })
    const beta = session({ id: "b", location: { directory: "/work/beta" } })
    const client = fakeClient({
      sessionPages: [[alpha, beta]],
      messagePages: {
        a: [[assistant("a-recent", NOW - 86_400_000, { cost: 0.1 }), assistant("a-older", NOW - 10 * 86_400_000, { cost: 0.2 })]],
        b: [[assistant("b-recent", NOW - 2 * 86_400_000, { cost: 0.3 })]],
      },
    })

    const sevenAll = await loadUsage({ client, range: 7, scope: "all", now: NOW })
    expect(sevenAll.totals.steps).toBe(2)
    expect(sevenAll.totals.cost).toBeCloseTo(0.4)
    expect(sevenAll.days).toHaveLength(7)

    const sevenHere = await loadUsage({
      client,
      range: 7,
      scope: "current",
      directory: "/work/alpha",
      now: NOW,
    })
    expect(sevenHere.totals.steps).toBe(1)
    expect(sevenHere.directories).toEqual([expect.objectContaining({ key: "/work/alpha" })])

    const thirtyAll = await loadUsage({ client, range: 30, scope: "all", now: NOW })
    expect(thirtyAll.totals.steps).toBe(3)
    expect(thirtyAll.totals.cost).toBeCloseTo(0.6)
    expect(thirtyAll.days).toHaveLength(30)

    const thirtyHere = await loadUsage({
      client,
      range: 30,
      scope: "current",
      directory: "/work/beta",
      now: NOW,
    })
    expect(thirtyHere.totals.steps).toBe(1)
    expect(thirtyHere.directories).toEqual([expect.objectContaining({ key: "/work/beta" })])
  })
})

describe("narrow-terminal formatting", () => {
  test("numeric labels render even when bars have no room", () => {
    expect(usageBar(5, 10, 10)).toBe("█████")
    expect(usageBar(5, 10, 0)).toBe("")
    expect(usageBar(0, 10, 10)).toBe("")
    expect(usageBar(undefined, 10, 10)).toBe("")
    expect(formatCost(1.2345)).toBe("$1.23")
    expect(formatCost(0.0004)).toBe("$0.0004")
  })
})
