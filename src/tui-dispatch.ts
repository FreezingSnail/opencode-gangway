import type { DispatchInspectInput, DispatchInspection } from "./dispatch-rpc"
import { DISPATCH_RPC, parseDispatchInput, parseDispatchInspection } from "./dispatch-rpc"
import { terminalSafeText, type DispatchSummary } from "./dispatch-records"

// TUI-facing read-only dispatch inspection. The caller pins a session ID, calls
// loadDispatchInspection on open and refresh, and renders describeDispatchDetails.
// Nothing here dispatches, reconciles, creates sessions or prompts an upstream.
// Live chat state is supplied by the caller from the host store; it is never
// interpreted as evidence of delivery.

export const DISPATCH_ACTION = { bind: "o", title: "Dispatch details" } as const

export interface DispatchRpcCall {
  inspectDispatch(
    input: DispatchInspectInput,
    options?: {
      location?: { readonly directory?: string; readonly [key: string]: unknown }
      signal?: AbortSignal
    },
  ): Promise<unknown>
}

export interface DispatchRpcClient {
  rpc?: (definition: typeof DISPATCH_RPC) => Partial<DispatchRpcCall>
}

export type DispatchView =
  | { readonly state: "ready"; readonly inspection: DispatchInspection }
  | { readonly state: "unavailable"; readonly message: string }
  | { readonly state: "error"; readonly message: string }

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return terminalSafeText(raw, 160) ?? "unknown error"
}

function looksUnavailable(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("rpc.unavailable") ||
    lower.includes("method_not_found") ||
    lower.includes("plugin rpc") ||
    lower.includes("unavailable") ||
    lower.includes("not registered") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused")
  )
}

export async function loadDispatchInspection(
  client: DispatchRpcClient | undefined,
  rawInput: unknown,
  location?: { readonly directory?: string; readonly [key: string]: unknown },
  signal?: AbortSignal,
): Promise<DispatchView> {
  let input: DispatchInspectInput
  try {
    input = parseDispatchInput(rawInput)
  } catch (error) {
    return { state: "error", message: errorText(error) }
  }

  if (!client || typeof client.rpc !== "function") {
    return { state: "unavailable", message: "this OpenCode host does not expose plugin RPC" }
  }

  try {
    const methods = client.rpc(DISPATCH_RPC)
    const inspect = methods?.inspectDispatch
    if (typeof inspect !== "function") {
      return { state: "unavailable", message: "the Gangway service did not register dispatch inspection" }
    }
    const options: {
      location?: { readonly directory?: string; readonly [key: string]: unknown }
      signal?: AbortSignal
    } = {
      ...(typeof location?.directory === "string" && location.directory
        ? { location: { ...location, directory: location.directory } }
        : {}),
      ...(signal ? { signal } : {}),
    }
    const result = await inspect(input, options)
    return { state: "ready", inspection: parseDispatchInspection(result) }
  } catch (error) {
    const message = errorText(error)
    return looksUnavailable(message)
      ? { state: "unavailable", message }
      : { state: "error", message }
  }
}

/**
 * One generation counter per details view. `invalidate` on navigation/close and
 * check the token returned by `begin` before applying a late result.
 */
export interface DispatchRequestGate {
  begin(): () => boolean
  invalidate(): void
}

export function createDispatchRequestGate(): DispatchRequestGate {
  let generation = 0
  return {
    begin() {
      const mine = ++generation
      return () => mine === generation
    },
    invalidate() {
      generation += 1
    },
  }
}

/** Load and drop the result if the user navigated or refreshed meanwhile. */
export async function loadDispatchIfCurrent(
  gate: DispatchRequestGate,
  client: DispatchRpcClient | undefined,
  rawInput: unknown,
  location?: { readonly directory?: string; readonly [key: string]: unknown },
  signal?: AbortSignal,
): Promise<DispatchView | undefined> {
  const current = gate.begin()
  const view = await loadDispatchInspection(client, rawInput, location, signal)
  return current() ? view : undefined
}

export type DispatchTone = "base" | "muted" | "info" | "warning"

export interface DispatchLine {
  readonly text: string
  readonly tone: DispatchTone
}

export interface DispatchDetailsInput {
  readonly view?: DispatchView
  readonly pinnedSessionID: string
  readonly currentSessionID?: string
  readonly live: "idle" | "running" | "unavailable"
  /** Host session `time.updated`; used only to note newer chat activity. */
  readonly liveUpdatedAt?: number
}

export function formatDispatchTimestamp(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "unknown"
  return new Date(value).toISOString()
}

function operationLines(operation: DispatchSummary): DispatchLine[] {
  const lines: DispatchLine[] = [
    { text: `Request: ${operation.requestID} (${operation.kind})`, tone: "base" },
    {
      text: `Recorded state: ${operation.state} · status: ${operation.status}`,
      tone: operation.state === "failed" || operation.state === "unknown" ? "warning" : "base",
    },
    {
      text: `Recorded delivery: ${operation.delivery}`,
      tone: operation.delivery === "recorded" ? "base" : "warning",
    },
    { text: `Submitted: ${formatDispatchTimestamp(operation.submittedAt)}`, tone: "muted" },
    {
      text: `Record created: ${formatDispatchTimestamp(operation.createdAt)} · updated: ${formatDispatchTimestamp(operation.updatedAt)}`,
      tone: "muted",
    },
  ]
  if (operation.error) lines.push({ text: `Error: ${operation.error}`, tone: "warning" })
  if (operation.warning) lines.push({ text: `Warning: ${operation.warning}`, tone: "warning" })
  return lines
}

/**
 * Terminal-ready detail lines. Missing and legacy records get actionable text;
 * a limited scan says so and labels the shown operation as the latest found.
 * Delivery always comes from the record, never from the live status.
 */
export function describeDispatchDetails(input: DispatchDetailsInput): DispatchLine[] {
  if (input.pinnedSessionID !== input.currentSessionID) return []

  const live: DispatchLine = {
    text: `Live: ${input.live} (current chat state; not delivery evidence)`,
    tone: input.live === "unavailable" ? "warning" : "info",
  }
  const view = input.view
  if (!view) return [{ text: "Loading recorded dispatch…", tone: "muted" }, live]

  if (view.state === "unavailable") {
    return [
      { text: `Dispatch records unavailable: ${view.message}`, tone: "warning" },
      { text: "Start the Gangway service or open this location, then press r to retry.", tone: "muted" },
      live,
    ]
  }
  if (view.state === "error") {
    return [
      { text: `Dispatch records could not be read: ${view.message}`, tone: "warning" },
      { text: "Press r to retry.", tone: "muted" },
      live,
    ]
  }

  const inspection = view.inspection
  if (inspection.sessionID !== input.pinnedSessionID) {
    return [
      { text: "Dispatch records unavailable: the response did not match this session.", tone: "warning" },
      live,
    ]
  }

  const lines: DispatchLine[] = [live]
  if (!inspection.operation) {
    lines.push(
      inspection.reason === "legacy"
        ? {
            text: "No recorded dispatch for this legacy session (it predates operation records).",
            tone: "muted",
          }
        : { text: "No recorded dispatch for this session.", tone: "muted" },
    )
    return lines
  }

  if (inspection.coverage === "limited") {
    lines.push({
      text: "Coverage limited: scan cap reached; showing the latest record found.",
      tone: "warning",
    })
  }
  lines.push(...operationLines(inspection.operation))
  const recordedAt = inspection.operation.updatedAt
  if (
    typeof input.liveUpdatedAt === "number" &&
    Number.isFinite(input.liveUpdatedAt) &&
    typeof recordedAt === "number" &&
    input.liveUpdatedAt > recordedAt
  ) {
    lines.push({ text: "Current chat activity is newer than this recorded operation.", tone: "muted" })
  }
  return lines
}
