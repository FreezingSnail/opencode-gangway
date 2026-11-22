import { describe, expect, test } from "bun:test"
import type { DispatchInspection } from "../src/dispatch-rpc"
import type { DispatchRpcClient } from "../src/tui-dispatch"
import {
  createDispatchRequestGate,
  describeDispatchDetails,
  formatDispatchTimestamp,
  loadDispatchIfCurrent,
  loadDispatchInspection,
} from "../src/tui-dispatch"

function summary(overrides: Record<string, unknown> = {}) {
  return {
    requestID: "req-follow",
    kind: "follow-up" as const,
    state: "submitting" as const,
    status: "unknown" as const,
    delivery: "unknown" as const,
    submittedAt: 1_700_000_000_000,
    createdAt: 1_699_999_999_000,
    updatedAt: 1_700_000_001_000,
    error: null,
    warning: null,
    ...overrides,
  }
}

function inspection(overrides: Partial<DispatchInspection> = {}): DispatchInspection {
  return {
    sessionID: "ses_target",
    coverage: "complete",
    reason: "recorded",
    operation: summary(),
    ...overrides,
  }
}

function clientReturning(result: unknown, calls: unknown[] = []): DispatchRpcClient {
  return {
    rpc() {
      return {
        async inspectDispatch(input, options) {
          calls.push({ input, options })
          return result
        },
      }
    },
  }
}

describe("loadDispatchInspection", () => {
  test("calls the selected session's location and returns a ready inspection", async () => {
    const calls: unknown[] = []
    const view = await loadDispatchInspection(
      clientReturning(inspection(), calls),
      { sessionID: "ses_target" },
      { directory: "/other/project" },
    )
    expect(view).toEqual({ state: "ready", inspection: inspection() })
    expect(calls).toEqual([
      { input: { sessionID: "ses_target" }, options: { location: { directory: "/other/project" } } },
    ])
  })

  test("labels a missing host RPC and an unregistered service as unavailable", async () => {
    expect(await loadDispatchInspection(undefined, { sessionID: "ses_target" })).toMatchObject({
      state: "unavailable",
    })
    const missing: DispatchRpcClient = { rpc: () => ({}) }
    expect(await loadDispatchInspection(missing, { sessionID: "ses_target" })).toMatchObject({
      state: "unavailable",
    })
    const throwing: DispatchRpcClient = {
      rpc() {
        return {
          async inspectDispatch() {
            throw new Error("rpc.unavailable: no such plugin method")
          },
        }
      },
    }
    expect(await loadDispatchInspection(throwing, { sessionID: "ses_target" })).toMatchObject({
      state: "unavailable",
    })

    const offline: DispatchRpcClient = {
      rpc() {
        return {
          async inspectDispatch() {
            throw new Error("fetch failed")
          },
        }
      },
    }
    expect(await loadDispatchInspection(offline, { sessionID: "ses_target" })).toMatchObject({
      state: "unavailable",
    })
  })

  test("keeps malformed responses and transport failures visible", async () => {
    const malformed = await loadDispatchInspection(
      clientReturning({ sessionID: "ses_target", coverage: "complete", reason: "recorded", operation: {} }),
      { sessionID: "ses_target" },
    )
    expect(malformed.state).toBe("error")

    const failed: DispatchRpcClient = {
      rpc() {
        return {
          async inspectDispatch() {
            throw new Error("boom")
          },
        }
      },
    }
    expect(await loadDispatchInspection(failed, { sessionID: "ses_target" })).toMatchObject({
      state: "error",
      message: "boom",
    })
  })

  test("rejects an invalid pinned session before any transport call", async () => {
    const calls: unknown[] = []
    const view = await loadDispatchInspection(clientReturning(inspection(), calls), { sessionID: "bad id" })
    expect(view.state).toBe("error")
    expect(calls).toEqual([])
  })
})

describe("late dispatch results", () => {
  test("a result that resolves after navigation is dropped", async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const client: DispatchRpcClient = {
      rpc() {
        return { inspectDispatch: () => pending }
      },
    }
    const gate = createDispatchRequestGate()
    const loading = loadDispatchIfCurrent(gate, client, { sessionID: "ses_target" })
    gate.invalidate()
    release(inspection())
    expect(await loading).toBeUndefined()
  })

  test("only the newest refresh applies", async () => {
    let releaseFirst!: (value: unknown) => void
    const first = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let call = 0
    const client: DispatchRpcClient = {
      rpc() {
        return {
          inspectDispatch: () => {
            call += 1
            return call === 1
              ? first
              : Promise.resolve(inspection({ operation: summary({ requestID: "req-new" }) }))
          },
        }
      },
    }
    const gate = createDispatchRequestGate()
    const older = loadDispatchIfCurrent(gate, client, { sessionID: "ses_target" })
    const newer = await loadDispatchIfCurrent(gate, client, { sessionID: "ses_target" })
    releaseFirst(inspection({ operation: summary({ requestID: "req-old" }) }))
    expect(await older).toBeUndefined()
    expect(newer).toMatchObject({ state: "ready", inspection: { operation: { requestID: "req-new" } } })
  })
})

describe("describeDispatchDetails", () => {
  test("keeps recorded unknown delivery unknown on both idle and running sessions", () => {
    for (const live of ["idle", "running"] as const) {
      const lines = describeDispatchDetails({
        view: { state: "ready", inspection: inspection() },
        pinnedSessionID: "ses_target",
        currentSessionID: "ses_target",
        live,
      })
      const text = lines.map((line) => line.text).join("\n")
      expect(text).toContain(`Live: ${live}`)
      expect(text).toContain("not delivery evidence")
      expect(text).toContain("Recorded delivery: unknown")
      expect(text).not.toContain("Recorded delivery: recorded")
    }
  })

  test("labels a missing live session without treating it as delivery evidence", () => {
    const lines = describeDispatchDetails({
      view: { state: "ready", inspection: inspection() },
      pinnedSessionID: "ses_target",
      currentSessionID: "ses_target",
      live: "unavailable",
    })
    const text = lines.map((line) => line.text).join("\n")
    expect(text).toContain("Live: unavailable")
    expect(text).toContain("Recorded delivery: unknown")
  })

  test("shows request, kind, state, delivery and timestamps for a follow-up", () => {
    const lines = describeDispatchDetails({
      view: { state: "ready", inspection: inspection() },
      pinnedSessionID: "ses_target",
      currentSessionID: "ses_target",
      live: "idle",
    })
    const text = lines.map((line) => line.text).join("\n")
    expect(text).toContain("Request: req-follow (follow-up)")
    expect(text).toContain("Recorded state: submitting · status: unknown")
    expect(text).toContain("Submitted: 2023-11-14T22:13:20.000Z")
    expect(text).toContain(`updated: ${formatDispatchTimestamp(1_700_000_001_000)}`)
  })

  test("notes when current chat activity is newer than the recorded operation", () => {
    const lines = describeDispatchDetails({
      view: { state: "ready", inspection: inspection() },
      pinnedSessionID: "ses_target",
      currentSessionID: "ses_target",
      live: "running",
      liveUpdatedAt: 1_700_000_100_000,
    })
    const text = lines.map((line) => line.text).join("\n")
    expect(text).toContain("Current chat activity is newer than this recorded operation.")
    expect(text).toContain("Recorded delivery: unknown")
  })

  test("labels limited coverage as the latest found", () => {
    const lines = describeDispatchDetails({
      view: {
        state: "ready",
        inspection: inspection({ coverage: "limited" }),
      },
      pinnedSessionID: "ses_target",
      currentSessionID: "ses_target",
      live: "running",
    })
    const text = lines.map((line) => line.text).join("\n")
    expect(text).toContain("Coverage limited")
    expect(text).toContain("latest record found")
  })

  test("gives actionable empty, legacy and unavailable text", () => {
    const base = { pinnedSessionID: "ses_target", currentSessionID: "ses_target", live: "idle" as const }
    const none = describeDispatchDetails({
      ...base,
      view: { state: "ready", inspection: inspection({ reason: "none", operation: null }) },
    })
    expect(none.map((line) => line.text).join("\n")).toContain("No recorded dispatch for this session.")

    const legacy = describeDispatchDetails({
      ...base,
      view: { state: "ready", inspection: inspection({ reason: "legacy", operation: null }) },
    })
    expect(legacy.map((line) => line.text).join("\n")).toContain("legacy session")

    const unavailable = describeDispatchDetails({
      ...base,
      view: { state: "unavailable", message: "rpc.unavailable" },
    })
    const unavailableText = unavailable.map((line) => line.text).join("\n")
    expect(unavailableText).toContain("Dispatch records unavailable")
    expect(unavailableText).toContain("press r to retry")
  })

  test("a response for another session is never rendered as this session's record", () => {
    const lines = describeDispatchDetails({
      view: {
        state: "ready",
        inspection: inspection({
          sessionID: "ses_other",
          operation: summary({ requestID: "req-foreign" }),
        }),
      },
      pinnedSessionID: "ses_target",
      currentSessionID: "ses_target",
      live: "idle",
    })
    const text = lines.map((line) => line.text).join("\n")
    expect(text).not.toContain("req-foreign")
    expect(text).toContain("did not match this session")
  })

  test("drops details after navigation away from the pinned session", () => {
    expect(
      describeDispatchDetails({
        view: { state: "ready", inspection: inspection() },
        pinnedSessionID: "ses_target",
        currentSessionID: "ses_home",
        live: "idle",
      }),
    ).toEqual([])
  })
})
