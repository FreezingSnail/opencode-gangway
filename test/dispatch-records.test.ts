import { describe, expect, test } from "bun:test"
import {
  DISPATCH_SCAN_MAX,
  lookupLatestDispatch,
  summarizeDispatch,
  type DispatchStorage,
} from "../src/dispatch-records"

// Deterministic offline coverage for the read-only operation-record lookup. The
// storage below is the same paged shape the OpenCode plugin exposes; no service
// or provider is involved.

class MemoryStorage implements DispatchStorage {
  readonly map = new Map<string, unknown>()
  scanCalls = 0
  writes = 0

  async set(key: string, value: unknown): Promise<void> {
    this.writes += 1
    this.map.set(key, value)
  }

  async get(key: string): Promise<unknown> {
    return this.map.has(key) ? JSON.parse(JSON.stringify(this.map.get(key))) : null
  }

  async scan(input: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>
    next?: string
  }> {
    this.scanCalls += 1
    const keys = [...this.map.keys()].filter((key) => key.startsWith(input.prefix)).sort()
    const start = input.after ? keys.indexOf(input.after) + 1 : 0
    const limit = input.limit ?? 100
    const page = keys.slice(start, start + limit)
    const next = start + page.length < keys.length ? page.at(-1) : undefined
    return {
      entries: page.map((key) => ({ key, value: JSON.parse(JSON.stringify(this.map.get(key))) })),
      ...(next ? { next } : {}),
    }
  }
}

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestID: "req-1",
    kind: "start",
    identity: { prompt: "SECRET PROMPT" },
    identityHash: "hash",
    state: "submitted",
    sessionID: "ses_target",
    boundary: 1,
    submittedAt: 1_100,
    submittedMessageID: "msg_secret",
    delivery: "recorded",
    createdAt: 1_000,
    updatedAt: 1_200,
    completion: { text: "SECRET COMPLETION", outputId: "out" },
    lastOutputId: "out",
    error: null,
    ...overrides,
  }
}

function store(key: string, value: unknown): MemoryStorage {
  const storage = new MemoryStorage()
  storage.map.set(key, value)
  return storage
}

describe("lookupLatestDispatch", () => {
  test("finds a follow-up even though sessions/<id> only stores the start request", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/a", operation({ requestID: "req-start", kind: "start", createdAt: 100 }))
    storage.map.set(
      "operations/b",
      operation({
        requestID: "req-follow",
        kind: "prompt",
        createdAt: 300,
        updatedAt: 350,
        delivery: "unknown",
        state: "submitting",
      }),
    )
    storage.map.set("operations/c", operation({ requestID: "req-foreign", sessionID: "ses_other", createdAt: 400 }))
    storage.map.set("sessions/ses_target", {
      sessionID: "ses_target",
      requestID: "req-start",
      title: "start request only",
    })

    const result = await lookupLatestDispatch(storage, "ses_target")

    expect(result.reason).toBe("recorded")
    expect(result.coverage).toBe("complete")
    expect(result.operation?.requestID).toBe("req-follow")
    expect(result.operation?.kind).toBe("follow-up")
    expect(result.operation?.delivery).toBe("unknown")
    expect(result.operation?.state).toBe("submitting")
    expect(result.operation?.status).toBe("unknown")
    expect(storage.writes).toBe(0)
  })

  test("never returns another session's operation", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/foreign", operation({ requestID: "req-foreign", sessionID: "ses_other" }))
    storage.map.set("sessions/ses_target", { sessionID: "ses_target" })

    const result = await lookupLatestDispatch(storage, "ses_target")
    expect(result.operation).toBeNull()
    expect(result.reason).toBe("legacy")
    expect(JSON.stringify(result)).not.toContain("req-foreign")
  })

  test("an ambiguous creation without a session handle cannot match a selected session", async () => {
    const storage = new MemoryStorage()
    storage.map.set(
      "operations/ambiguous",
      operation({ requestID: "req-ambiguous", sessionID: null, state: "unknown", delivery: "unknown" }),
    )

    const result = await lookupLatestDispatch(storage, "ses_target")
    expect(result.operation).toBeNull()
    expect(result.reason).toBe("none")
  })

  test("reports legacy sessions and genuinely empty sessions distinctly", async () => {
    const legacy = store("sessions/ses_old", { sessionID: "ses_old", requestID: "req-old" })
    const empty = new MemoryStorage()

    expect(await lookupLatestDispatch(legacy, "ses_old")).toMatchObject({
      reason: "legacy",
      operation: null,
      coverage: "complete",
    })
    expect(await lookupLatestDispatch(empty, "ses_missing")).toMatchObject({
      reason: "none",
      operation: null,
      coverage: "complete",
    })
  })

  test("keeps unknown states and delivery unknown instead of inventing success", async () => {
    const storage = new MemoryStorage()
    storage.map.set(
      "operations/unknown",
      operation({
        state: "submitting",
        delivery: "unknown",
        error: "\u001b[31mupstream failed\u001b[0m\nsecret",
      }),
    )

    const result = await lookupLatestDispatch(storage, "ses_target")
    expect(result.operation).toMatchObject({
      state: "submitting",
      status: "unknown",
      delivery: "unknown",
      error: "upstream failed secret",
    })
  })

  test("redacts credential-shaped text before exposing a short error", async () => {
    const storage = new MemoryStorage()
    storage.map.set(
      "operations/secret",
      operation({
        state: "failed",
        delivery: "unknown",
        error: "request failed: token=abc123 password=hunter2 Basic dXNlcjpwYXNz",
      }),
    )

    const result = await lookupLatestDispatch(storage, "ses_target")
    const error = result.operation?.error ?? ""
    expect(error).toContain("[redacted]")
    expect(error).not.toContain("abc123")
    expect(error).not.toContain("hunter2")
    expect(error).not.toContain("dXNlcjpwYXNz")
  })

  test("compares timestamps deterministically with a requestID tiebreak", async () => {
    const storage = new MemoryStorage()
    storage.map.set("operations/a", operation({ requestID: "req-a", createdAt: 100, updatedAt: 100 }))
    storage.map.set("operations/b", operation({ requestID: "req-b", createdAt: 100, updatedAt: 200 }))
    storage.map.set("operations/c", operation({ requestID: "req-c", createdAt: 100, updatedAt: 200 }))

    const result = await lookupLatestDispatch(storage, "ses_target")
    expect(result.operation?.requestID).toBe("req-c")
  })

  test("caps the scan, marks limited coverage and still names the latest found", async () => {
    const storage = new MemoryStorage()
    storage.map.set(
      "operations/0000",
      operation({ requestID: "req-target", createdAt: 10, updatedAt: 10 }),
    )
    for (let index = 1; index <= DISPATCH_SCAN_MAX; index += 1) {
      storage.map.set(
        `operations/${index.toString().padStart(4, "0")}`,
        operation({ requestID: `req-${index}`, sessionID: `ses_other_${index}`, createdAt: index }),
      )
    }

    const result = await lookupLatestDispatch(storage, "ses_target")
    expect(result.operation?.requestID).toBe("req-target")
    expect(result.coverage).toBe("limited")
    expect(result.scanned).toBe(DISPATCH_SCAN_MAX)
    expect(storage.scanCalls).toBe(DISPATCH_SCAN_MAX / 100)
  })

  test("rejects invalid session ids and unavailable storage", async () => {
    const storage = new MemoryStorage()
    await expect(lookupLatestDispatch(storage, "bad session")).rejects.toThrow("invalid sessionID")
    await expect(lookupLatestDispatch(undefined, "ses_target")).rejects.toThrow("storage is unavailable")
  })

  test("summary is allowlisted and excludes raw identity, prompt and completion", () => {
    const summary = summarizeDispatch(operation())
    expect(Object.keys(summary!).sort()).toEqual(
      [
        "createdAt",
        "delivery",
        "error",
        "kind",
        "requestID",
        "state",
        "status",
        "submittedAt",
        "updatedAt",
        "warning",
      ].sort(),
    )
    expect(JSON.stringify(summary)).not.toContain("SECRET")
    expect(JSON.stringify(summary)).not.toContain("msg_secret")
  })
})
