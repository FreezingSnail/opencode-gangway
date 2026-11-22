import { expect, test } from "bun:test"
import {
  InboxTracker,
  buildInbox,
  emptyInboxMessage,
  eventRequestKey,
  formKey,
  inboxAgeLabel,
  inboxSources,
  inboxVisibility,
  permissionKey,
  resolveInboxSelection,
  syncInboxQueues,
  visibilityNote,
  type InboxDataStore,
  type InboxSession,
  type InboxSources,
  type InboxRow,
} from "../src/inbox"

const now = 1_000_000

function session(id: string, directory: string, title = `session ${id}`): InboxSession {
  return { id, title, metadata: { gangway: true }, location: { directory } }
}

function sources(
  queues: Array<{
    session: InboxSession
    permissions?: Array<Record<string, unknown>> | undefined
    forms?: Array<Record<string, unknown>> | undefined
  }>,
): InboxSources {
  return { sessions: queues }
}

test("builds rows across directories with owner context", () => {
  const built = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/alpha", "[gangway] alpha"),
        permissions: [{ id: "per_1", action: "bash", message: "run tests", resources: ["bun test"] }],
        forms: [],
      },
      {
        session: session("ses_b", "/work/beta", "[codex] beta"),
        permissions: [],
        forms: [{ id: "form_1", title: "Pick a target", fields: [{ key: "target", title: "Target" }] }],
      },
    ]),
    now,
    new Map([["permission:ses_a:per_1", 500]]),
  )

  expect(built.visibility.complete).toBe(true)
  expect(built.rows).toHaveLength(2)
  expect(built.rows[0]).toMatchObject({
    key: "permission:ses_a:per_1",
    kind: "permission",
    sessionID: "ses_a",
    directory: "/work/alpha",
    sessionTitle: "[gangway] alpha",
    summary: "bash · run tests",
    detail: "resources: bun test",
    ageSource: "server",
  })
  expect(built.rows[1]).toMatchObject({
    key: "form:ses_b:form_1",
    kind: "question",
    sessionID: "ses_b",
    directory: "/work/beta",
    summary: "Pick a target",
    detail: "Target",
  })
})

test("sorts known waits oldest first, then first-seen rows deterministically", () => {
  const built = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [
          { id: "new", action: "edit", resources: [] },
          { id: "old", action: "bash", resources: [] },
        ],
        forms: [{ id: "form", title: "Later question", fields: [{ key: "q" }] }],
      },
    ]),
    now,
    new Map([
      ["permission:ses_a:new", 900],
      ["permission:ses_a:old", 100],
    ]),
    new Map([["form:ses_a:form", now - 60_000]]),
  )

  expect(built.rows.map((row) => row.key)).toEqual([
    "permission:ses_a:old",
    "permission:ses_a:new",
    "form:ses_a:form",
  ])
  expect(inboxAgeLabel(built.rows[0]!, now)).toBe("waiting 16m")
  expect(inboxAgeLabel(built.rows[2]!, now)).toBe("first seen 1m ago")
})

test("first-seen observations survive later builds without pretending to be a server age", () => {
  const input = sources([
    {
      session: session("ses_a", "/work/a"),
      permissions: [{ id: "per_1", action: "edit", resources: [] }],
      forms: [],
    },
  ])
  const first = buildInbox(input, now)
  expect(first.rows[0]?.ageSource).toBe("first-seen")
  expect(first.rows[0]?.firstSeenAt).toBe(now)

  const later = buildInbox(input, now + 30_000, new Map(), first.firstSeen)
  expect(later.rows[0]?.firstSeenAt).toBe(now)
  expect(inboxAgeLabel(later.rows[0]!, now + 30_000)).toBe("first seen just now")
})

test("permission/form duplication requires an explicit shared identity", () => {
  const linked = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [
          {
            id: "per_1",
            action: "question",
            message: "Which branch?",
            resources: [],
            metadata: { formID: "form_1" },
          },
        ],
        forms: [{ id: "form_1", title: "Which branch?", fields: [{ key: "branch", title: "Branch" }] }],
      },
    ]),
    now,
  )
  expect(linked.rows).toHaveLength(1)
  expect(linked.rows[0]).toMatchObject({
    key: "permission:ses_a:per_1",
    kind: "question",
    source: "permission+form",
    requestID: "per_1",
    formID: "form_1",
    detail: "Branch",
  })

  const distinct = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [{ id: "per_1", action: "question", message: "Which branch?", resources: [] }],
        forms: [{ id: "form_1", title: "Which branch?", fields: [{ key: "branch", title: "Branch" }] }],
      },
    ]),
    now,
  )
  expect(distinct.rows).toHaveLength(2)
  expect(distinct.rows.map((row) => row.key)).toEqual(["form:ses_a:form_1", "permission:ses_a:per_1"])
})

test("multiple distinct requests from one session stay individually inspectable", () => {
  const built = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [
          { id: "per_1", action: "bash", message: "first", resources: ["a"] },
          { id: "per_2", action: "edit", message: "second", resources: ["b"] },
        ],
        forms: [{ id: "form_1", title: "third", fields: [{ key: "q" }] }],
      },
    ]),
    now,
    new Map([
      ["permission:ses_a:per_1", 100],
      ["permission:ses_a:per_2", 200],
      ["form:ses_a:form_1", 300],
    ]),
  )
  expect(built.rows.map((row) => row.key)).toEqual([
    "permission:ses_a:per_1",
    "permission:ses_a:per_2",
    "form:ses_a:form_1",
  ])
  expect(new Set(built.rows.map((row) => row.key)).size).toBe(3)
})

test("prompt previews are bounded, terminal-safe and never expose answers", () => {
  const secret = "ANSWER_SECRET"
  const long = `\u001b[31m${"x".repeat(400)}\u001b[0m\nnext\tline`
  const built = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [
          { id: "per_1", action: "bash", message: long, resources: ["\u001b[32mfile.txt\u001b[0m"] },
        ],
        forms: [
          {
            id: "form_1",
            title: long,
            fields: [
              { key: "branch", title: "Branch name", description: "Pick a branch" },
              { key: "hidden", title: "Hidden prompt", hidden: true },
              { key: "answer", title: "Visible prompt" },
            ],
            metadata: { answer: secret, authorization: secret },
          },
        ],
      },
    ]),
    now,
  )

  for (const row of built.rows) {
    expect(row.summary).not.toContain("\u001b")
    expect(row.summary.length).toBeLessThanOrEqual(160)
    expect(row.detail ?? "").not.toContain(secret)
    expect(row.detail ?? "").not.toContain("\u001b")
    expect(row.detail?.length ?? 0).toBeLessThanOrEqual(220)
  }
  const formRow = built.rows.find((row) => row.key === "form:ses_a:form_1")
  expect(formRow?.detail).toBe("Branch name — Pick a branch · Visible prompt")
})

test("unsynced, partial and failed queues are represented honestly", () => {
  const partial = sources([
    {
      session: session("ses_a", "/work/a"),
      permissions: undefined,
      forms: [],
    },
    {
      session: session("ses_b", "/work/b"),
      permissions: [],
      forms: [],
    },
  ])
  const visibility = inboxVisibility(partial)
  expect(visibility.complete).toBe(false)
  expect(visibility.permissionUnsynced).toEqual(["ses_a"])
  expect(visibilityNote(visibility)).toContain("1 permission queue(s) not synced yet")
  expect(emptyInboxMessage(partial, visibility)).toContain("Visibility is incomplete")

  const complete = buildInbox(
    sources([{ session: session("ses_a", "/work/a"), permissions: [], forms: [] }]),
    now,
  )
  expect(complete.visibility.complete).toBe(true)
  expect(complete.rows).toHaveLength(0)
  expect(complete.note).toBeUndefined()
  expect(complete.emptyMessage).toBe("No pending approvals or questions.")

  const tracker = new InboxTracker()
  tracker.markSyncFailure("ses_a", "permission")
  const failed = buildInbox(
    sources([{ session: session("ses_a", "/work/a"), permissions: undefined, forms: [] }]),
    now,
    new Map(),
    new Map(),
    tracker.failures(),
  )
  expect(visibilityNote(failed.visibility)).toContain("failed to sync")
})

test("no sessions and unavailable queues each read distinctly", () => {
  const none = inboxVisibility({ sessions: [] })
  expect(emptyInboxMessage({ sessions: [] }, none)).toContain("No Gangway sessions found")
})

test("selection follows the request key across reorders and clamps after removal", () => {
  const row = (key: string): InboxRow => ({
    key,
    kind: "permission",
    source: "permission",
    sessionID: "ses",
    sessionTitle: "s",
    directory: "/work",
    summary: key,
    firstSeenAt: now,
    ageSource: "first-seen",
    sortTime: now,
  })
  const rows = [row("a"), row("b"), row("c")]

  expect(resolveInboxSelection(rows, "b", 0)).toEqual({ index: 1, key: "b" })
  expect(resolveInboxSelection([row("b"), row("a")], "b", 2)).toEqual({ index: 0, key: "b" })
  expect(resolveInboxSelection([row("a"), row("c")], "b", 1)).toEqual({ index: 1, key: "c" })
  expect(resolveInboxSelection([row("a"), row("c")], "missing", 9)).toEqual({ index: 1, key: "c" })
  expect(resolveInboxSelection([], "a", 2)).toEqual({ index: 0, key: undefined })
})

test("tracker records event times and ignores invalid timestamps", () => {
  const tracker = new InboxTracker()
  tracker.noteEvent({
    type: "permission.asked",
    created: 1234,
    data: { id: "per_1", sessionID: "ses_a" },
  })
  tracker.noteEvent({
    type: "form.created",
    created: 0,
    data: { form: { id: "form_1", sessionID: "ses_a" } },
  })

  const built = tracker.build(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [{ id: "per_1", action: "bash", resources: [] }],
        forms: [{ id: "form_1", title: "Question", fields: [{ key: "q" }] }],
      },
    ]),
    now,
  )
  expect(built.rows.find((row) => row.key === "permission:ses_a:per_1")?.createdAt).toBe(1234)
  expect(built.rows.find((row) => row.key === "form:ses_a:form_1")?.ageSource).toBe("first-seen")
})

test("queue removal on answer or cancel removes only that row and keeps selection predictable", () => {
  const before = sources([
    {
      session: session("ses_a", "/work/a"),
      permissions: [
        { id: "per_1", action: "bash", resources: [] },
        { id: "per_2", action: "edit", resources: [] },
      ],
      forms: [{ id: "form_1", title: "Question", fields: [{ key: "q" }] }],
    },
  ])
  const first = buildInbox(
    before,
    now,
    new Map([
      ["permission:ses_a:per_1", 100],
      ["permission:ses_a:per_2", 200],
      ["form:ses_a:form_1", 300],
    ]),
  )
  expect(resolveInboxSelection(first.rows, "permission:ses_a:per_2", 0)).toEqual({
    index: 1,
    key: "permission:ses_a:per_2",
  })

  const afterPermissionReply = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [{ id: "per_2", action: "edit", resources: [] }],
        forms: [{ id: "form_1", title: "Question", fields: [{ key: "q" }] }],
      },
    ]),
    now,
    new Map([
      ["permission:ses_a:per_2", 200],
      ["form:ses_a:form_1", 300],
    ]),
  )
  expect(afterPermissionReply.rows.map((row) => row.key)).toEqual([
    "permission:ses_a:per_2",
    "form:ses_a:form_1",
  ])
  expect(resolveInboxSelection(afterPermissionReply.rows, "permission:ses_a:per_2", 1)).toEqual({
    index: 0,
    key: "permission:ses_a:per_2",
  })

  const afterSelectedGone = buildInbox(
    sources([
      {
        session: session("ses_a", "/work/a"),
        permissions: [],
        forms: [{ id: "form_1", title: "Question", fields: [{ key: "q" }] }],
      },
    ]),
    now,
  )
  expect(resolveInboxSelection(afterSelectedGone.rows, "permission:ses_a:per_2", 0)).toEqual({
    index: 0,
    key: "form:ses_a:form_1",
  })
})

test("a live event clears an earlier sync failure for that queue", () => {
  const tracker = new InboxTracker()
  tracker.markSyncFailure("ses_a", "permission")
  tracker.markSyncFailure("ses_a", "form")
  tracker.noteEvent({ type: "permission.asked", created: 10, data: { id: "per_1", sessionID: "ses_a" } })

  expect([...tracker.failures().permission!]).toEqual([])
  expect([...tracker.failures().form!]).toEqual(["ses_a"])
})

test("event keys match the stable row keys", () => {
  expect(permissionKey("ses_a", { id: "per_1" })).toBe("permission:ses_a:per_1")
  expect(formKey("ses_a", { id: "form_1" })).toBe("form:ses_a:form_1")
  expect(eventRequestKey({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_a" } })).toBe(
    "permission:ses_a:per_1",
  )
  expect(eventRequestKey({ type: "form.created", data: { form: { id: "form_1", sessionID: "ses_a" } } })).toBe(
    "form:ses_a:form_1",
  )
  expect(eventRequestKey({ type: "permission.replied", data: { sessionID: "ses_a" } })).toBeUndefined()
})

function fakeData(options: {
  sessions: InboxSession[]
  permissions: Map<string, Array<Record<string, unknown>> | undefined>
  forms: Map<string, Array<Record<string, unknown>> | undefined>
  failPermission?: Set<string>
  failForm?: Set<string>
  log: string[]
}): InboxDataStore {
  const get = (map: Map<string, unknown>, id: string) => map.get(id) as never
  return {
    session: {
      list: () => options.sessions,
      get: (id) => options.sessions.find((item) => item.id === id),
      permission: {
        list: (id) => get(options.permissions, id),
        sync: async (id) => {
          options.log.push(`permission:${id}`)
          if (options.failPermission?.has(id)) throw new Error("permission sync failed")
          options.permissions.set(id, [])
        },
      },
      form: {
        list: (id) => get(options.forms, id),
        sync: async (id) => {
          options.log.push(`form:${id}`)
          if (options.failForm?.has(id)) throw new Error("form sync failed")
          options.forms.set(id, [])
        },
      },
    },
  }
}

test("syncs only unresolved queues and records failures", async () => {
  const a = session("ses_a", "/work/a")
  const b = session("ses_b", "/work/b")
  const log: string[] = []
  const data = fakeData({
    sessions: [a, b],
    permissions: new Map([
      ["ses_a", undefined],
      ["ses_b", []],
    ]),
    forms: new Map([
      ["ses_a", undefined],
      ["ses_b", undefined],
    ]),
    failForm: new Set(["ses_a"]),
    log,
  })
  const tracker = new InboxTracker()

  await syncInboxQueues(data, [a, b], tracker)

  expect(log.sort()).toEqual(["form:ses_a", "form:ses_b", "permission:ses_a"])
  expect([...tracker.failures().form!]).toEqual(["ses_a"])
  expect([...tracker.failures().permission!]).toEqual([])
})

test("inboxSources keeps root gangway sessions only", () => {
  const root = session("ses_root", "/work/a")
  const child: InboxSession = { ...session("ses_child", "/work/a"), parentID: "ses_root" }
  const foreign = { ...session("ses_foreign", "/work/a"), metadata: {} }
  const log: string[] = []
  const data = fakeData({
    sessions: [root, child, foreign],
    permissions: new Map(),
    forms: new Map(),
    log,
  })
  const result = inboxSources(data)
  expect(result.sessions.map((entry) => entry.session.id)).toEqual(["ses_root"])
})
