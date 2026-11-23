// Opt-in delivery of recorded OpenCode operation outcomes to the Codex App
// Server (gangway-34r.2/.3/.5).
//
// This path is intentionally separate from the synthetic wake probe timer. It
// reads only durable operation records, requires the per-dispatch `notify` opt-in
// (gangway-34r.3), binds the destination to the Codex caller thread captured from
// MCP `_meta.threadId`, verifies the thread/parent capability, and sends one
// structured tool output through turn/start.
//
// Delivery state is stored on the operation and keyed by the stable terminal
// output id or attention item id. A second source event, a concurrent callback,
// a reconnect reconciliation, or a reload therefore cannot produce a second
// accepted notification. Initialization/thread-lookup failures are safe
// preflight; only an effectful turn/start with an unknown outcome is ambiguous
// and is never resent without an operator recovering it.

import { AppServerError, withAppServer, type Rpc } from "./codex-app-server"
import type { NeedsInput } from "./attention"
import {
  isAttentionKey,
  formAttentionKey,
  permissionAttentionKey,
} from "./codex-attention"
import {
  codexThreadIdFromMeta,
  isTerminal,
  loadOperation,
  saveOperation,
  withLock,
  type CodexDeliveryEventState,
  type CodexDeliveryStatus,
  type OperationRecord,
  type Ctx,
} from "./tools"

export { codexThreadIdFromMeta, isAttentionKey }

export const DELIVERY_TOOL_NAME = "gangway_operation_result"
export const MAX_DELIVERY_TEXT = 12_000
export const MAX_DELIVERY_ERROR = 2_000
/** A reservation older than this cannot still be an in-flight send we own. */
export const STALE_SENDING_MS = 60_000
const recipientLocksKey = Symbol.for("gangway.codex-recipient-locks.v1")
const sharedRecipientLocks = globalThis as typeof globalThis & {
  [recipientLocksKey]?: Map<string, Promise<void>>
}
const recipientLocks = sharedRecipientLocks[recipientLocksKey] ??= new Map()

export type DeliveryPhase = "preflight" | "rejected" | "ambiguous"

export class DeliveryError extends Error {
  readonly phase: DeliveryPhase
  readonly recipientThreadId: string | null

  constructor(message: string, phase: DeliveryPhase, recipientThreadId: string | null = null) {
    super(message)
    this.name = "DeliveryError"
    this.phase = phase
    this.recipientThreadId = recipientThreadId
  }
}

export interface DeliverySourceIdentity {
  requestID: string
  kind: "start" | "prompt"
  sessionID: string | null
  // The Codex worker thread that dispatched the operation. For a native V2
  // child this is the source, while the payload may be delivered to its parent.
  workerThreadId: string | null
  directory: string | null
  agent: string | null
  model: string | null
}

export interface DeliveryPayload {
  kind: "gangway.operation.result" | "gangway.operation.attention"
  requestID: string
  sessionID: string | null
  source: DeliverySourceIdentity
  state: string
  outcome: string | null
  outputId: string
  text: string
  truncated: boolean
  error: string | null
  model: unknown
  finish: unknown
  tokens: unknown
  cost: unknown
  completedAt: number | null
  needsInput?: NeedsInput
}

export interface DeliveryTransport {
  preflight?(threadId: string): Promise<{ recipientThreadId: string; sourceThreadId: string }>
  send(input: {
    threadId: string
    resolvedRecipientThreadId?: string
    payload: DeliveryPayload
  }): Promise<{ recipientThreadId: string; turnId: string | null }>
}

export interface DeliveryOptions {
  transport?: DeliveryTransport
  // Explicit target used by tests or a future dispatch contract. The durable
  // operation thread remains the default.
  threadId?: string | null
  now?: () => number
  clientInfo?: { name: string; title: string; version: string }
  turnTimeoutMs?: number
  staleSendingMs?: number
}

export interface AppServerTargetOptions {
  connect?: (url: string) => WebSocket
  socketPath?: string
  timeoutMs?: number
  clientInfo?: { name: string; title: string; version: string }
}

export type DeliveryResultStatus = CodexDeliveryStatus | "skipped"

export interface DeliveryResult {
  status: DeliveryResultStatus
  requestID?: string
  key?: string
  reason?: string
  phase?: DeliveryPhase
  recipientThreadId?: string | null
  turnId?: string | null
  error?: string | null
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function bound(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputKey(op: OperationRecord): string {
  return op.completion?.outputId ??
    op.terminalEventId ??
    `${op.state}:${op.submittedAt ?? op.createdAt}`
}

function threadStatus(thread: Record<string, unknown>): string | null {
  return stringOf(objectOf(thread.status)?.type)
}

function loadedThread(thread: Record<string, unknown> | null, threadId: string): Record<string, unknown> {
  if (!thread || thread.id !== threadId) {
    throw new DeliveryError(`Codex thread ${threadId} is not loaded on the shared App Server`, "preflight")
  }
  const status = threadStatus(thread)
  if (status === "notLoaded" || status === "systemError") {
    throw new DeliveryError(`Codex thread ${threadId} is not available for input`, "preflight")
  }
  return thread
}

async function readThread(rpc: Rpc, threadId: string): Promise<Record<string, unknown>> {
  let result: unknown
  try {
    result = await rpc("thread/read", { threadId, includeTurns: false })
  } catch (error) {
    throw new DeliveryError(`Codex thread lookup failed: ${errorMessage(error)}`, "preflight")
  }
  return loadedThread(objectOf(objectOf(result)?.thread), threadId)
}

/**
 * Resolve the destination before any effectful call. A native MultiAgent V2
 * child that cannot accept direct input is routed through its verified parent;
 * both idle and active loaded parents are eligible. A missing or unloaded parent
 * is a preflight failure, so turn/start is never attempted.
 */
export async function resolveDeliveryRecipient(
  rpc: Rpc,
  threadId: string,
): Promise<{ recipientThreadId: string; sourceThreadId: string }> {
  const source = await readThread(rpc, threadId)
  if (source.canAcceptDirectInput !== false) {
    return { recipientThreadId: threadId, sourceThreadId: threadId }
  }
  const parentThreadId = stringOf(source.parentThreadId)
  if (!parentThreadId || parentThreadId === threadId) {
    throw new DeliveryError(
      "The Codex worker requires parent delivery, but the server did not provide its parent thread",
      "preflight",
    )
  }
  const parent = await readThread(rpc, parentThreadId)
  if (parent.canAcceptDirectInput === false) {
    throw new DeliveryError("The Codex parent cannot accept direct input", "preflight")
  }
  return { recipientThreadId: parentThreadId, sourceThreadId: threadId }
}

export function sourceIdentity(op: OperationRecord): DeliverySourceIdentity {
  return {
    requestID: op.requestID,
    kind: op.kind,
    sessionID: op.sessionID,
    workerThreadId: op.codexThreadId ?? null,
    directory: op.identity.directory ?? op.notifyDirectory ?? null,
    agent: op.identity.agent,
    model: op.identity.model,
  }
}

export function buildDeliveryPayload(op: OperationRecord): DeliveryPayload {
  const completion = op.completion
  const fullText = completion?.text ?? ""
  const fullError = stringOf(completion?.error) ?? stringOf(op.error)
  return {
    kind: "gangway.operation.result",
    requestID: op.requestID,
    sessionID: op.sessionID,
    source: sourceIdentity(op),
    state: op.state,
    outcome: completion?.outcome ?? null,
    outputId: completion?.outputId ?? outputKey(op),
    text: bound(fullText, MAX_DELIVERY_TEXT),
    truncated: fullText.length > MAX_DELIVERY_TEXT,
    error: fullError ? bound(fullError, MAX_DELIVERY_ERROR) : null,
    model: completion?.model ?? null,
    finish: completion?.finish ?? null,
    tokens: completion?.tokens ?? null,
    cost: completion?.cost ?? null,
    completedAt: completion?.completedAt ?? null,
  }
}

export function buildAttentionPayload(
  op: OperationRecord,
  needsInput: NeedsInput,
  key = "",
): DeliveryPayload {
  return {
    kind: "gangway.operation.attention",
    requestID: op.requestID,
    sessionID: op.sessionID,
    source: sourceIdentity(op),
    state: op.state,
    outcome: null,
    outputId: key,
    text: "",
    truncated: false,
    error: null,
    model: null,
    finish: null,
    tokens: null,
    cost: null,
    completedAt: null,
    needsInput,
  }
}

export function attentionKeys(op: OperationRecord): string[] {
  const attention = op.attention
  if (!attention) return []
  return [
    ...attention.requests.map(permissionAttentionKey),
    ...attention.forms.map(formAttentionKey),
  ]
}

function phaseOf(error: unknown, sentBeforeCall: boolean): DeliveryPhase {
  if (error instanceof DeliveryError) return error.phase
  if (error instanceof AppServerError) {
    if (error.preflight) return "preflight"
    if (error.kind === "rpc") return "rejected"
    if (error.sent || sentBeforeCall) return "ambiguous"
    return "preflight"
  }
  return sentBeforeCall ? "ambiguous" : "preflight"
}

function transportOptions(options: AppServerTargetOptions) {
  return {
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    clientInfo: options.clientInfo ?? {
      name: "gangway-outcome-delivery",
      title: "Gangway Outcome Delivery",
      version: "0.1.0",
    },
  }
}

/** Read-only target check used by dispatch receipts before claiming `armed`. */
export async function preflightDeliveryTarget(
  threadId: string,
  options: AppServerTargetOptions = {},
): Promise<{ recipientThreadId: string; sourceThreadId: string }> {
  return withAppServer(
    (rpc) => resolveDeliveryRecipient(rpc, threadId),
    options.connect,
    transportOptions(options),
  )
}

export function createAppServerTransport(
  options: AppServerTargetOptions = {},
): DeliveryTransport {
  return {
    async preflight(threadId) {
      return preflightDeliveryTarget(threadId, options)
    },
    async send({ threadId, resolvedRecipientThreadId, payload }) {
      return withAppServer(async (rpc) => {
        const route = resolvedRecipientThreadId
          ? { recipientThreadId: resolvedRecipientThreadId, sourceThreadId: threadId }
          : await resolveDeliveryRecipient(rpc, threadId)
        let sent = false
        try {
          const result = await rpc(
            "turn/start",
            {
              threadId: route.recipientThreadId,
              input: [],
              toolOutput: {
                name: DELIVERY_TOOL_NAME,
                namespace: null,
                output: JSON.stringify(payload),
              },
            },
            {
              ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
              onSent: () => {
                sent = true
              },
            },
          )
          const turn = objectOf(objectOf(result)?.turn)
          return { recipientThreadId: route.recipientThreadId, turnId: stringOf(turn?.id) }
        } catch (error) {
          const phase = phaseOf(error, sent)
          throw new DeliveryError(
            errorMessage(error),
            phase,
            route.recipientThreadId,
          )
        }
      }, options.connect, transportOptions(options))
    },
  }
}

function attempted(
  key: string,
  threadId: string,
  now: number,
): CodexDeliveryEventState {
  return {
    key,
    status: "sending",
    threadId,
    recipientThreadId: null,
    attemptedAt: now,
    acceptedAt: null,
    turnId: null,
    error: null,
  }
}

function staleSending(
  event: CodexDeliveryEventState,
  now: number,
  threshold: number,
): boolean {
  return event.status === "sending" && now - event.attemptedAt >= Math.max(0, threshold)
}

type DeliveryMode = "result" | "attention"

interface Reservation {
  key: string
  payload: DeliveryPayload
}

function staleMessage(key: string): string {
  return `stale sending reservation for ${key} recovered as ambiguous; no turn/start was resent`
}

async function withRecipientLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
  const previous = recipientLocks.get(threadId) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => held)
  recipientLocks.set(threadId, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (recipientLocks.get(threadId) === tail) recipientLocks.delete(threadId)
  }
}

async function reserve(
  ctx: Ctx,
  requestID: string,
  target: string,
  request: {
    mode: DeliveryMode
    key?: string
    expectedKey?: string
    freshOnly?: boolean
    now: number
    staleSendingMs: number
  },
): Promise<Reservation | DeliveryResult> {
  return withLock(requestID, async () => {
    const op = await loadOperation(ctx, requestID)
    if (!op) return { status: "skipped", requestID, reason: "unknown-operation" }
    if (op.notify !== true) {
      return { status: "skipped", requestID, reason: "not-opted-in" }
    }

    let key: string
    let payload: DeliveryPayload
    if (request.mode === "result") {
      if (!isTerminal(op) || !op.completion) {
        return { status: "skipped", requestID, reason: "not-terminal" }
      }
      key = outputKey(op)
      payload = buildDeliveryPayload(op)
      if (request.expectedKey && request.expectedKey !== key) {
        return { status: "skipped", requestID, key: request.expectedKey, reason: "stale-output-key" }
      }
    } else {
      if (isTerminal(op) || !op.attention) {
        return { status: "skipped", requestID, reason: "attention-cleared" }
      }
      const current = request.key && attentionKeys(op).includes(request.key)
        ? request.key
        : null
      if (!current) return { status: "skipped", requestID, reason: "attention-cleared" }
      key = current
      payload = buildAttentionPayload(op, op.attention, key)
    }

    const existing = op.codexDelivery?.events?.[key]
    if (existing) {
      if (request.freshOnly) {
        return { status: "skipped", requestID, key, reason: `already-${existing.status}` }
      }
      // A stale `sending` cannot belong to an in-flight send we still own. Mark
      // it ambiguous; never resend an effectful turn/start.
      if (staleSending(existing, request.now, request.staleSendingMs)) {
        op.codexDelivery = {
          events: {
            ...(op.codexDelivery?.events ?? {}),
            [key]: {
              ...existing,
              status: "ambiguous",
              error: staleMessage(key),
            },
          },
        }
        await saveOperation(ctx, op)
        return {
          status: "skipped",
          requestID,
          key,
          reason: "stale-sending-recovered",
          recipientThreadId: existing.recipientThreadId,
          error: staleMessage(key),
        }
      }
      // Accepted, in-flight, explicitly rejected, and ambiguous delivery attempts
      // must never be retried by a duplicate event or a reload. A preflight
      // failure never reached an effectful turn/start, so it is safe to try again.
      if (existing.status !== "preflight-failed") {
        return {
          status: "skipped",
          requestID,
          key,
          reason: `already-${existing.status}`,
          recipientThreadId: existing.recipientThreadId,
        }
      }
    }

    op.codexDelivery = {
      events: {
        ...(op.codexDelivery?.events ?? {}),
        [key]: attempted(key, target, request.now),
      },
    }
    await saveOperation(ctx, op)
    return { key, payload }
  })
}

async function finalize(
  ctx: Ctx,
  requestID: string,
  key: string,
  update: Partial<CodexDeliveryEventState>,
): Promise<void> {
  await withLock(requestID, async () => {
    const op = await loadOperation(ctx, requestID)
    if (!op) return
    const current = op.codexDelivery?.events?.[key]
    if (!current) return
    op.codexDelivery = {
      events: {
        ...(op.codexDelivery?.events ?? {}),
        [key]: { ...current, ...update },
      },
    }
    await saveOperation(ctx, op)
  })
}

async function attempt(
  ctx: Ctx,
  requestID: string,
  mode: DeliveryMode,
  key: string | undefined,
  options: DeliveryOptions,
  policy: { expectedKey?: string; freshOnly?: boolean } = {},
): Promise<DeliveryResult> {
  const now = options.now ?? Date.now
  const current = await loadOperation(ctx, requestID)
  if (!current) return { status: "skipped", requestID, reason: "unknown-operation" }
  if (current.notify !== true) {
    return { status: "skipped", requestID, reason: "not-opted-in" }
  }
  const target = options.threadId ?? current.codexThreadId
  if (!target) return { status: "skipped", requestID, reason: "no-codex-thread" }

  const reserved = await reserve(ctx, requestID, target, {
    mode,
    ...(key ? { key } : {}),
    ...policy,
    now: now(),
    staleSendingMs: options.staleSendingMs ?? STALE_SENDING_MS,
  })
  if ("status" in reserved) return reserved

  const transport = options.transport ?? createAppServerTransport({
    ...(options.turnTimeoutMs ? { timeoutMs: options.turnTimeoutMs } : {}),
    ...(options.clientInfo ? { clientInfo: options.clientInfo } : {}),
  })

  let recipientThreadId = target
  let sent: { recipientThreadId: string; turnId: string | null }
  try {
    if (transport.preflight) {
      recipientThreadId = (await transport.preflight(target)).recipientThreadId
    }
    sent = await withRecipientLock(recipientThreadId, () =>
      transport.send({
        threadId: target,
        resolvedRecipientThreadId: recipientThreadId,
        payload: reserved.payload,
      }),
    )
  } catch (error) {
    const phase = phaseOf(error, false)
    const status: CodexDeliveryStatus = phase === "ambiguous"
      ? "ambiguous"
      : phase === "rejected"
        ? "rejected"
        : "preflight-failed"
    const recipientThreadId = error instanceof DeliveryError ? error.recipientThreadId : null
    const message = errorMessage(error)
    try {
      await finalize(ctx, requestID, reserved.key, {
        status,
        recipientThreadId,
        error: bound(message, MAX_DELIVERY_ERROR),
      })
    } catch {
      // The reservation remains `sending`, which also prevents a duplicate send.
    }
    return {
      status,
      requestID,
      key: reserved.key,
      phase,
      recipientThreadId,
      error: message,
    }
  }

  const acceptedAt = now()
  try {
    await finalize(ctx, requestID, reserved.key, {
      status: "accepted",
      recipientThreadId: sent.recipientThreadId,
      acceptedAt,
      turnId: sent.turnId,
      error: null,
    })
  } catch (error) {
    // turn/start already returned acceptance. A storage failure at this point
    // must never be mislabeled preflight; the durable `sending` reservation
    // blocks automatic retries and stale recovery will mark it ambiguous.
    return {
      status: "ambiguous",
      requestID,
      key: reserved.key,
      phase: "ambiguous",
      recipientThreadId: sent.recipientThreadId,
      turnId: sent.turnId,
      error: `Codex accepted the turn, but delivery state could not be saved: ${errorMessage(error)}`,
    }
  }
  return {
    status: "accepted",
    requestID,
    key: reserved.key,
    recipientThreadId: sent.recipientThreadId,
    turnId: sent.turnId,
  }
}

/**
 * Attempt delivery once for a recorded terminal operation. Returns a compact
 * result without changing the operation's completion, so a failed delivery
 * leaves the original run inspectable through the existing tools.
 */
export async function deliverRecordedOperation(
  ctx: Ctx,
  requestID: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  return attempt(ctx, requestID, "result", undefined, options)
}

/** First delivery is safe only when the terminal output has no prior reservation. */
export async function deliverFirstRecordedOperation(
  ctx: Ctx,
  requestID: string,
  expectedKey?: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const op = await loadOperation(ctx, requestID)
  if (!op) return { status: "skipped", requestID, reason: "unknown-operation" }
  if (op.notify !== true) return { status: "skipped", requestID, reason: "not-opted-in" }
  if (!isTerminal(op) || !op.completion || !op.sessionID) {
    return { status: "skipped", requestID, reason: "not-eligible-terminal-result" }
  }
  return attempt(ctx, requestID, "result", undefined, options, {
    freshOnly: true,
    ...(expectedKey ? { expectedKey } : {}),
  })
}

/** Push one newly observed needs-input item with a stable per-item dedupe key. */
export async function deliverRecordedAttention(
  ctx: Ctx,
  requestID: string,
  key: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  return attempt(ctx, requestID, "attention", key, options)
}

/**
 * Deliberate operator retry. Reaches only a known preflight failure; accepted,
 * rejected, sending and ambiguous entries are refused without a send.
 */
export async function retryRecordedDelivery(
  ctx: Ctx,
  requestID: string,
  key: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const op = await loadOperation(ctx, requestID)
  if (!op) return { status: "skipped", requestID, reason: "unknown-operation" }
  const mode: DeliveryMode = isAttentionKey(key) ? "attention" : "result"
  if (mode === "result" && key !== outputKey(op)) {
    return { status: "skipped", requestID, key, reason: "stale-output-key" }
  }
  if (mode === "attention" && !attentionKeys(op).includes(key)) {
    return { status: "skipped", requestID, key, reason: "attention-cleared" }
  }
  const entry = op.codexDelivery?.events?.[key]
  if (!entry) return { status: "skipped", requestID, key, reason: "unknown-delivery" }
  if (entry.status !== "preflight-failed") {
    return { status: "skipped", requestID, key, reason: `already-${entry.status}` }
  }
  return attempt(ctx, requestID, mode, key, options)
}

/** Retry every known preflight failure, optionally restricted to one key. */
export async function retryRecordedDeliveries(
  ctx: Ctx,
  requestID: string,
  options: DeliveryOptions & { key?: string } = {},
): Promise<DeliveryResult[]> {
  const op = await loadOperation(ctx, requestID)
  if (!op) return [{ status: "skipped", requestID, reason: "unknown-operation" }]
  const keys = Object.entries(op.codexDelivery?.events ?? {})
    .filter(([key, event]) =>
      event.status === "preflight-failed" && (!options.key || options.key === key),
    )
    .map(([key]) => key)
  if (keys.length === 0) {
    return [{
      status: "skipped",
      requestID,
      ...(options.key ? { key: options.key } : {}),
      reason: "no-preflight-failures",
    }]
  }
  const results: DeliveryResult[] = []
  for (const key of keys) {
    results.push(await retryRecordedDelivery(ctx, requestID, key, options))
  }
  return results
}

/**
 * Recover reservations left `sending` by a crash. They are marked ambiguous and
 * never resent: we cannot prove the original turn/start was not accepted.
 */
export async function recoverStaleSending(
  ctx: Ctx,
  requestID: string,
  options: DeliveryOptions & { key?: string } = {},
): Promise<DeliveryResult[]> {
  const now = (options.now ?? Date.now)()
  const threshold = options.staleSendingMs ?? STALE_SENDING_MS
  return withLock(requestID, async () => {
    const op = await loadOperation(ctx, requestID)
    if (!op) return [{ status: "skipped", requestID, reason: "unknown-operation" }]
    const events = op.codexDelivery?.events ?? {}
    const recovered: DeliveryResult[] = []
    const next = { ...events }
    for (const [key, event] of Object.entries(events)) {
      if (options.key && options.key !== key) continue
      if (!staleSending(event, now, threshold)) continue
      const message = staleMessage(key)
      next[key] = { ...event, status: "ambiguous", error: message }
      recovered.push({
        status: "ambiguous",
        requestID,
        key,
        reason: "stale-sending-recovered",
        recipientThreadId: event.recipientThreadId,
        error: message,
      })
    }
    if (recovered.length > 0) {
      op.codexDelivery = { events: next }
      await saveOperation(ctx, op)
    }
    return recovered.length > 0
      ? recovered
      : [{
          status: "skipped",
          requestID,
          ...(options.key ? { key: options.key } : {}),
          reason: "no-stale-sending",
        }]
  })
}
