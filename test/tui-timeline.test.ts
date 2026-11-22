import { expect, test } from "bun:test"
import {
  TIMELINE_EVENT_LIMIT,
  applyTimelineEvent,
  applyTimelineHistory,
  createTimelineState,
  readTimelineHistory,
  setTimelineCoverage,
  timelineIsPartial,
  timelineNotice,
  timelineOutcome,
  type TimelineInputEvent,
  type TimelineState,
} from "../src/tui-timeline"

const SESSION = "ses_test"

function durable(
  type: string,
  seq: number,
  created: number,
  data: Record<string, unknown> = {},
  id = `evt_${seq}`,
): TimelineInputEvent {
  return {
    id,
    created,
    type,
    durable: { aggregateID: SESSION, seq },
    data: { sessionID: SESSION, ...data },
  }
}

function live(type: string, created: number, data: Record<string, unknown> = {}, id = `${type}:${created}`): TimelineInputEvent {
  return { id, created, type, data: { sessionID: SESSION, ...data } }
}

function applyMany(state: TimelineState, events: readonly TimelineInputEvent[]): TimelineState {
  return events.reduce(applyTimelineEvent, state)
}

function kinds(state: TimelineState): string[] {
  return state.events.map((event) => event.kind)
}

test("projects prompts, execution, tools, attention and a terminal outcome in time order", () => {
  const state = applyMany(createTimelineState(SESSION), [
    durable("session.inbox.delivered", 1, 50, { inboxID: "msg_1" }),
    durable("session.execution.started", 2, 60),
    live("permission.asked", 70, { id: "perm_1", action: "write", resources: ["a.ts"] }),
    durable("session.tool.input.started", 3, 100, { assistantMessageID: "asst_1", id: "tool_1", name: "read" }),
    durable("session.tool.called", 4, 110, { assistantMessageID: "asst_1", id: "tool_1", input: { filePath: "a.ts" } }),
    durable("session.tool.success", 5, 120, { assistantMessageID: "asst_1", id: "tool_1", content: [] }),
    durable("session.execution.succeeded", 6, 130),
    live("session.idle", 140),
  ])

  expect(kinds(state)).toEqual([
    "idle",
    "run.finish",
    "tool.finish",
    "tool.start",
    "attention.request",
    "run.start",
    "prompt",
  ])
  expect(state.events.map((event) => event.label)).toEqual([
    "Session idle",
    "Run finished",
    "Tool read finished",
    "Tool read started",
    "Permission requested",
    "Run started",
    "Prompt delivered",
  ])
  expect(state.lastActivityAt).toBe(140)
  expect(state.events.some((event) => JSON.stringify(event).includes("a.ts"))).toBe(false)
})

test("filters other sessions and ignores streaming and content updates", () => {
  const state = applyMany(createTimelineState(SESSION), [
    { ...durable("session.execution.started", 1, 10), data: { sessionID: "ses_other" } },
    { ...durable("session.execution.started", 2, 20), data: { sessionID: "ses_other" } },
    live("session.text.delta", 30, { assistantMessageID: "asst_1", text: "tok" }),
    live("session.reasoning.delta", 31, { assistantMessageID: "asst_1", text: "tok" }),
    live("session.tool.progress", 32, { assistantMessageID: "asst_1", id: "tool_1" }),
    live("session.message.content.updated", 33, { assistantMessageID: "asst_1", content: [] }),
    durable("session.execution.succeeded", 3, 40),
    { type: "log.synced", aggregateID: SESSION },
  ])

  expect(kinds(state)).toEqual(["run.finish"])
})

test("tool completions correlate by assistant message and tool id, with a generic fallback", () => {
  const correlated = applyMany(createTimelineState(SESSION), [
    durable("session.tool.input.started", 1, 10, { assistantMessageID: "asst_9", id: "tool_9", name: "bash" }),
    durable("session.tool.failed", 2, 20, { assistantMessageID: "asst_9", id: "tool_9", error: { message: "boom" } }),
  ])
  expect(correlated.events[0]?.label).toBe("Tool bash failed")
  expect(JSON.stringify(correlated.events)).not.toContain("boom")

  const partial = applyMany(createTimelineState(SESSION), [
    durable("session.tool.success", 1, 10, { assistantMessageID: "asst_1", id: "tool_1", content: [] }),
    durable("session.tool.called", 2, 20, { assistantMessageID: "asst_1", id: "tool_2" }),
  ])
  expect(partial.events.map((event) => event.label)).toEqual(["Tool started", "Tool finished"])
})

test("history and live overlap dedupe on the durable sequence, and a live event survives replay", () => {
  const started = durable("session.execution.started", 1, 10)
  const finished = durable("session.execution.succeeded", 2, 20)

  const liveFirst = applyTimelineEvent(createTimelineState(SESSION), finished)
  const replayed = applyTimelineHistory(liveFirst, [started, finished])

  expect(kinds(replayed)).toEqual(["run.finish", "run.start"])
  expect(replayed.events.map((event) => event.key)).toEqual(["d:ses_test:2", "d:ses_test:1"])

  const overlap = applyTimelineEvent(applyTimelineEvent(createTimelineState(SESSION), started), {
    ...started,
    id: "different-live-id",
  })
  expect(overlap.events).toHaveLength(1)

  const asked = live("permission.asked", 30, { id: "p" }, "permission-p")
  const sameID = applyTimelineEvent(applyTimelineEvent(createTimelineState(SESSION), asked), {
    ...asked,
    created: 31,
  })
  expect(sameID.events).toHaveLength(1)
})

test("late events reorder predictably without dropping earlier live results", () => {
  const state = applyMany(createTimelineState(SESSION), [
    durable("session.execution.started", 3, 300),
    durable("session.execution.started", 1, 100),
    durable("session.execution.succeeded", 2, 200),
  ])

  expect(state.events.map((event) => event.at)).toEqual([300, 200, 100])
})

test("the retained trail is bounded and evicts the oldest events", () => {
  let state = createTimelineState(SESSION)
  for (let index = 1; index <= TIMELINE_EVENT_LIMIT + 10; index += 1) {
    state = applyTimelineEvent(state, durable("session.execution.started", index, index * 10))
  }

  expect(state.events).toHaveLength(TIMELINE_EVENT_LIMIT)
  expect(state.events[0]?.at).toBe((TIMELINE_EVENT_LIMIT + 10) * 10)
  expect(state.events.at(-1)?.at).toBe(110)
  expect(state.evicted).toBe(true)
  expect(timelineIsPartial(state)).toBe(true)
})

test("history reads are capped and retain the newest window while marking partial coverage", async () => {
  async function* stream(count: number) {
    for (let index = 1; index <= count; index += 1) yield durable("session.execution.started", index, index * 10)
  }

  const bounded = await readTimelineHistory(stream(300), { limit: 200, retain: 10 })
  expect(bounded.total).toBe(201)
  expect(bounded.items).toHaveLength(10)
  expect(bounded.items.at(-1)?.created).toBe(2010)
  expect(bounded.partial).toBe(true)

  const complete = await readTimelineHistory(stream(5), { limit: 200, retain: 10 })
  expect(complete.total).toBe(5)
  expect(complete.items).toHaveLength(5)
  expect(complete.partial).toBe(false)
})

test("failed or unsupported history still accepts live events", () => {
  const unsupported = applyTimelineEvent(
    setTimelineCoverage(createTimelineState(SESSION), { status: "unsupported" }),
    durable("session.execution.succeeded", 1, 10),
  )
  expect(unsupported.coverage.status).toBe("unsupported")
  expect(kinds(unsupported)).toEqual(["run.finish"])

  const failed = applyTimelineEvent(
    setTimelineCoverage(createTimelineState(SESSION), { status: "error", detail: "404" }),
    live("session.idle", 20),
  )
  expect(failed.coverage.status).toBe("error")
  expect(kinds(failed)).toEqual(["idle"])
})

test("outcome keeps running and idle explicit, and surfaces terminal states", () => {
  const terminal = applyMany(createTimelineState(SESSION), [
    durable("session.execution.started", 1, 10),
    durable("session.execution.failed", 2, 20),
  ])
  expect(timelineOutcome(terminal.events, "idle")).toBe("failed")
  expect(timelineOutcome(terminal.events, "running")).toBe("running")

  const interrupted = applyTimelineEvent(createTimelineState(SESSION), live("session.execution.interrupted", 30, { reason: "user" }))
  expect(timelineOutcome(interrupted.events, "idle")).toBe("interrupted")

  expect(timelineOutcome([], "idle")).toBe("idle")
})

test("activity age advances on newer activity and a late replay never moves it backwards", () => {
  const state = applyMany(createTimelineState(SESSION), [
    durable("session.execution.started", 2, 200),
    durable("session.execution.started", 1, 100),
  ])
  expect(state.lastActivityAt).toBe(200)
})

test("coverage copy labels unsupported, failed and partial history honestly", () => {
  const unsupported = timelineNotice(setTimelineCoverage(createTimelineState(SESSION), { status: "unsupported" }))
  expect(unsupported?.warning).toBe(true)
  expect(unsupported?.text).toContain("live activity only")

  const failed = timelineNotice(setTimelineCoverage(createTimelineState(SESSION), { status: "error", detail: "404" }))
  expect(failed?.warning).toBe(true)
  expect(failed?.text).toContain("404")

  const partial = timelineNotice(
    applyTimelineEvent(
      setTimelineCoverage(createTimelineState(SESSION), { status: "ready", partial: true }),
      durable("session.execution.started", 1, 10),
    ),
  )
  expect(partial?.warning).toBe(false)
  expect(partial?.text).toContain("partial")

  const empty = timelineNotice(setTimelineCoverage(createTimelineState(SESSION), { status: "ready", partial: false }))
  expect(empty?.text).toContain("No activity")
})
