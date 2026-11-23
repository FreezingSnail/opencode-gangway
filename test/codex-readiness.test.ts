import { describe, expect, test } from "bun:test"
import {
  cachedCodexTarget,
  clearCodexReadiness,
  codexReadinessFor,
  setCodexReadiness,
  updateCodexReadiness,
  verifyCodexTarget,
  CODEX_TARGET_READINESS_TTL_MS,
} from "../src/codex-readiness"

const directory = process.cwd()
const alias = `${directory}/src/..`

function input(verifyTarget?: (threadId: string) => Promise<void>) {
  return {
    deliveryEnabled: true,
    monitorAvailable: true,
    monitorError: null,
    ...(verifyTarget ? { verifyTarget } : {}),
  }
}

describe("Codex readiness leases", () => {
  test("normalizes directory aliases and prevents an old reload from clearing the new lease", () => {
    const oldOwner = setCodexReadiness(directory, input())
    const newOwner = setCodexReadiness(alias, { ...input(), deliveryEnabled: false })

    clearCodexReadiness(directory, oldOwner)
    updateCodexReadiness(directory, { deliveryEnabled: true }, oldOwner)

    expect(codexReadinessFor(directory)?.deliveryEnabled).toBe(false)
    expect(codexReadinessFor(alias)?.deliveryEnabled).toBe(false)
    clearCodexReadiness(alias, newOwner)
    expect(codexReadinessFor(directory)).toBeNull()
  })

  test("an asynchronous target check cannot write into a replacement lease", async () => {
    let release!: () => void
    const threadId = crypto.randomUUID()
    const oldOwner = setCodexReadiness(directory, input(() => new Promise<void>((resolve) => { release = resolve })))
    const checking = verifyCodexTarget(directory, threadId)
    await Promise.resolve()

    const newOwner = setCodexReadiness(alias, input())
    release()
    await checking

    expect(cachedCodexTarget(directory, threadId)).toBeNull()
    clearCodexReadiness(directory, oldOwner)
    expect(codexReadinessFor(alias)).not.toBeNull()
    clearCodexReadiness(alias, newOwner)
  })

  test("cached target verification expires so status can refresh it", async () => {
    let now = 1_800_000_000_000
    let checks = 0
    const originalNow = Date.now
    Date.now = () => now
    const threadId = crypto.randomUUID()
    const owner = setCodexReadiness(directory, input(async () => { checks += 1 }))
    try {
      await verifyCodexTarget(directory, threadId)
      expect(cachedCodexTarget(directory, threadId)?.status).toBe("available")
      now += CODEX_TARGET_READINESS_TTL_MS + 1
      expect(cachedCodexTarget(directory, threadId)).toBeNull()
      await verifyCodexTarget(directory, threadId)
      expect(checks).toBe(2)
      expect(cachedCodexTarget(directory, threadId)?.checkedAt).toBe(now)
    } finally {
      Date.now = originalNow
      clearCodexReadiness(directory, owner)
    }
  })
})
