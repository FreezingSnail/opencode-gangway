import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

export const TAG = "[gangway]"
export const DEFAULT_MODEL = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
// A single tool call must finish inside the caller's request window. The MCP SDK
// default is 60s (`Client` requestTimeout), so the bridge caps its own default
// wait below that. Callers may override `timeoutMs`, but that does not raise the
// client limit and the bridge never cancels the underlying run on expiry.
export const CLIENT_REQUEST_LIMIT_MS = 60_000
export const DEFAULT_WAIT_MS = 45_000
export const DEFAULT_MAX_CHARS = 20_000

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
// immediately; requestID operations use the boundary-aware path below.
async function waitForIdle(ctx: Ctx, sessionID: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  try {
    await withTimeout(Promise.resolve(ctx.session.wait({ sessionID })), timeoutMs)
    return true
  } catch (error) {
    if (error instanceof TimeoutError) return false
    // ctx.session.wait may be unavailable on older services; fall back to
    // polling the transcript for a trailing idle message.
    while (Date.now() < deadline) {
      await sleep(1500)
      const latest = await lastAssistant(ctx, sessionID)
      if (latest.idle) return true
    }
    return false
  }
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

type Identity = {
  kind: "start" | "prompt"
  directory: string | null
  model: string | null
  agent: string | null
  sessionID: string | null
  prompt: string
}

type OperationState =
  | "intent" // intent recorded, upstream effect not yet attempted (or unknown)
  | "created" // session id known and recorded, prompt not submitted
  | "submitting" // prompt submission attempted; delivery unknown if interrupted here
  | "submitted" // prompt submission returned
  | "completed"
  | "failed"
  | "unknown"

interface Completion {
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

interface OperationRecord {
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
}

const locksKey = Symbol.for("gangway.operation-locks.v1")
const globalLocks = globalThis as typeof globalThis & {
  [locksKey]?: Map<string, Promise<unknown>>
}
const operationLocks = globalLocks[locksKey] ??= new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

async function loadOperation(ctx: Ctx, requestID: string): Promise<OperationRecord | null> {
  const raw = await ctx.storage.get(operationKey(requestID))
  if (raw && typeof raw === "object") return raw as OperationRecord
  return null
}

async function saveOperation(ctx: Ctx, op: OperationRecord): Promise<void> {
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
  }
}

function isTerminal(op: OperationRecord): boolean {
  return op.state === "completed" || op.state === "failed"
}

function stateStatus(op: OperationRecord): string {
  if (op.state === "completed" || op.state === "failed") return op.state
  if (op.state === "submitting" || op.state === "unknown") return "unknown"
  if (op.state === "submitted") return "running"
  return "pending"
}

function toCompletion(message: any, outcome: string | null, tail: any): Completion {
  const content: any[] = Array.isArray(message?.content) ? message.content : []
  return {
    text: content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim(),
    model: message?.model ?? null,
    cost: message?.cost ?? null,
    tokens: message?.tokens ?? null,
    finish: message?.finish ?? null,
    error: message?.error ?? null,
    outcome,
    messageID: typeof message?.id === "string" ? message.id : null,
    outputId: outputIdOf(message, tail) ?? "message@?@?",
    completedAt: message?.time?.completed ?? message?.time?.created ?? null,
  }
}

interface Probe {
  status: "completed" | "failed" | "running"
  completion?: Completion
  freshCount: number
}

// Turn binding: only messages appended after the recorded boundary count, and a
// trailing idle message, can complete the operation. A prior assistant answer or
// an idle that predates submission is invisible here.
async function probeTranscript(ctx: Ctx, sessionID: string, boundary: number | null): Promise<Probe> {
  const messages = await transcript(ctx, sessionID)
  const start = boundary ?? messages.length
  const fresh = messages.slice(start)
  const freshCount = fresh.length
  const tail = messages.at(-1)
  const assistants = fresh.filter((message) => message?.type === "assistant")
  const last = assistants.at(-1)
  if (last && tail?.type === "idle") {
    const outcome: string | null = tail.outcome ?? null
    return {
      status: outcome === "failed" ? "failed" : "completed",
      completion: toCompletion(last, outcome, tail),
      freshCount,
    }
  }
  return { status: "running", freshCount }
}

// Reconcile a durable operation against upstream state. Never resends or
// recreates: it only observes and advances the recorded state.
async function reconcileOperation(ctx: Ctx, op: OperationRecord): Promise<OperationRecord> {
  if (isTerminal(op) || op.sessionID == null || op.boundary == null) return op
  let probe: Probe
  try {
    probe = await probeTranscript(ctx, op.sessionID, op.boundary)
  } catch {
    // Transient upstream read failure: keep the recorded state, do not flip it.
    return op
  }
  if (probe.status === "completed" || probe.status === "failed") {
    op.state = probe.status
    op.completion = probe.completion ?? null
    op.error = null
  } else if (op.delivery === "unknown" && probe.freshCount > 0) {
    // Reconciliation found our turn admitted upstream, so delivery is no longer
    // ambiguous. The turn may still be running.
    op.delivery = "recorded"
    op.state = "submitted"
    op.error = null
  }
  await saveOperation(ctx, op)
  return op
}

function operationSummary(op: OperationRecord, extra: Record<string, unknown> = {}) {
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
    error: op.error,
    ...(op.warnings?.length ? { warnings: op.warnings } : {}),
    ...extra,
  }
}

function completionSummary(op: OperationRecord) {
  const c = op.completion
  return {
    ...operationSummary(op),
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

async function waitForCompletion(ctx: Ctx, start: OperationRecord, budgetMs: number): Promise<OperationRecord> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  let op = start
  for (;;) {
    op = await reconcileOperation(ctx, op)
    if (isTerminal(op)) return op
    const remaining = deadline - Date.now()
    if (remaining <= 0) return op
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
      await saveOperation(ctx, op)
    }

    if (existing) {
      op = await reconcileOperation(ctx, op)
      if (isTerminal(op)) return { op }
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
  args: { sessionID: string; text: string },
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
      await saveOperation(ctx, op)
    }
    if (existing) {
      op = await reconcileOperation(ctx, op)
      if (isTerminal(op)) return { op }
    }
    if (op.state === "intent" || op.state === "created") {
      op = await submitPrompt(ctx, op, args.text)
    }
    return { op }
  })
}

function statusPayload(op: OperationRecord, info: Record<string, any>) {
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
  options: { defaultWaitMs?: number; inheritPermissions?: boolean; titlePrefix?: string } = {},
) {
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS
  const titlePrefix = options.titlePrefix ?? TAG
  const permissions = options.inheritPermissions ? undefined : unattendedRuleset()

  server.registerTool(
    "opencode_start_session",
    {
      description:
        "Start an OpenCode implementation session (defaults to model opencode-go/deepseek-v4.1-flash) and send it an initial prompt. Returns the session ID; pass wait=true to block until the run finishes. Pass a requestID to make dispatch idempotent and resumable.",
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
          .describe("Idempotency key; identical retries resolve to the same recorded operation"),
      },
    },
    async (args) => {
      const model = args.sessionID ? null : parseModel(args.model)

      if (!args.requestID) {
        if (args.sessionID) {
          await ctx.session.get({ sessionID: args.sessionID })
          await ctx.session.prompt({ sessionID: args.sessionID, text: args.prompt })
          if (!args.wait) return reply({ sessionID: args.sessionID, status: "queued" })
          const idle = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
          const latest = await lastAssistant(ctx, args.sessionID)
          return reply({ sessionID: args.sessionID, status: idle ? "idle" : "busy", ...latest })
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
        const idle = await waitForIdle(ctx, created.id, args.timeoutMs ?? defaultWaitMs)
        const latest = await lastAssistant(ctx, created.id)
        return reply({ sessionID: created.id, status: idle ? "idle" : "busy", ...latest })
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
        },
        permissions,
        titlePrefix,
        defaultWaitMs,
      )
      if (!args.wait) return reply({ ...operationSummary(op), worstCaseWaitMs: defaultWaitMs })
      const finished = isTerminal(op) ? op : await waitForCompletion(ctx, op, args.timeoutMs ?? defaultWaitMs)
      if (isTerminal(finished)) return reply(completionSummary(finished))
      return reply(operationSummary(finished, { timedOut: true, reason: reason ?? "wait-expired" }))
    },
  )

  server.registerTool(
    "opencode_prompt",
    {
      description:
        "Send a follow-up prompt to an existing OpenCode session. Pass a requestID to make dispatch idempotent and resumable.",
      inputSchema: {
        sessionID: z.string().describe("Session ID (ses_...)"),
        text: z.string(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
        requestID: z
          .string()
          .optional()
          .describe("Idempotency key; identical retries resolve to the same recorded operation"),
      },
    },
    async (args) => {
      if (!args.requestID) {
        await ctx.session.get({ sessionID: args.sessionID })
        await ctx.session.prompt({ sessionID: args.sessionID, text: args.text })
        if (!args.wait) return reply({ sessionID: args.sessionID, status: "queued" })
        const idle = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
        const latest = await lastAssistant(ctx, args.sessionID)
        return reply({ sessionID: args.sessionID, status: idle ? "idle" : "busy", ...latest })
      }

      requireStorage(ctx)
      await ctx.session.get({ sessionID: args.sessionID })
      const { op } = await preparePrompt(ctx, args.requestID, { sessionID: args.sessionID, text: args.text })
      if (!args.wait) return reply({ ...operationSummary(op), worstCaseWaitMs: defaultWaitMs })
      const finished = isTerminal(op) ? op : await waitForCompletion(ctx, op, args.timeoutMs ?? defaultWaitMs)
      if (isTerminal(finished)) return reply(completionSummary(finished))
      return reply(operationSummary(finished, { timedOut: true, reason: "wait-expired" }))
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
        const reconciled = await reconcileOperation(ctx, op)
        if (isTerminal(reconciled)) return reply(completionSummary(reconciled))
        const finished = await waitForCompletion(ctx, reconciled, args.timeoutMs ?? defaultWaitMs)
        if (isTerminal(finished)) return reply(completionSummary(finished))
        return reply(operationSummary(finished, { timedOut: true, reason: "wait-expired" }))
      }
      const idle = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
      const latest = await lastAssistant(ctx, args.sessionID)
      return reply({ sessionID: args.sessionID, status: idle ? "idle" : "busy", ...latest })
    },
  )

  server.registerTool(
    "opencode_status",
    {
      description:
        "Report an OpenCode session's state. With requestID returns compact recorded operation state (no transcript fetch unless reconcile=true). Without requestID returns session info plus a tail of the latest assistant output.",
      inputSchema: {
        sessionID: z.string(),
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
              session: { outcome: info.outcome ?? null, updated: info.time?.updated ?? null },
            })
          }
          if (args.reconcile) op = await reconcileOperation(ctx, op)
          return reply(statusPayload(op, info))
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
      })
    },
  )

  server.registerTool(
    "opencode_result",
    {
      description:
        "Return bounded assistant output. With requestID returns the recorded operation's own result and reports unchanged output instead of resending it (pass force=true to resend).",
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
          if (!isTerminal(op) || !op.completion) {
            return reply(operationSummary(op, { unchanged: false }))
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
