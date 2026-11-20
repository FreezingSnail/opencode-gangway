import { expect, test } from "bun:test"
import {
  applyGangwayFilter,
  formatAge,
  isActiveSession,
  isGangwaySession,
  modelLabel,
  titleLabel,
  truncateHead,
  truncatePath,
} from "../src/tui-helpers"
import type { SessionInfo } from "@opencode/client"

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_1",
    projectID: "prj_1",
    cost: 0,
    tokens: { input: 0, output: 0 },
    time: { created: 1000, updated: 1000 },
    location: { directory: "/work/foo" },
    ...overrides,
  }
}

test("isGangwaySession matches metadata marker", () => {
  expect(isGangwaySession(makeSession({ metadata: { codexMcp: true } }))).toBe(true)
})

test("isGangwaySession matches legacy title prefix", () => {
  expect(isGangwaySession(makeSession({ title: "[codex] fix the build" }))).toBe(true)
})

test("isGangwaySession rejects ordinary sessions", () => {
  expect(isGangwaySession(makeSession({ title: "my session" }))).toBe(false)
  expect(isGangwaySession(makeSession({}))).toBe(false)
})

test("titleLabel falls back for untitled sessions", () => {
  expect(titleLabel(makeSession({ title: "hello" }))).toBe("hello")
  expect(titleLabel(makeSession({}))).toBe("(untitled)")
})

test("modelLabel uses model id and omits when unset", () => {
  expect(modelLabel(makeSession({ model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } }))).toBe(
    "deepseek-v4.1-flash",
  )
  expect(modelLabel(makeSession({}))).toBe("")
})

test("formatAge buckets by age", () => {
  const now = 1_000_000_000
  expect(formatAge(now, now)).toBe("now")
  expect(formatAge(now - 30_000, now)).toBe("now")
  expect(formatAge(now - 5 * 60_000, now)).toBe("5m")
  expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h")
  expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d")
  const old = new Date(now - 9 * 86_400_000)
  expect(formatAge(old.getTime(), now)).toBe(`${old.getMonth() + 1}/${old.getDate()}`)
})

test("isActiveSession treats running and recently-updated sessions as active", () => {
  const now = 1_000_000_000
  const freshIdle = makeSession({ time: { created: now - 120_000, updated: now - 30_000 } })
  expect(isActiveSession(freshIdle, "idle", now)).toBe(true)
  expect(isActiveSession(makeSession({ time: { created: now, updated: now - 2 * 3_600_000 } }), "idle", now)).toBe(
    false,
  )
  const staleRunning = makeSession({ time: { created: now, updated: now - 2 * 3_600_000 } })
  expect(isActiveSession(staleRunning, "running", now)).toBe(true)
})

test("truncateHead and truncatePath keep content within bounds", () => {
  expect(truncateHead("deepseek-v4.1-flash", 22)).toBe("deepseek-v4.1-flash")
  expect(truncateHead("deepseek-v4.1-flash", 10)).toBe("deepseek-…")
  expect(truncatePath("/Users/me/dev/gangway", 30)).toBe("/Users/me/dev/gangway")
  expect(truncatePath("/Users/me/dev/a/very/long/path/name", 16)).toBe("…/long/path/name")
})

test("applyGangwayFilter partitions by activity and directory", () => {
  const now = 1_000_000_000
  const status: Record<string, "idle" | "running"> = {}
  const mk = (id: string, directory: string, updated: number): SessionInfo => {
    status[id] = "idle"
    return makeSession({ id, location: { directory }, time: { created: updated, updated } })
  }
  const inDir = mk("a", "/work/foo", now - 60_000)
  const otherDir = mk("b", "/work/bar", now - 60_000)
  const stale = mk("c", "/work/foo", now - 2 * 3_600_000)
  const sessions = [inDir, otherDir, stale]

  const options = { directory: "/work/foo", now, status: (s: SessionInfo) => status[s.id]! }
  expect(applyGangwayFilter(sessions, "all", options).map((s) => s.id)).toEqual(["a", "b", "c"])
  expect(applyGangwayFilter(sessions, "active", options).map((s) => s.id)).toEqual(["a", "b"])
  expect(applyGangwayFilter(sessions, "here", options).map((s) => s.id)).toEqual(["a"])
  expect(applyGangwayFilter(sessions, "here", { ...options, directory: undefined }).map((s) => s.id)).toEqual([
    "a",
    "b",
  ])
})
