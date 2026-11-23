import { realpathSync } from "node:fs"
import { resolve } from "node:path"

// Runtime readiness for Codex push receipts (gangway-34r.5/.6).
//
// The MCP tool layer and the plugin instance are created separately: a tool
// request may resolve a location whose per-location plugin options are stale.
// Receipts must describe what the live monitor and App Server can actually do,
// so plugin setup publishes readiness here and the tool layer reads it back.
// The registry is process-global (like the operation locks) so a module reload or
// endpoint-owner handover cannot fork the answer.

export interface CodexTargetReadiness {
  status: "available" | "unavailable"
  checkedAt: number
  error: string | null
}

export const CODEX_TARGET_READINESS_TTL_MS = 30_000

export interface CodexReadinessInput {
  deliveryEnabled: boolean
  monitorAvailable: boolean
  monitorError: string | null
  // Injected by the plugin; verifies that the target (or its deliverable parent)
  // is loaded on the shared App Server before a receipt claims `armed`.
  verifyTarget?: (threadId: string) => Promise<void>
}

export interface CodexReadinessSnapshot {
  deliveryEnabled: boolean
  monitorAvailable: boolean
  monitorError: string | null
  updatedAt: number
  targets: Map<string, CodexTargetReadiness>
}

interface CodexReadinessEntry extends CodexReadinessSnapshot {
  owner: object
  verifyTarget?: (threadId: string) => Promise<void>
}

const readinessKey = Symbol.for("gangway.codex-readiness.v1")
const shared = globalThis as typeof globalThis & {
  [readinessKey]?: Map<string, CodexReadinessEntry>
}
const registry = shared[readinessKey] ??= new Map<string, CodexReadinessEntry>()

function keyOf(directory: string | null | undefined): string {
  if (typeof directory !== "string" || !directory) return ""
  const absolute = resolve(directory)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

export function setCodexReadiness(
  directory: string | null | undefined,
  input: CodexReadinessInput,
): object {
  const key = keyOf(directory)
  const owner = {}
  registry.set(key, {
    owner,
    deliveryEnabled: input.deliveryEnabled,
    monitorAvailable: input.monitorAvailable,
    monitorError: input.monitorError,
    updatedAt: Date.now(),
    // A replacement plugin instance must re-verify targets against the current
    // App Server instead of inheriting an availability result from the old
    // monitor/socket generation.
    targets: new Map(),
    ...(input.verifyTarget ? { verifyTarget: input.verifyTarget } : {}),
  })
  return owner
}

export function updateCodexReadiness(
  directory: string | null | undefined,
  update: Partial<CodexReadinessInput>,
  owner?: object,
): void {
  const key = keyOf(directory)
  const previous = registry.get(key)
  if (!previous) return
  if (owner && previous.owner !== owner) return
  registry.set(key, {
    ...previous,
    ...(update.deliveryEnabled !== undefined ? { deliveryEnabled: update.deliveryEnabled } : {}),
    ...(update.monitorAvailable !== undefined ? { monitorAvailable: update.monitorAvailable } : {}),
    ...(update.monitorError !== undefined ? { monitorError: update.monitorError } : {}),
    ...(update.verifyTarget ? { verifyTarget: update.verifyTarget } : {}),
    updatedAt: Date.now(),
  })
}

export function clearCodexReadiness(directory: string | null | undefined, owner?: object): void {
  const key = keyOf(directory)
  const current = registry.get(key)
  if (owner && current?.owner !== owner) return
  registry.delete(key)
}

/** Null means no live runtime record; callers may fall back to static options. */
export function codexReadinessFor(
  directory: string | null | undefined,
): CodexReadinessSnapshot | null {
  const entry = registry.get(keyOf(directory))
  if (!entry) return null
  return {
    deliveryEnabled: entry.deliveryEnabled,
    monitorAvailable: entry.monitorAvailable,
    monitorError: entry.monitorError,
    updatedAt: entry.updatedAt,
    targets: entry.targets,
  }
}

export function cachedCodexTarget(
  directory: string | null | undefined,
  threadId: string | null | undefined,
): CodexTargetReadiness | null {
  if (!threadId) return null
  const targets = registry.get(keyOf(directory))?.targets
  const target = targets?.get(threadId)
  if (!target) return null
  if (Date.now() - target.checkedAt > CODEX_TARGET_READINESS_TTL_MS) {
    targets!.delete(threadId)
    return null
  }
  return target
}

/**
 * Verify a Codex target before an armed receipt. A missing verifier (tool-only
 * contexts and tests) reports `null`; production receipts require an explicit
 * available result before they claim `armed`. Failures are cached so status
 * paths stay synchronous.
 */
export async function verifyCodexTarget(
  directory: string | null | undefined,
  threadId: string | null | undefined,
): Promise<CodexTargetReadiness | null> {
  if (!threadId) return null
  const entry = registry.get(keyOf(directory))
  if (!entry?.verifyTarget) return null
  let target: CodexTargetReadiness
  try {
    await entry.verifyTarget(threadId)
    target = { status: "available", checkedAt: Date.now(), error: null }
  } catch (error) {
    target = {
      status: "unavailable",
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (registry.get(keyOf(directory)) === entry) entry.targets.set(threadId, target)
  return target
}

