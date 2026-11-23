import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { detectNeedsInput, type NeedsInput } from "./attention"
import {
  cachedCodexTarget,
  codexReadinessFor,
  CODEX_TARGET_READINESS_TTL_MS,
  verifyCodexTarget,
} from "./codex-readiness"
import type { DeliveryTransport } from "./codex-delivery"

export const TAG = "[gangway]"
export const DEFAULT_MODEL = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
// A single tool call must finish inside the caller's request window. The MCP SDK
// default is 60s (`Client` requestTimeout), so the bridge caps its own default
// wait below that. Callers may override `timeoutMs`, but that does not raise the
// client limit and the bridge never cancels the underlying run on expiry.
export const CLIENT_REQUEST_LIMIT_MS = 60_000
export const DEFAULT_WAIT_MS = 45_000
export const DEFAULT_MAX_CHARS = 20_000
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

// Unattended sessions cannot answer permission prompts, so the bridge installs a
// session-scoped ruleset at create time. It mirrors the user's global policy, but
// turns "ask" decisions into "deny" so the agent gets an error instead of stalling.
export const UNATTENDED_DENY: Array<{ action: string; resource: string }> = [
  { action: "shell", resource: "perl*" },
  { action: "shell", resource: "ruby*" },
  { action: "shell", resource: "lua*" },
  { action: "shell", resource: "php*" },
  { action: "shell", resource: "Rscript*" },
  { action: "shell", resource: "gem*" },
  { action: "shell", resource: "cpan*" },
  { action: "shell", resource: "rm -rf *" },
  { action: "shell", resource: "git push*" },
  { action: "shell", resource: "git clone*" },
  { action: "shell", resource: "git submodule*" },
  { action: "shell", resource: "wget*" },
  { action: "shell", resource: "curl*-o*" },
  { action: "shell", resource: "curl*--output*" },
  { action: "shell", resource: "DROP *" },
]

function unattendedRuleset(): Array<{ action: string; resource: string; effect: string }> {
  return [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    ...UNATTENDED_DENY.map((rule) => ({ ...rule, effect: "deny" })),
  ]
}


// Minimal structural view of the OpenCode plugin context. Intentionally loose:
// the runtime shape is the contract (see the server OpenAPI document), and the
// published types may lag the installed service version.
export interface Ctx {
  location?: { directory?: string }
  options?: Record<string, unknown>
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
    get(input: { sessionID: string }): Promise<Record<string, any>>
    context(input: { sessionID: string }): Promise<unknown>
    prompt(input: { sessionID: string; text: string; id?: string }): Promise<unknown>
    interrupt(input: { sessionID: string; continue: boolean }): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
  }
  storage: {
    set(key: string, value: unknown): Promise<void>
    get(key: string): Promise<unknown>
    scan(input: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: Array<{ key: string; value: unknown }>
      next?: string
    }>
  }
  // Optional per-instance attention queues. The real plugin context exposes
  // `permission` but not `form`; test contexts may expose both. They are used
  // only for sessions in this instance's own directory (see src/attention.ts).
  permission?: {
    list(input: { sessionID: string }): Promise<unknown>
  }
  form?: {
    list(input: { sessionID: string }): Promise<unknown>
  }
  // Server event stream installed by the plugin API. Optional so tool-only
  // callers and older hosts keep working; the execution monitor is additive.
  event?: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = "TimeoutError"
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function parseModel(input?: string): { providerID: string; id: string } {
  if (!input) return { ...DEFAULT_MODEL }
  const slash = input.indexOf("/")
  if (slash <= 0 || slash === input.length - 1) {
    throw new Error(`invalid model "${input}", expected "provider/modelID"`)
  }
  return { providerID: input.slice(0, slash), id: input.slice(slash + 1) }
}

function short(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Deterministic, dependency-free string hash. Used only to key operation records
// and detect changed input; collisions would only surface as a conflict error.
function hashString(input: string): string {
  let a = 0x811c9dc5
  let b = 0x1000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    a = Math.imul(a ^ c, 16777619) >>> 0
    b = Math.imul(b + c, 2246822519) >>> 0
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`
}

async function transcript(ctx: Ctx, sessionID: string): Promise<any[]> {
  const result: any = await ctx.session.context({ sessionID })
  if (Array.isArray(result)) return result
  return Array.isArray(result?.data) ? result.data : []
}

async function transcriptLength(ctx: Ctx, sessionID: string): Promise<number> {
  return (await transcript(ctx, sessionID)).length
}

async function lastAssistant(ctx: Ctx, sessionID: string) {
  const all = await transcript(ctx, sessionID)
  const assistants = all.filter((message) => message?.type === "assistant")
  const last = assistants.at(-1)
  const tail = all.at(-1)
  const content: any[] = Array.isArray(last?.content) ? last.content : []
  return {
    text: content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim(),
    model: last?.model ?? null,
    cost: last?.cost ?? null,
    tokens: last?.tokens ?? null,
    finish: last?.finish ?? null,
    error: last?.error ?? null,
    lastMessageType: tail?.type ?? null,
    idle: tail?.type === "idle",
    outcome: tail?.type === "idle" ? (tail.outcome ?? null) : null,
    outputId: outputIdOf(last, tail),
  }
}

function outputIdOf(message: any, tail: any): string | null {
  if (!message) return null
  const id = typeof message?.id === "string" ? message.id : null
  const completed = message?.time?.completed ?? message?.time?.created ?? null
  const outcome = tail?.outcome ?? null
  return `${id ?? "message"}@${completed ?? "?"}@${outcome ?? "?"}`
}

// Legacy idle wait (no requestID): unchanged behavior, bounded by the caller
// window. It cannot bind to a specific turn, so an already-idle session returns
// immediately; requestID operations use the boundary-aware path below. Attention
// probes interrupt the wait early so a stalled session reports needsInput
// instead of blocking until the deadline.
interface IdleOutcome {
  idle: boolean
  needsInput: NeedsInput | null
}

async function waitForIdle(
  ctx: Ctx,
  sessionID: string,
  timeoutMs: number,
  directory?: string | null,
): Promise<IdleOutcome> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const attention = () => detectNeedsInput(ctx, sessionID, directory)
  const first = await attention()
  if (first) return { idle: false, needsInput: first }

  let waitState: "ok" | "error" | null = null
  const waiting = Promise.resolve(ctx.session.wait({ sessionID })).then(
    () => {
      waitState = "ok"
    },
    () => {
      waitState = "error"
    },
  )

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { idle: false, needsInput: await attention() }
    const slice = await Promise.race([
      waiting.then(() => "wait" as const),
      sleep(Math.min(1500, remaining)).then(() => "tick" as const),
    ])
    if (slice === "wait") {
      if (waitState === "ok") return { idle: true, needsInput: null }
      break
    }
    const found = await attention()
    if (found) return { idle: false, needsInput: found }
  }

  // ctx.session.wait may be unavailable on older services; fall back to
  // polling the transcript for a trailing idle message.
  while (Date.now() < deadline) {
    await sleep(Math.min(1500, Math.max(0, deadline - Date.now())))
    const found = await attention()
    if (found) return { idle: false, needsInput: found }
    const latest = await lastAssistant(ctx, sessionID)
    if (latest.idle) return { idle: true, needsInput: null }
  }
  return { idle: false, needsInput: await attention() }
}

function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] }
}

// ---------------------------------------------------------------------------
// Reliable dispatch / resume
//
// Operation records live in the plugin storage namespace (`operations/<hash>`),
// which is owned by the OpenCode service, not by the per-request MCP server. The
// in-process lock map is keyed on the process (Symbol.for) so module reloads and
// endpoint-owner handover serialize against the same requestID.
// ---------------------------------------------------------------------------

export type Identity = {
  kind: "start" | "prompt"
  directory: string | null
  model: string | null
  agent: string | null
  sessionID: string | null
  prompt: string
}

export type OperationState =
  | "intent" // intent recorded, upstream effect not yet attempted (or unknown)
  | "created" // session id known and recorded, prompt not submitted
  | "submitting" // prompt submission attempted; delivery unknown if interrupted here
  | "submitted" // prompt submission returned
  | "completed"
  | "failed"
  | "unknown"

export interface Completion {
  text: string
  model: unknown
  cost: unknown
  tokens: unknown
  finish: unknown
  error: unknown
  outcome: string | null
  messageID: string | null
  outputId: string
  completedAt: number | null
}

export type CodexDeliveryStatus =
  | "sending"
  | "accepted"
  | "preflight-failed"
  | "rejected"
  | "ambiguous"

export interface CodexDeliveryEventState {
  key: string
  status: CodexDeliveryStatus
  threadId: string
  recipientThreadId: string | null
  attemptedAt: number
  acceptedAt: number | null
  turnId: string | null
  error: string | null
}

export interface CodexDeliveryState {
  events: Record<string, CodexDeliveryEventState>
}

export interface OperationRecord {
  requestID: string
  kind: "start" | "prompt"
  identity: Identity
  identityHash: string
  state: OperationState
  sessionID: string | null
  // Transcript length captured immediately before prompt submission. Completion
  // requires a new assistant message at or after this boundary, so a previous
  // assistant response or pre-existing idle state cannot satisfy this operation.
  boundary: number | null
  submittedAt: number | null
  submittedMessageID: string | null
  delivery: "pending" | "recorded" | "unknown"
  createdAt: number
  updatedAt: number
  completion: Completion | null
  lastOutputId: string | null
  error: string | null
  warnings?: string[]
  // Server-event recording (gangway-34r.1). Optional so records written by an
  // older build stay readable and writable.
  admittedAt?: number | null
  executionStartedAt?: number | null
  attention?: NeedsInput | null
  streamText?: string | null
  streamKey?: string | null
  streamMessageID?: string | null
  streamCost?: unknown
  streamTokens?: unknown
  streamFinish?: unknown
  terminalEventId?: string | null
  terminalSource?: "event" | "transcript" | null
  // Codex caller/thread metadata supplied by the MCP transport (`_meta.threadId`)
  // on the dispatch call. This is the owning thread, not the OpenCode session.
  codexThreadId?: string | null
  // Public per-dispatch opt-in (gangway-34r.3). Absent/false preserves the
  // original request/response behavior: no push notification is attempted.
  notify?: boolean
  // Location whose live monitor owns push readiness. Prompt operations have no
  // identity directory, so the dispatching instance records it explicitly.
  notifyDirectory?: string | null
  // Durable per-outcome notification state (gangway-34r.2). Optional so records
  // written by an older build remain readable.
  codexDelivery?: CodexDeliveryState | null
}

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Read the Codex thread id the App Server attaches to MCP tool calls. */
export function codexThreadIdFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null
  const candidate = (meta as Record<string, unknown>).threadId
  if (typeof candidate !== "string") return null
  const threadId = candidate.trim().toLowerCase()
  return CODEX_THREAD_ID.test(threadId) ? threadId : null
}

/**
 * Deployment gate for outcome push. The per-dispatch `notify` flag also has to
 * be set; this only enables the monitor/transport. `GANGWAY_CODEX_DELIVERY=1`
 * is the environment fallback for installs that cannot pass plugin options.
 */
export function codexDeliveryEnabled(options: Record<string, unknown> | undefined): boolean {
  const configured = options?.codexDelivery
  if (configured === true) return true
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    if ((configured as { enabled?: unknown }).enabled === true) return true
  }
  return process.env.GANGWAY_CODEX_DELIVERY === "1"
}

const locksKey = Symbol.for("gangway.operation-locks.v1")
const globalLocks = globalThis as typeof globalThis & {
  [locksKey]?: Map<string, Promise<unknown>>
}
const operationLocks = globalLocks[locksKey] ??= new Map<string, Promise<unknown>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = operationLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const chained = previous.then(() => gate)
  operationLocks.set(key, chained)
  await previous
  try {
    return await fn()
  } finally {
    release()
    void chained.then(() => {
      if (operationLocks.get(key) === chained) operationLocks.delete(key)
    })
  }
}

function operationKey(requestID: string): string {
  return `operations/${hashString(requestID)}`
}

function identityHash(identity: Identity): string {
  return hashString(JSON.stringify(identity))
}

export async function loadOperation(ctx: Ctx, requestID: string): Promise<OperationRecord | null> {
  const raw = await ctx.storage.get(operationKey(requestID))
  if (raw && typeof raw === "object") return raw as OperationRecord
  return null
}

export async function saveOperation(ctx: Ctx, op: OperationRecord): Promise<void> {
  op.updatedAt = Date.now()
  await ctx.storage.set(operationKey(op.requestID), op)
}

// Best-effort persist for recovery paths: a failed write must not throw away the
// in-memory outcome the caller is about to receive.
async function saveOperationSafe(ctx: Ctx, op: OperationRecord): Promise<void> {
  try {
    await saveOperation(ctx, op)
  } catch {
    // storage unavailable; the durable record keeps its previous value.
  }
}

function newOperation(
  requestID: string,
  kind: "start" | "prompt",
  identity: Identity,
  hash: string,
  sessionID: string | null,
): OperationRecord {
  const now = Date.now()
  return {
    requestID,
    kind,
    identity,
    identityHash: hash,
    state: "intent",
    sessionID,
    boundary: null,
    submittedAt: null,
    submittedMessageID: null,
    delivery: "pending",
    createdAt: now,
    updatedAt: now,
    completion: null,
    lastOutputId: null,
    error: null,
    admittedAt: null,
    executionStartedAt: null,
    attention: null,
    streamText: null,
    streamKey: null,
    streamMessageID: null,
    streamCost: null,
    streamTokens: null,
    streamFinish: null,
    terminalEventId: null,
    terminalSource: null,
    codexThreadId: null,
    notify: false,
    notifyDirectory: null,
    codexDelivery: null,
  }
}

export function isTerminal(op: OperationRecord): boolean {
  return op.state === "completed" || op.state === "failed"
}

function stateStatus(op: OperationRecord): string {
  if (op.state === "completed" || op.state === "failed") return op.state
  if (op.state === "submitting" || op.state === "unknown") return "unknown"
  if (op.state === "submitted") return "running"
  return "pending"
}

export function toCompletion(message: any, outcome: string | null, tail: any): Completion {
  const content: any[] = Array.isArray(message?.content) ? message.content : []
  return {
    text: content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()
      .slice(0, DEFAULT_MAX_CHARS),
    model: message?.model ?? null,
    cost: message?.cost ?? null,
    tokens: message?.tokens ?? null,
    finish: message?.finish ?? null,
    error: message?.error ?? tail?.error ?? null,
    outcome,
    messageID: typeof message?.id === "string" ? message.id : null,
    outputId: outputIdOf(message, tail) ?? "message@?@?",
    completedAt: message?.time?.completed ?? message?.time?.created ?? null,
  }
}

export interface Probe {
  status: "completed" | "failed" | "running"
  completion?: Completion
  freshCount: number
}

// Turn binding: only messages appended after the recorded boundary count, and a
// trailing idle message, can complete the operation. A prior assistant answer or
// an idle that predates submission is invisible here.
export async function probeTranscript(
  ctx: Ctx,
  sessionID: string,
  boundary: number | null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<Probe> {
  const messages = await withTimeout(transcript(ctx, sessionID), timeoutMs)
  const start = boundary ?? messages.length
  const fresh = messages.slice(start)
  const freshCount = fresh.length
  const tail = messages.at(-1)
  const assistants = fresh.filter((message) => message?.type === "assistant")
  const last = assistants.at(-1)
  if (last && tail?.type === "idle") {
    const outcome: string | null = tail.outcome ?? null
    return {
      status: outcome === "failed" || outcome === "interrupted" ? "failed" : "completed",
      completion: toCompletion(last, outcome, tail),
      freshCount,
    }
  }
  return { status: "running", freshCount }
}

// Reconcile a durable operation against upstream state. Never resends or
// recreates: it only observes and advances the recorded state.
export async function reconcileOperation(
  ctx: Ctx,
  op: OperationRecord,
  onTransientError?: (error: unknown) => void,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<OperationRecord> {
  if (isTerminal(op) || op.sessionID == null || op.boundary == null) return op
  let probe: Probe
  try {
    probe = await probeTranscript(ctx, op.sessionID, op.boundary, timeoutMs)
  } catch (error) {
    // Transient upstream read failure: keep the recorded state, do not flip it.
    onTransientError?.(error)
    return op
  }
  if (probe.status === "completed" || probe.status === "failed") {
    op.state = probe.status
    op.completion = probe.completion ?? null
    op.error = null
    op.attention = null
    op.terminalSource ??= "transcript"
  } else if (op.delivery === "unknown" && probe.freshCount > 0) {
    // Reconciliation found our turn admitted upstream, so delivery is no longer
    // ambiguous. The turn may still be running.
    op.delivery = "recorded"
    op.state = "submitted"
    op.error = null
    op.admittedAt ??= op.submittedAt ?? Date.now()
  }
  await saveOperation(ctx, op)
  return op
}

function deliveryAttempts(op: OperationRecord) {
  const events = op.codexDelivery?.events
  if (!events) return null
  const attempts = Object.entries(events).map(([outputId, event]) => ({
    outputId,
    status: event.status,
    recipientThreadId: event.recipientThreadId,
    turnId: event.turnId,
    attemptedAt: event.attemptedAt,
    acceptedAt: event.acceptedAt,
    error: event.error,
  }))
  return attempts.length ? attempts : null
}

// Dispatch contract returned to opted-in callers. The state is computed from the
// live monitor readiness published by the plugin instance plus the caller
// identity captured from `_meta.threadId`; static plugin options are only the
// fallback when no runtime record exists. The delivery attempts are the durable
// per-outputId records users inspect by requestID when a push fails.
function notificationFields(op: OperationRecord, codexDelivery: boolean) {
  const attempts = deliveryAttempts(op)
  if (op.notify !== true) return attempts ? { codexDeliveries: attempts } : {}
  const threadId = op.codexThreadId ?? null
  const directory = op.notifyDirectory ?? op.identity.directory
  const runtime = codexReadinessFor(directory)
  const enabled = runtime?.deliveryEnabled ?? codexDelivery
  const target = cachedCodexTarget(directory, threadId)
  const state = !enabled
    ? "plugin-disabled"
    : !op.sessionID
      ? "session-unavailable"
    : !threadId
      ? "thread-missing"
      : !runtime || !runtime.monitorAvailable
        ? "monitor-unavailable"
        : target?.status === "unavailable"
          ? "target-unavailable"
            : target?.status !== "available"
              ? "target-unverified"
              : "armed"
  const hint =
    state === "plugin-disabled"
      ? "Codex push is disabled for this location. Set the codexDelivery plugin option (or GANGWAY_CODEX_DELIVERY=1) and reload before dispatch."
      : state === "session-unavailable"
        ? "OpenCode did not confirm a session ID for this operation, so no terminal outcome can be monitored. Inspect the recorded operation before relying on push."
      : state === "thread-missing"
        ? "No Codex _meta.threadId was supplied. Codex sends it automatically; other MCP clients cannot receive this push."
        : state === "monitor-unavailable"
          ? "The Codex push monitor is not subscribed for this location, so no run outcome can be pushed. Use opencode_wait/opencode_result, or restore the event stream and reload."
          : state === "target-unavailable"
            ? "The calling Codex thread is not loaded on the shared App Server. Load it (and any required parent) before relying on the push; the recorded result remains available through opencode_result."
          : state === "target-unverified"
            ? "Gangway has not verified that the calling Codex thread is loaded on the shared App Server. Keep this turn open and inspect status, or reconnect the shared App Server before relying on push."
            : "End this turn after the receipt. One structured result is pushed to the bound Codex thread on completion; do not resubmit or poll."
  return {
    notify: {
      requested: true,
      state,
      mechanism: "codex-push",
      threadId,
      monitor: runtime
        ? { available: runtime.monitorAvailable, error: runtime.monitorError }
        : null,
      target: {
        state: target?.status ?? "unchecked",
        checkedAt: target?.checkedAt ?? null,
        error: target?.error ?? null,
      },
      ...(attempts ? { deliveries: attempts } : {}),
      hint,
    },
  }
}

// Receipt-time target probe. Only the live plugin installs a verifier; direct
// tool/test contexts keep the static fallback. Failures are cached and reflected
// as `target-unavailable` instead of claiming an armed receipt.
async function verifyNotificationTarget(op: OperationRecord, codexDelivery: boolean): Promise<void> {
  if (op.notify !== true || !op.sessionID || !op.codexThreadId) return
  const directory = op.notifyDirectory ?? op.identity.directory
  const runtime = codexReadinessFor(directory)
  const enabled = runtime?.deliveryEnabled ?? codexDelivery
  if (!enabled || !runtime?.monitorAvailable) return
  const cached = cachedCodexTarget(directory, op.codexThreadId)
  if (cached && Date.now() - cached.checkedAt <= CODEX_TARGET_READINESS_TTL_MS) return
  await verifyCodexTarget(directory, op.codexThreadId)
}

function operationSummary(
  op: OperationRecord,
  extra: Record<string, unknown> = {},
  codexDelivery = false,
) {  return {
    requestID: op.requestID,
    sessionID: op.sessionID,
    kind: op.kind,
    state: op.state,
    status: stateStatus(op),
    delivery: op.delivery,
    submittedAt: op.submittedAt,
    submittedMessageID: op.submittedMessageID,
    boundary: op.boundary,
    outputId: op.completion?.outputId ?? null,
    error: op.error,
    ...notificationFields(op, codexDelivery),
    ...(op.warnings?.length ? { warnings: op.warnings } : {}),
    ...extra,
  }
}

function completionSummary(op: OperationRecord, codexDelivery = false) {
  const c = op.completion
  return {
    ...operationSummary(op, {}, codexDelivery),
    outputId: c?.outputId ?? null,
    text: c?.text ?? null,
    model: c?.model ?? null,
    finish: c?.finish ?? null,
    outcome: c?.outcome ?? null,
    tokens: c?.tokens ?? null,
    cost: c?.cost ?? null,
    error: c?.error ?? op.error ?? null,
  }
}

async function submitPrompt(ctx: Ctx, op: OperationRecord, text: string): Promise<OperationRecord> {
  if (op.sessionID == null) throw new Error("cannot submit prompt without a session")
  if (op.boundary == null) op.boundary = await transcriptLength(ctx, op.sessionID)
  op.submittedAt = Date.now()
  // Record the attempt before the effectful call. If we die here, delivery is
  // explicitly unknown; a later retry must reconcile, never blind-resend.
  op.state = "submitting"
  op.delivery = "pending"
  op.admittedAt = null
  op.executionStartedAt = null
  op.attention = null
  op.streamText = null
  op.streamKey = null
  op.streamMessageID = null
  op.streamCost = null
  op.streamTokens = null
  op.streamFinish = null
  op.terminalEventId = null
  op.terminalSource = null
  await saveOperation(ctx, op)
  try {
    const inbox: any = await ctx.session.prompt({ sessionID: op.sessionID, text })
    op.state = "submitted"
    op.delivery = "recorded"
    op.submittedMessageID = inbox && typeof inbox === "object" && typeof inbox.id === "string" ? inbox.id : null
    await saveOperationSafe(ctx, op)
  } catch (error) {
    op.state = "unknown"
    op.delivery = "unknown"
    op.error = errorMessage(error)
    await saveOperationSafe(ctx, op)
  }
  return op
}

interface WaitOutcome {
  op: OperationRecord
  needsInput: NeedsInput | null
}

async function waitForCompletion(
  ctx: Ctx,
  start: OperationRecord,
  budgetMs: number,
  directory?: string | null,
): Promise<WaitOutcome> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  const attention = (sessionID: string) =>
    detectNeedsInput(ctx, sessionID, directory ?? start.identity.directory)
  let op = start
  for (;;) {
    op = await withLock(op.requestID, async () => {
      const current = await loadOperation(ctx, op.requestID)
      return current ? reconcileOperation(ctx, current) : op
    })
    if (isTerminal(op)) return { op, needsInput: null }
    // Event-recorded attention is a positive observation even when a later live
    // probe is unavailable. It is cleared by the matching reply/cancel event.
    if (op.attention) return { op, needsInput: op.attention }
    // A stalled session does not advance its transcript. Report the stall now
    // instead of waiting out the caller's budget; operation state is untouched,
    // so a later wait resumes normally once the user answers in the TUI.
    if (op.sessionID != null) {
      const found = await attention(op.sessionID)
      if (found) return { op, needsInput: found }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { op, needsInput: null }
    const slice = Math.min(remaining, 5_000)
    if (op.sessionID != null) {
      try {
        await withTimeout(Promise.resolve(ctx.session.wait({ sessionID: op.sessionID })), slice)
      } catch {
        // Timeout or unavailable wait: fall through to a bounded transcript poll.
      }
    }
    const left = deadline - Date.now()
    if (left > 0) await sleep(Math.min(100, left))
  }
}

function conflictError(requestID: string, op: OperationRecord, identity: Identity): Error {
  return new Error(
    `requestID "${requestID}" is already bound to a different input ` +
      `(recorded ${JSON.stringify(op.identity)}; received ${JSON.stringify(identity)}). ` +
      `Use a new requestID for changed input.`,
  )
}

function requireStorage(ctx: Ctx): void {
  if (!ctx.storage || typeof ctx.storage.get !== "function") {
    throw new Error("requestID requires plugin storage (ctx.storage) to record dispatch intent")
  }
}

async function recordSession(
  ctx: Ctx,
  op: OperationRecord,
  entry: { title: string; model: { providerID: string; id: string }; directory: string | null },
): Promise<void> {
  if (!op.sessionID) return
  try {
    await ctx.storage.set(`sessions/${op.sessionID}`, {
      sessionID: op.sessionID,
      title: entry.title,
      model: entry.model,
      directory: entry.directory,
      requestID: op.requestID,
      createdAt: Date.now(),
    })
  } catch (error) {
    // The operation record already pins the session id; a registry write failure
    // must not lose the handle or block prompt submission.
    op.warnings = [...(op.warnings ?? []), `session registry write failed: ${errorMessage(error)}`]
  }
}

interface DispatchResult {
  op: OperationRecord
  reason?: string
}

async function prepareStart(
  ctx: Ctx,
  requestID: string,
  args: {
    prompt: string
    sessionID?: string
    title?: string
    directory?: string
    agent?: string
    model?: { providerID: string; id: string }
    codexThreadId?: string | null
    notify?: boolean
  },
  permissions: Array<{ action: string; resource: string; effect: string }> | undefined,
  titlePrefix: string,
  defaultWaitMs: number,
): Promise<DispatchResult> {
  const directory = args.directory ?? ctx.location?.directory ?? null
  const identity: Identity = {
    kind: "start",
    directory,
    model: args.model ? `${args.model.providerID}/${args.model.id}` : null,
    agent: args.agent ?? null,
    sessionID: args.sessionID ?? null,
    prompt: args.prompt,
  }
  const hash = identityHash(identity)
  return withLock(requestID, async () => {
    const existing = await loadOperation(ctx, requestID)
    if (existing && existing.identityHash !== hash) throw conflictError(requestID, existing, identity)
    let op = existing
    if (!op) {
      // Intent precedes any effectful upstream call.
      op = newOperation(requestID, "start", identity, hash, args.sessionID ?? null)
      op.codexThreadId = args.codexThreadId ?? null
      op.notify = args.notify === true
      op.notifyDirectory = directory
      await saveOperation(ctx, op)
    } else {
      // Bind the owning Codex thread to the first dispatch that supplied it.
      // Later retries may fill it in, but never replace it.
      if (args.codexThreadId && !op.codexThreadId) {
        op.codexThreadId = args.codexThreadId
        await saveOperationSafe(ctx, op)
      }
      if (op.notifyDirectory == null) {
        op.notifyDirectory = directory
        await saveOperationSafe(ctx, op)
      }
    }

    if (existing) {
      op = await reconcileOperation(ctx, op)
      if (isTerminal(op)) {
        if (args.notify === true && op.notify !== true) {
          throw new Error(
            `requestID "${requestID}" already finished without notify; the recorded result is inspectable with opencode_result. ` +
              "Use a new dispatch with notify=true to receive a push.",
          )
        }
        return { op }
      }
      // Notification is deployment behavior, not part of the pinned input
      // identity: a retry may arm it before completion, but never disarms it.
      if (args.notify === true && op.notify !== true) {
        op.notify = true
        await saveOperationSafe(ctx, op)
      }
      // A previous attempt never observed a create result: the session may or may
      // not exist. Do not create again; report unknown until reconciliation.
      if (op.sessionID == null) {
        return { op, reason: "session-creation-unknown" }
      }
    }

    if (op.sessionID == null) {
      const title = `${titlePrefix} ${args.title ?? short(args.prompt)}`
      let created: { id: string }
      try {
        created = await ctx.session.create({
          title,
          model: args.model,
          ...(args.directory ? { location: { directory: args.directory } } : {}),
          ...(args.agent ? { agent: args.agent } : {}),
          ...(permissions ? { permissions } : {}),
          metadata: { gangway: true, gangwayRequestID: requestID },
        })
      } catch (error) {
        // Creation outcome uncertain: the session may or may not exist. Keep the
        // intent and never blind-create on retry; report ambiguous delivery.
        op.state = "unknown"
        op.delivery = "unknown"
        op.error = errorMessage(error)
        await saveOperationSafe(ctx, op)
        return { op, reason: "session-creation-failed" }
      }
      // The session id is now known. Record the mapping before submitting the
      // prompt; if the mapping write fails we must not submit (an unrecorded
      // prompt would be an unrecoverable side effect), so surface it explicitly.
      op.sessionID = created.id
      op.state = "created"
      try {
        await saveOperation(ctx, op)
        await recordSession(ctx, op, {
          title,
          model: args.model ?? DEFAULT_MODEL,
          directory,
        })
      } catch (error) {
        op.error = errorMessage(error)
        op.warnings = [...(op.warnings ?? []), `operation mapping write failed: ${errorMessage(error)}`]
        await saveOperationSafe(ctx, op)
        return { op, reason: "session-mapping-failed" }
      }
    }

    if (op.state === "intent" || op.state === "created") {
      op = await submitPrompt(ctx, op, args.prompt)
    }
    void defaultWaitMs
    return { op }
  })
}

async function preparePrompt(
  ctx: Ctx,
  requestID: string,
  args: { sessionID: string; text: string; codexThreadId?: string | null; notify?: boolean },
): Promise<DispatchResult> {
  const identity: Identity = {
    kind: "prompt",
    directory: null,
    model: null,
    agent: null,
    sessionID: args.sessionID,
    prompt: args.text,
  }
  const hash = identityHash(identity)
  return withLock(requestID, async () => {
    const existing = await loadOperation(ctx, requestID)
    if (existing && existing.identityHash !== hash) throw conflictError(requestID, existing, identity)
    let op = existing
    if (!op) {
      op = newOperation(requestID, "prompt", identity, hash, args.sessionID)
      op.codexThreadId = args.codexThreadId ?? null
      op.notify = args.notify === true
      op.notifyDirectory = ctx.location?.directory ?? null
      await saveOperation(ctx, op)
    } else {
      if (args.codexThreadId && !op.codexThreadId) {
        op.codexThreadId = args.codexThreadId
        await saveOperationSafe(ctx, op)
      }
      if (op.notifyDirectory == null && ctx.location?.directory) {
        op.notifyDirectory = ctx.location.directory
        await saveOperationSafe(ctx, op)
      }
    }
    if (existing) {
      op = await reconcileOperation(ctx, op)
      if (isTerminal(op)) {
        if (args.notify === true && op.notify !== true) {
          throw new Error(
            `requestID "${requestID}" already finished without notify; the recorded result is inspectable with opencode_result. ` +
              "Use a new dispatch with notify=true to receive a push.",
          )
        }
        return { op }
      }
      if (args.notify === true && op.notify !== true) {
        op.notify = true
        await saveOperationSafe(ctx, op)
      }
    }
    if (op.state === "intent" || op.state === "created") {
      op = await submitPrompt(ctx, op, args.text)
    }
    return { op }
  })
}

// Attention is reported on the wait early-return path. The operation state is
// deliberately not advanced: the run is still alive, merely waiting on the user.
function attentionFields(needsInput: NeedsInput) {
  return { needsInput, waitResult: "needs-input", timedOut: false }
}

function statusPayload(
  op: OperationRecord,
  info: Record<string, any>,
  needsInput: NeedsInput | null,
  codexDelivery = false,
) {
  return {
    requestID: op.requestID,
    sessionID: op.sessionID,
    kind: op.kind,
    state: op.state,
    status: stateStatus(op),
    delivery: op.delivery,
    submittedAt: op.submittedAt,
    submittedMessageID: op.submittedMessageID,
    boundary: op.boundary,
    outputId: op.completion?.outputId ?? null,
    completed: isTerminal(op),
    error: op.error,
    needsInput,
    ...notificationFields(op, codexDelivery),
    ...(op.warnings?.length ? { warnings: op.warnings } : {}),
    session: {
      title: info.title ?? null,
      agent: info.agent ?? null,
      model: info.model ?? null,
      outcome: info.outcome ?? null,
      updated: info.time?.updated ?? null,
      idle: info.time?.idle ?? null,
      tokens: info.tokens ?? null,
      cost: info.cost ?? null,
    },
  }
}

export function registerBridgeTools(
  server: McpServer,
  ctx: Ctx,
  options: {
    defaultWaitMs?: number
    inheritPermissions?: boolean
    titlePrefix?: string
    codexDelivery?: boolean
    // Test seam for opencode_delivery retry; plugin runtime uses the default
    // App Server transport.
    deliveryTransport?: DeliveryTransport
  } = {},
) {
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS
  const titlePrefix = options.titlePrefix ?? TAG
  const permissions = options.inheritPermissions ? undefined : unattendedRuleset()
  const codexDelivery = options.codexDelivery ?? codexDeliveryEnabled(ctx.options)

  server.registerTool(
    "opencode_start_session",
    {
      description:
        "Start an OpenCode implementation session (defaults to model opencode-go/deepseek-v4.1-flash) and send it an initial prompt. Returns immediately with a stable requestID/sessionID receipt. Pass requestID for idempotent, resumable dispatch; set notify=true to opt in to one Codex push of the structured result when the run finishes (requires requestID; the calling Codex thread is captured automatically). After an armed receipt the caller may end its turn: do not resubmit or poll. wait=true blocks as before.",
      inputSchema: {
        prompt: z.string().describe("Implementation task for the OpenCode session"),
        sessionID: z.string().optional().describe("Attach to an existing session instead of creating one"),
        title: z.string().optional().describe(`Session title; gets a ${titlePrefix} prefix`),
        directory: z.string().optional().describe("Project directory; defaults to the plugin instance location"),
        agent: z.string().optional().describe("OpenCode agent ID"),
        model: z.string().optional().describe('"provider/modelID"; defaults to opencode-go/deepseek-v4.1-flash'),
        wait: z.boolean().optional().describe("Block until the session goes idle"),
        timeoutMs: z.number().int().positive().optional().describe("Max wait time"),
        requestID: z
          .string()
          .optional()
          .describe("Stable idempotency key; identical retries resolve to the same recorded operation"),
        notify: z
          .boolean()
          .optional()
          .describe(
            "Opt in to one Codex push of the eventual structured result. Requires requestID; receipt reports whether session, monitor, and thread are ready",
          ),
      },
    },
    async (args, extra) => {
      if (args.notify && !args.requestID) {
        throw new Error("notify requires a stable requestID so the result can be pushed once")
      }
      const model = args.sessionID ? null : parseModel(args.model)
      const codexThreadId = codexThreadIdFromMeta(extra?._meta)

      if (!args.requestID) {
        if (args.sessionID) {
          await ctx.session.get({ sessionID: args.sessionID })
          await ctx.session.prompt({ sessionID: args.sessionID, text: args.prompt })
          if (!args.wait) return reply({ sessionID: args.sessionID, status: "queued" })
          const outcome = await waitForIdle(
            ctx,
            args.sessionID,
            args.timeoutMs ?? defaultWaitMs,
            args.directory ?? ctx.location?.directory ?? null,
          )
          const latest = await lastAssistant(ctx, args.sessionID)
          if (outcome.needsInput) {
            return reply({ sessionID: args.sessionID, status: "busy", ...attentionFields(outcome.needsInput), ...latest })
          }
          return reply({ sessionID: args.sessionID, status: outcome.idle ? "idle" : "busy", ...latest })
        }
        const title = `${titlePrefix} ${args.title ?? short(args.prompt)}`
        const created = await ctx.session.create({
          title,
          model,
          ...(args.directory ? { location: { directory: args.directory } } : {}),
          ...(args.agent ? { agent: args.agent } : {}),
          ...(permissions ? { permissions } : {}),
          metadata: { gangway: true },
        })
        // Record the mapping before submitting the prompt.
        if (ctx.storage) {
          await ctx.storage.set(`sessions/${created.id}`, {
            sessionID: created.id,
            title,
            model,
            directory: args.directory ?? ctx.location?.directory ?? null,
            createdAt: Date.now(),
          })
        }
        await ctx.session.prompt({ sessionID: created.id, text: args.prompt })
        if (!args.wait) return reply({ sessionID: created.id, status: "started" })
        const outcome = await waitForIdle(
          ctx,
          created.id,
          args.timeoutMs ?? defaultWaitMs,
          args.directory ?? ctx.location?.directory ?? null,
        )
        const latest = await lastAssistant(ctx, created.id)
        if (outcome.needsInput) {
          return reply({ sessionID: created.id, status: "busy", ...attentionFields(outcome.needsInput), ...latest })
        }
        return reply({ sessionID: created.id, status: outcome.idle ? "idle" : "busy", ...latest })
      }

      requireStorage(ctx)
      const { op, reason } = await prepareStart(
        ctx,
        args.requestID,
        {
          prompt: args.prompt,
          sessionID: args.sessionID,
          title: args.title,
          directory: args.directory,
          agent: args.agent,
          model: model ?? undefined,
          codexThreadId,
          notify: args.notify === true,
        },
        permissions,
        titlePrefix,
        defaultWaitMs,
      )
      await verifyNotificationTarget(op, codexDelivery)
      if (!args.wait) return reply({ ...operationSummary(op, {}, codexDelivery), worstCaseWaitMs: defaultWaitMs })
      const outcome = isTerminal(op)
        ? { op, needsInput: null }
        : await waitForCompletion(ctx, op, args.timeoutMs ?? defaultWaitMs)
      if (outcome.needsInput) return reply(operationSummary(outcome.op, attentionFields(outcome.needsInput), codexDelivery))
      if (isTerminal(outcome.op)) return reply(completionSummary(outcome.op, codexDelivery))
      return reply(operationSummary(outcome.op, { timedOut: true, reason: reason ?? "wait-expired" }, codexDelivery))
    },
  )

  server.registerTool(
    "opencode_prompt",
    {
      description:
        "Send a follow-up prompt to an existing OpenCode session. Pass requestID for idempotent, resumable dispatch; set notify=true to opt in to one Codex push of the structured result when this turn finishes (requires requestID). After an armed receipt the caller may end its turn: do not resubmit or poll.",
      inputSchema: {
        sessionID: z.string().describe("Session ID (ses_...)"),
        text: z.string(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        requestID: z
          .string()
          .optional()
          .describe("Stable idempotency key; identical retries resolve to the same recorded operation"),
        notify: z
          .boolean()
          .optional()
          .describe(
            "Opt in to one Codex push of the eventual structured result. Requires requestID; receipt reports whether session, monitor, and thread are ready",
          ),
      },
    },
    async (args, extra) => {
      if (args.notify && !args.requestID) {
        throw new Error("notify requires a stable requestID so the result can be pushed once")
      }
      const codexThreadId = codexThreadIdFromMeta(extra?._meta)
      if (!args.requestID) {
        await ctx.session.get({ sessionID: args.sessionID })
        await ctx.session.prompt({ sessionID: args.sessionID, text: args.text })
        if (!args.wait) return reply({ sessionID: args.sessionID, status: "queued" })
        const outcome = await waitForIdle(
          ctx,
          args.sessionID,
          args.timeoutMs ?? defaultWaitMs,
          ctx.location?.directory ?? null,
        )
        const latest = await lastAssistant(ctx, args.sessionID)
        if (outcome.needsInput) {
          return reply({ sessionID: args.sessionID, status: "busy", ...attentionFields(outcome.needsInput), ...latest })
        }
        return reply({ sessionID: args.sessionID, status: outcome.idle ? "idle" : "busy", ...latest })
      }

      requireStorage(ctx)
      await ctx.session.get({ sessionID: args.sessionID })
      const { op } = await preparePrompt(ctx, args.requestID, {
        sessionID: args.sessionID,
        text: args.text,
        codexThreadId,
        notify: args.notify === true,
      })
      await verifyNotificationTarget(op, codexDelivery)
      if (!args.wait) return reply({ ...operationSummary(op, {}, codexDelivery), worstCaseWaitMs: defaultWaitMs })
      const outcome = isTerminal(op)
        ? { op, needsInput: null }
        : await waitForCompletion(ctx, op, args.timeoutMs ?? defaultWaitMs)
      if (outcome.needsInput) return reply(operationSummary(outcome.op, attentionFields(outcome.needsInput), codexDelivery))
      if (isTerminal(outcome.op)) return reply(completionSummary(outcome.op, codexDelivery))
      return reply(operationSummary(outcome.op, { timedOut: true, reason: "wait-expired" }, codexDelivery))
    },
  )

  server.registerTool(
    "opencode_wait",
    {
      description:
        "Block until an OpenCode session finishes its current run, then return the latest assistant output. With requestID the wait binds to that operation's turn.",
      inputSchema: {
        sessionID: z.string(),
        timeoutMs: z.number().int().positive().optional().describe("Defaults to 45 seconds (client-safe)"),
        requestID: z.string().optional().describe("Bind the wait to a recorded operation instead of the latest turn"),
      },
    },
    async (args) => {
      if (args.requestID && ctx.storage && typeof ctx.storage.get === "function") {
        const op = await loadOperation(ctx, args.requestID)
        if (!op) {
          return reply({ requestID: args.requestID, sessionID: args.sessionID, status: "unknown", state: "unknown", error: "unknown requestID" })
        }
        const reconciled = await withLock(args.requestID, async () => {
          const current = await loadOperation(ctx, args.requestID!)
          return current ? reconcileOperation(ctx, current) : op
        })
        if (isTerminal(reconciled)) return reply(completionSummary(reconciled, codexDelivery))
        const outcome = await waitForCompletion(ctx, reconciled, args.timeoutMs ?? defaultWaitMs)
        if (outcome.needsInput) return reply(operationSummary(outcome.op, attentionFields(outcome.needsInput), codexDelivery))
        if (isTerminal(outcome.op)) return reply(completionSummary(outcome.op, codexDelivery))
        return reply(operationSummary(outcome.op, { timedOut: true, reason: "wait-expired" }, codexDelivery))
      }
      const outcome = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
      const latest = await lastAssistant(ctx, args.sessionID)
      if (outcome.needsInput) {
        return reply({ sessionID: args.sessionID, status: "busy", ...attentionFields(outcome.needsInput), ...latest })
      }
      return reply({ sessionID: args.sessionID, status: outcome.idle ? "idle" : "busy", ...latest })
    },
  )

  server.registerTool(
    "opencode_status",
    {
      description:
        "Report an OpenCode session's state. With requestID returns compact recorded operation state (no transcript fetch unless reconcile=true), including the notify contract and durable codex delivery attempts. Without requestID returns session info plus a tail of the latest assistant output.",
      inputSchema: {
        sessionID: z.string(),
        directory: z.string().optional().describe("Resolve this status request against this project location"),
        requestID: z.string().optional().describe("Return compact state for a recorded operation"),
        reconcile: z.boolean().optional().describe("With requestID: also probe the transcript to advance incomplete state"),
      },
    },
    async (args) => {
      const info: any = await ctx.session.get({ sessionID: args.sessionID })

      if (args.requestID && ctx.storage && typeof ctx.storage.get === "function") {
        return withLock(args.requestID, async () => {
          let op = await loadOperation(ctx, args.requestID!)
          if (!op) {
            return reply({
              requestID: args.requestID,
              sessionID: args.sessionID,
              state: "unknown",
              status: "unknown",
              error: "unknown requestID",
              needsInput: await detectNeedsInput(ctx, args.sessionID, info?.location?.directory),
              session: { outcome: info.outcome ?? null, updated: info.time?.updated ?? null },
            })
          }
          if (args.reconcile) op = await reconcileOperation(ctx, op)
          await verifyNotificationTarget(op, codexDelivery)
          // Stalls are only meaningful while the turn is nonterminal; a finished
          // operation reports `needsInput: null` explicitly.
          const needsInput = isTerminal(op)
            ? null
            : op.attention ?? await detectNeedsInput(ctx, op.sessionID ?? args.sessionID, op.identity.directory)
          return reply(statusPayload(op, info, needsInput, codexDelivery))
        })
      }

      const latest = await lastAssistant(ctx, args.sessionID)
      return reply({
        sessionID: args.sessionID,
        title: info.title ?? null,
        agent: info.agent ?? null,
        model: info.model ?? null,
        outcome: info.outcome ?? null,
        time: info.time ?? null,
        tokens: info.tokens ?? null,
        cost: info.cost ?? null,
        lastMessageType: latest.lastMessageType,
        idle: latest.idle,
        tail: short(latest.text, 500),
        needsInput: await detectNeedsInput(ctx, args.sessionID, info?.location?.directory),
      })
    },
  )

  server.registerTool(
    "opencode_result",
    {
      description:
        "Return bounded assistant output. With requestID returns the recorded operation's own result and reports unchanged output instead of resending it (pass force=true to resend). The same response includes notify/codex delivery state, so a failed push can be inspected without resubmitting the run.",
      inputSchema: {
        sessionID: z.string(),
        maxChars: z.number().int().positive().optional().describe("Defaults to 20000"),
        requestID: z.string().optional().describe("Return the recorded operation's result"),
        force: z.boolean().optional().describe("With requestID: return text even when unchanged"),
      },
    },
    async (args) => {
      const cap = args.maxChars ?? DEFAULT_MAX_CHARS

      if (args.requestID && ctx.storage && typeof ctx.storage.get === "function") {
        return withLock(args.requestID, async () => {
          const loaded = await loadOperation(ctx, args.requestID!)
          if (!loaded) {
            return reply({ requestID: args.requestID, sessionID: args.sessionID, state: "unknown", status: "unknown", unchanged: false, error: "unknown requestID" })
          }
          const op = await reconcileOperation(ctx, loaded)
          await verifyNotificationTarget(op, codexDelivery)
          if (!isTerminal(op) || !op.completion) {
            const needsInput = isTerminal(op)
              ? null
              : op.attention ?? await detectNeedsInput(ctx, op.sessionID ?? args.sessionID, op.identity.directory)
            return reply(operationSummary(op, { unchanged: false, needsInput }, codexDelivery))
          }
          const c = op.completion
          const unchanged = args.force !== true && op.lastOutputId === c.outputId
          if (!unchanged) {
            op.lastOutputId = c.outputId
            await saveOperation(ctx, op)
          }
          const text = c.text ?? ""
          const truncated = text.length > cap
          return reply({
            requestID: op.requestID,
            sessionID: op.sessionID,
            state: op.state,
            status: op.state,
            outputId: c.outputId,
            unchanged,
            ...(unchanged ? {} : { text: truncated ? text.slice(0, cap) : text, truncated }),
            model: c.model,
            finish: c.finish,
            outcome: c.outcome,
            tokens: c.tokens,
            cost: c.cost,
            error: c.error,
            ...notificationFields(op, codexDelivery),
          })
        })
      }

      const latest = await lastAssistant(ctx, args.sessionID)
      const truncated = latest.text.length > cap
      return reply({
        sessionID: args.sessionID,
        text: truncated ? latest.text.slice(0, cap) : latest.text,
        truncated,
        outputId: latest.outputId,
        model: latest.model,
        finish: latest.finish,
        outcome: latest.outcome,
        tokens: latest.tokens,
        cost: latest.cost,
        error: latest.error,
      })
    },
  )

  server.registerTool(
    "opencode_delivery",
    {
      description:
        "Inspect or deliberately recover Codex push delivery for a recorded requestID. action=inspect (default) is read-only. action=deliver sends a first terminal result only when that output has no prior delivery record. action=retry resends only known preflight failures; accepted, rejected, sending and ambiguous entries are never resent. action=recover marks stale sending reservations ambiguous without sending a duplicate turn/start. Use directory to select the operation's location.",
      inputSchema: {
        requestID: z.string().describe("Recorded operation requestID"),
        directory: z.string().optional().describe("Resolve this recovery request against the operation's project location"),
        sessionID: z.string().optional().describe("Optional session check"),
        action: z
          .enum(["inspect", "deliver", "retry", "recover"])
          .optional()
          .describe("inspect (default), deliver a missing first result, retry preflight failures, or recover stale sending"),
        outputId: z.string().optional().describe("Expected result outputId or delivery key"),
      },
    },
    async (args) => {
      if (!ctx.storage || typeof ctx.storage.get !== "function") {
        throw new Error("requestID delivery inspection requires plugin storage")
      }
      const loaded = await loadOperation(ctx, args.requestID)
      if (!loaded) {
        return reply({
          requestID: args.requestID,
          state: "unknown",
          status: "unknown",
          error: "unknown requestID",
        })
      }
      if (args.sessionID && loaded.sessionID !== args.sessionID) {
        return reply({
          requestID: args.requestID,
          sessionID: args.sessionID,
          state: "unknown",
          status: "unknown",
          error: "requestID is bound to a different session",
        })
      }
      const action = args.action ?? "inspect"
      let retries: unknown
      let delivered: unknown
      let recovered: unknown
      if (action !== "inspect") {
        const delivery = await import("./codex-delivery")
        const transport = options.deliveryTransport
        if (action === "deliver") {
          delivered = await delivery.deliverFirstRecordedOperation(
            ctx,
            args.requestID,
            args.outputId,
            transport ? { transport } : {},
          )
        } else if (action === "retry") {
          retries = await delivery.retryRecordedDeliveries(ctx, args.requestID, {
            ...(args.outputId ? { key: args.outputId } : {}),
            ...(transport ? { transport } : {}),
          })
        } else {
          recovered = await delivery.recoverStaleSending(ctx, args.requestID, {
            ...(args.outputId ? { key: args.outputId } : {}),
          })
        }
      }
      const op = await loadOperation(ctx, args.requestID) ?? loaded
      await verifyNotificationTarget(op, codexDelivery)
      return reply({
        ...operationSummary(op, {}, codexDelivery),
        deliveryAction: action,
        ...(delivered ? { delivered } : {}),
        ...(retries ? { retries } : {}),
        ...(recovered ? { recovered } : {}),
      })
    },
  )

  server.registerTool(
    "opencode_interrupt",
    {
      description: "Interrupt the current run of an OpenCode session.",
      inputSchema: { sessionID: z.string() },
    },
    async (args) => {
      await ctx.session.interrupt({ sessionID: args.sessionID, continue: false })
      return reply({ sessionID: args.sessionID, status: "interrupted" })
    },
  )

  server.registerTool(
    "opencode_list",
    {
      description: "List OpenCode sessions started through this MCP bridge.",
      inputSchema: { limit: z.number().int().positive().optional().describe("Defaults to 20") },
    },
    async (args) => {
      const entries: Array<Record<string, any>> = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({
          prefix: "sessions/",
          ...(after ? { after } : {}),
          limit: 100,
        })
        for (const entry of page.entries) {
          if (entry.value && typeof entry.value === "object") {
            entries.push(entry.value as Record<string, any>)
          }
        }
        after = page.next
      } while (after)

      entries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      const limit = args.limit ?? 20
      const sessions = await Promise.all(
        entries.slice(0, limit).map(async (entry) => {
          try {
            const info: any = await ctx.session.get({ sessionID: entry.sessionID })
            return { ...entry, outcome: info.outcome ?? null, updated: info.time?.updated ?? null }
          } catch {
            return { ...entry, outcome: "missing" }
          }
        }),
      )
      return reply({ sessions, total: entries.length })
    },
  )
}
