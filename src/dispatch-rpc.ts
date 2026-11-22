import type { Rpc } from "@opencode/schema/rpc"
import {
  isDispatchSessionID,
  lookupLatestDispatch,
  safeDetailText,
  terminalSafeText,
  type DispatchCoverage,
  type DispatchLookup,
  type DispatchReason,
  type DispatchStorage,
  type DispatchSummary,
} from "./dispatch-records"

// Compact read-only RPC shared by the OpenCode server plugin (registrar) and the
// TUI (caller). The JSON schemas document and validate the wire shape; the local
// parsers additionally allowlist every field so a compromised or mismatched
// host cannot inject extra operation data into the TUI.

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionID"],
  properties: {
    sessionID: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
  },
} as const

const OPERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "requestID",
    "kind",
    "state",
    "status",
    "delivery",
    "submittedAt",
    "createdAt",
    "updatedAt",
    "error",
    "warning",
  ],
  properties: {
    requestID: { type: "string", maxLength: 128 },
    kind: { type: "string", enum: ["start", "follow-up", "unknown"] },
    state: {
      type: "string",
      enum: ["intent", "created", "submitting", "submitted", "completed", "failed", "unknown"],
    },
    status: { type: "string", enum: ["pending", "running", "completed", "failed", "unknown"] },
    delivery: { type: "string", enum: ["pending", "recorded", "unknown"] },
    submittedAt: { type: ["number", "null"] },
    createdAt: { type: ["number", "null"] },
    updatedAt: { type: ["number", "null"] },
    error: { type: ["string", "null"], maxLength: 160 },
    warning: { type: ["string", "null"], maxLength: 160 },
  },
} as const

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessionID", "coverage", "reason", "operation"],
  properties: {
    sessionID: { type: "string", maxLength: 128 },
    coverage: { type: "string", enum: ["complete", "limited"] },
    reason: { type: "string", enum: ["recorded", "legacy", "none"] },
    operation: { anyOf: [{ type: "null" }, OPERATION_SCHEMA] },
  },
} as const

export const DISPATCH_RPC = {
  id: "gangway",
  methods: {
    inspectDispatch: {
      input: INPUT_SCHEMA,
      output: OUTPUT_SCHEMA,
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export interface DispatchInspectInput {
  readonly sessionID: string
}

export interface DispatchInspection {
  readonly sessionID: string
  readonly coverage: DispatchCoverage
  readonly reason: DispatchReason
  readonly operation: DispatchSummary | null
}

export function parseDispatchInput(value: unknown): DispatchInspectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatch lookup input must be an object")
  }
  const raw = value as Record<string, unknown>
  if (!isDispatchSessionID(raw.sessionID)) {
    throw new Error("dispatch lookup requires a valid sessionID")
  }
  return { sessionID: raw.sessionID }
}

function numOrNull(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("dispatch record timestamp is not a finite number")
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`dispatch record has an invalid ${field}`)
  }
  return value as T
}

function stringOrNull(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== "string") throw new Error("dispatch record text is not a string")
  return safeDetailText(value, 160)
}

function parseOperation(value: unknown): DispatchSummary | null {
  if (value === null) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatch record operation is not an object")
  }
  const raw = value as Record<string, unknown>
  const requestID = terminalSafeText(raw.requestID, 128)
  if (!requestID) {
    throw new Error("dispatch record has no requestID")
  }
  const state = oneOf(raw.state, ["intent", "created", "submitting", "submitted", "completed", "failed", "unknown"] as const, "state")
  return {
    requestID,
    kind: oneOf(raw.kind, ["start", "follow-up", "unknown"] as const, "kind"),
    state,
    status: oneOf(raw.status, ["pending", "running", "completed", "failed", "unknown"] as const, "status"),
    delivery: oneOf(raw.delivery, ["pending", "recorded", "unknown"] as const, "delivery"),
    submittedAt: numOrNull(raw.submittedAt),
    createdAt: numOrNull(raw.createdAt),
    updatedAt: numOrNull(raw.updatedAt),
    error: stringOrNull(raw.error),
    warning: stringOrNull(raw.warning),
  }
}

/** Parse an untrusted RPC result into the exact allowlisted response shape. */
export function parseDispatchInspection(value: unknown): DispatchInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatch lookup returned no inspection object")
  }
  const raw = value as Record<string, unknown>
  if (!isDispatchSessionID(raw.sessionID)) {
    throw new Error("dispatch lookup returned an invalid sessionID")
  }
  return {
    sessionID: raw.sessionID,
    coverage: oneOf(raw.coverage, ["complete", "limited"] as const, "coverage"),
    reason: oneOf(raw.reason, ["recorded", "legacy", "none"] as const, "reason"),
    operation: parseOperation(raw.operation),
  }
}

export function inspectionFromLookup(lookup: DispatchLookup): DispatchInspection {
  return {
    sessionID: lookup.sessionID,
    coverage: lookup.coverage,
    reason: lookup.reason,
    operation: lookup.operation,
  }
}

export async function inspectDispatch(
  storage: DispatchStorage | undefined,
  rawInput: unknown,
): Promise<DispatchInspection> {
  const input = parseDispatchInput(rawInput)
  return inspectionFromLookup(await lookupLatestDispatch(storage, input.sessionID))
}

export type DispatchHandlers = {
  inspectDispatch(input: unknown, context: unknown): Promise<DispatchInspection>
}

export function createDispatchHandlers(storage: DispatchStorage | undefined): DispatchHandlers {
  return {
    inspectDispatch: async (input) => inspectDispatch(storage, input),
  }
}

export interface DispatchRpcRegistration {
  dispose(): Promise<void> | void
}

export interface DispatchRpcRegistrar {
  register(definition: unknown, handlers: Record<string, unknown>): Promise<DispatchRpcRegistration>
}

/**
 * Register the read-only lookup on the server plugin's RPC domain. Returns
 * undefined when the host or storage does not expose RPC; the TUI then displays
 * its actionable "records unavailable" state instead of failing startup.
 */
export async function registerDispatchRpc(
  rpc: DispatchRpcRegistrar | undefined,
  storage: DispatchStorage | undefined,
): Promise<DispatchRpcRegistration | undefined> {
  if (!rpc || typeof rpc.register !== "function") return undefined
  if (!storage || typeof storage.scan !== "function") {
    throw new Error("dispatch record storage is unavailable")
  }
  return rpc.register(DISPATCH_RPC, createDispatchHandlers(storage))
}
