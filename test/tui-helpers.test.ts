import { expect, test } from "bun:test"
import {
  applyGangwayFilter,
  classifyNeedsInput,
  countWaitingSessions,
  formatAge,
  hasGangwayMarker,
  isActiveSession,
  isGangwaySession,
  modelLabel,
  sessionGlyph,
  titleLabel,
  truncateHead,
  truncatePath,
  type NeedsInput,
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

test("isGangwaySession matches the neutral metadata marker", () => {
  expect(isGangwaySession(makeSession({ metadata: { gangway: true } }))).toBe(true)
})

test("isGangwaySession matches the legacy metadata marker", () => {
  expect(isGangwaySession(makeSession({ metadata: { codexMcp: true } }))).toBe(true)
})

test("isGangwaySession matches the neutral title prefix", () => {
  expect(isGangwaySession(makeSession({ title: "[gangway] fix the build" }))).toBe(true)
})

test("isGangwaySession matches the legacy title prefix", () => {
  expect(isGangwaySession(makeSession({ title: "[codex] fix the build" }))).toBe(true)
})

test("isGangwaySession ignores marker-like values and partial prefixes", () => {
  expect(isGangwaySession(makeSession({ metadata: { gangway: false } }))).toBe(false)
  expect(isGangwaySession(makeSession({ metadata: { codexMcp: "true" } }))).toBe(false)
  expect(isGangwaySession(makeSession({ title: "prefix [gangway] fix" }))).toBe(false)
  expect(isGangwaySession(makeSession({ title: "[codexish] fix" }))).toBe(false)
  expect(isGangwaySession(makeSession({ title: "my session" }))).toBe(false)
  expect(isGangwaySession(makeSession({}))).toBe(false)
})

test("hasGangwayMarker accepts event-shaped data without extra fields", () => {
  expect(hasGangwayMarker({ metadata: { gangway: true } })).toBe(true)
  expect(hasGangwayMarker({ metadata: { codexMcp: true } })).toBe(true)
  expect(hasGangwayMarker({ title: "[gangway] task" })).toBe(true)
  expect(hasGangwayMarker({ title: "[codex] task" })).toBe(true)
  expect(hasGangwayMarker({})).toBe(false)
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

test("isActiveSession counts busy sessions and unanswered prompts as active", () => {
  expect(isActiveSession("running")).toBe(true)
  expect(isActiveSession("idle")).toBe(false)
  expect(isActiveSession("idle", { kind: "question" })).toBe(true)
  expect(isActiveSession("idle", { kind: "permission" })).toBe(true)
  expect(isActiveSession("running", { kind: "permission" })).toBe(true)
})

test("classifyNeedsInput treats unknown lists as no attention", () => {
  expect(classifyNeedsInput({})).toBeUndefined()
  expect(classifyNeedsInput({ permissions: undefined, forms: undefined })).toBeUndefined()
  expect(classifyNeedsInput({ permissions: [], forms: [] })).toBeUndefined()
  expect(classifyNeedsInput({ permissions: undefined, forms: [] })).toBeUndefined()
  expect(classifyNeedsInput({ permissions: [], forms: undefined })).toBeUndefined()
})

test("classifyNeedsInput maps permission actions and forms", () => {
  expect(classifyNeedsInput({ permissions: [{ action: "edit" }] })).toEqual({ kind: "permission" })
  expect(classifyNeedsInput({ permissions: [{ action: "question" }] })).toEqual({ kind: "question" })
  expect(classifyNeedsInput({ permissions: undefined, forms: [{}] })).toEqual({ kind: "question" })
})

test("classifyNeedsInput gives permission requests precedence over questions", () => {
  expect(
    classifyNeedsInput({ permissions: [{ action: "question" }, { action: "bash" }], forms: [{}] }),
  ).toEqual({ kind: "permission" })
  expect(classifyNeedsInput({ permissions: [{ action: "question" }], forms: [{}] })).toEqual({
    kind: "question",
  })
})

test("sessionGlyph prioritizes attention over busy/idle", () => {
  expect(sessionGlyph("running")).toBe("▶")
  expect(sessionGlyph("idle")).toBe("○")
  expect(sessionGlyph("running", { kind: "permission" })).toBe("!")
  expect(sessionGlyph("idle", { kind: "permission" })).toBe("!")
  expect(sessionGlyph("running", { kind: "question" })).toBe("?")
  expect(sessionGlyph("idle", { kind: "question" })).toBe("?")
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

test("applyGangwayFilter keeps waiting sessions and sorts them ahead of merely-running ones", () => {
  const now = 1_000_000_000
  const status: Record<string, "idle" | "running"> = {}
  const attention: Record<string, NeedsInput | undefined> = {}
  const mk = (id: string, directory: string, running: boolean, needs?: NeedsInput): SessionInfo => {
    status[id] = running ? "running" : "idle"
    attention[id] = needs
    return makeSession({ id, location: { directory }, time: { created: now, updated: now } })
  }
  const busyHere = mk("a", "/work/foo", true)
  const waitingHere = mk("b", "/work/foo", false, { kind: "question" })
  const waitingElsewhere = mk("c", "/work/bar", false, { kind: "permission" })
  const doneHere = mk("d", "/work/foo", false)
  const busyElsewhere = mk("e", "/work/bar", true)
  const sessions = [busyHere, waitingHere, waitingElsewhere, doneHere, busyElsewhere]

  const options = {
    directory: "/work/foo",
    status: (s: SessionInfo) => status[s.id]!,
    attention: (s: SessionInfo) => attention[s.id],
  }
  expect(applyGangwayFilter(sessions, "all", options).map((s) => s.id)).toEqual(["a", "b", "c", "d", "e"])
  expect(applyGangwayFilter(sessions, "active", options).map((s) => s.id)).toEqual(["b", "c", "a", "e"])
  expect(applyGangwayFilter(sessions, "here", options).map((s) => s.id)).toEqual(["b", "a"])
  expect(applyGangwayFilter(sessions, "here", { ...options, directory: undefined }).map((s) => s.id)).toEqual([
    "b",
    "c",
    "a",
    "e",
  ])
})

test("applyGangwayFilter treats unknown attention as idle", () => {
  const now = 1_000_000_000
  const idle = makeSession({ id: "a", time: { created: now, updated: now } })
  const options = {
    directory: idle.location.directory,
    status: () => "idle" as const,
    attention: () => undefined,
  }
  expect(applyGangwayFilter([idle], "active", options)).toEqual([])
})

test("countWaitingSessions counts only sessions with known attention", () => {
  const a = makeSession({ id: "a" })
  const b = makeSession({ id: "b" })
  const c = makeSession({ id: "c" })
  const attention: Record<string, NeedsInput | undefined> = {
    a: { kind: "permission" },
    b: undefined,
    c: { kind: "question" },
  }
  expect(countWaitingSessions([a, b, c], (session) => attention[session.id])).toBe(2)
  expect(countWaitingSessions([a, b, c], () => undefined)).toBe(0)
  expect(countWaitingSessions([a, b, c], undefined)).toBe(0)
})
