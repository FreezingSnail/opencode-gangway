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

test("isActiveSession counts only busy sessions as active", () => {
  expect(isActiveSession("running")).toBe(true)
  expect(isActiveSession("idle")).toBe(false)
})

test("truncateHead and truncatePath keep content within bounds", () => {
  expect(truncateHead("deepseek-v4.1-flash", 22)).toBe("deepseek-v4.1-flash")
  expect(truncateHead("deepseek-v4.1-flash", 10)).toBe("deepseek-…")
  expect(truncatePath("/Users/me/dev/gangway", 30)).toBe("/Users/me/dev/gangway")
  expect(truncatePath("/Users/me/dev/a/very/long/path/name", 16)).toBe("…/long/path/name")
})

test("applyGangwayFilter evicts completed sessions from active views", () => {
  const now = 1_000_000_000
  const status: Record<string, "idle" | "running"> = {}
  const mk = (id: string, directory: string, running: boolean): SessionInfo => {
    status[id] = running ? "running" : "idle"
    return makeSession({ id, location: { directory }, time: { created: now, updated: now } })
  }
  const busyHere = mk("a", "/work/foo", true)
  const doneFresh = mk("b", "/work/foo", false)
  const doneStale = mk("c", "/work/foo", false)
  const busyElsewhere = mk("d", "/work/bar", true)
  const sessions = [busyHere, doneFresh, doneStale, busyElsewhere]

  const options = { directory: "/work/foo", status: (s: SessionInfo) => status[s.id]! }
  expect(applyGangwayFilter(sessions, "all", options).map((s) => s.id)).toEqual(["a", "b", "c", "d"])
  expect(applyGangwayFilter(sessions, "active", options).map((s) => s.id)).toEqual(["a", "d"])
  expect(applyGangwayFilter(sessions, "here", options).map((s) => s.id)).toEqual(["a"])
  expect(applyGangwayFilter(sessions, "here", { ...options, directory: undefined }).map((s) => s.id)).toEqual([
    "a",
    "d",
  ])
})
