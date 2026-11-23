// Server-side execution and attention event recording (gangway-34r.1).
//
// OpenCode emits durable execution outcomes (`session.execution.*`), inbox
// admission, text blocks, idle status, and permission/form requests. This module
// subscribes to those events, binds each one to the single outstanding Gangway
// operation for its session, and persists the observed result before any
// consumer can read a completion. It never resends prompts or recreates
// sessions; transcript reconciliation is read-only.

import type { FormInfo, NeedsInput, NeedsInputProbe, PermissionRequestInfo } from "./attention"
import { probeNeedsInput } from "./attention"
import { formAttentionKey, isAttentionKey, permissionAttentionKey } from "./codex-attention"
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_PROBE_TIMEOUT_MS,
  isTerminal,
  loadOperation,
  probeTranscript,
  reconcileOperation,
  saveOperation,
  toCompletion,
  withLock,
  type Completion,
  type Ctx,
  type OperationRecord,
  type OperationState,
} from "./tools"

const LOG = "[gangway]"
const SCAN_PAGE = 100
const TEXT_CAP = DEFAULT_MAX_CHARS

export type ExecutionEventType =
  | "session.inbox.enqueued"
  | "session.inbox.delivered"
  | "session.execution.started"
  | "session.execution.succeeded"
  | "session.execution.failed"
  | "session.execution.interrupted"
  | "session.idle"
  | "session.text.ended"
  | "session.step.ended"
  | "session.step.failed"
  | "permission.asked"
  | "permission.replied"
  | "form.created"
  | "form.replied"
  | "form.cancelled"

const HANDLED = new Set<string>([
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.text.ended",
  "session.step.ended",
  "session.step.failed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
])

interface NormalizedEvent {
  id: string | null
  type: ExecutionEventType
  created: number | null
  data: Record<string, unknown>
}

export interface EventResult {
  handled: boolean
  reason?: string
  requestID?: string
  sessionID?: string
  state?: OperationState
  terminal?: boolean
  // Stable dedupe key for a newly observed needs-input item. The plugin uses it
  // to push one attention notification per request/form, never per duplicate.
  attentionKey?: string
}

export interface DeliveryReconciliationCandidate {
  requestID: string
  result: boolean
  attentionKeys: string[]
}

export interface DeliveryReconciliation {
  candidates: DeliveryReconciliationCandidate[]
  terminalizedRequestIDs: string[]
  transientRequestIDs: string[]
}

interface EventChange {
  changed: boolean
  attentionKey?: string
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function finiteOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function normalize(raw: unknown): NormalizedEvent | null {
  const event = objectOf(raw)
  if (!event) return null
  const type = stringOf(event.type)
  if (!type || !HANDLED.has(type)) return null
  return {
    id: stringOf(event.id),
    type: type as ExecutionEventType,
    created: finiteOf(event.created),
    data: objectOf(event.data) ?? {},
  }
}

function sessionIDOf(event: NormalizedEvent): string | null {
  if (event.type === "form.created") {
    return stringOf(objectOf(event.data.form)?.sessionID)
  }
  return stringOf(event.data.sessionID)
}

function ignored(reason: string): EventResult {
  return { handled: false, reason }
}

function boundText(value: string): string {
  return value.length > TEXT_CAP ? value.slice(0, TEXT_CAP) : value
}

function errorText(value: unknown): string | null {
  if (typeof value === "string" && value) return boundText(value)
  const error = objectOf(value)
  const message = stringOf(error?.message)
  return message ? boundText(message) : null
}

function terminalOutcome(type: ExecutionEventType): string | null {
  if (type === "session.execution.succeeded") return "succeeded"
  if (type === "session.execution.failed") return "failed"
  if (type === "session.execution.interrupted") return "interrupted"
  return null
}

function completionModel(op: OperationRecord): unknown {
  const recorded = op.identity.model
  if (!recorded) return null
  const slash = recorded.indexOf("/")
  if (slash <= 0 || slash === recorded.length - 1) return null
  return { providerID: recorded.slice(0, slash), id: recorded.slice(slash + 1) }
}

function eventOutputId(event: NormalizedEvent, outcome: string | null): string {
  return `${event.id ?? "event"}@${event.created ?? "?"}@${outcome ?? "?"}`
}

function completionFromEvent(
  op: OperationRecord,
  event: NormalizedEvent,
  outcome: string,
  probeCompletion: Completion | null,
): Completion {
  if (probeCompletion) {
    return {
      ...probeCompletion,
      outcome,
      // A failed execution keeps the structured failure; a successful event
      // clears any transcript-carried error.
      error: outcome === "succeeded" ? null : probeCompletion.error,
    }
  }
  return {
    text: boundText(op.streamText ?? ""),
    model: completionModel(op),
    cost: op.streamCost ?? null,
    tokens: op.streamTokens ?? null,
    finish: op.streamFinish ?? null,
    error: null,
    outcome,
    messageID: op.streamMessageID ?? null,
    outputId: eventOutputId(event, outcome),
    completedAt: event.created ?? Date.now(),
  }
}

// Only messages appended after the recorded boundary can complete an operation.
// A terminal event proves admission, so a projection lag is tolerated and the
// bounded streamed text is used until the transcript catches up.
async function finishFromEvent(
  ctx: Ctx,
  op: OperationRecord,
  event: NormalizedEvent,
  outcome: string,
  error: string | null,
): Promise<void> {
  let probeCompletion: Completion | null = null
  if (op.sessionID != null && op.boundary != null) {
    try {
      const probe = await probeTranscript(ctx, op.sessionID, op.boundary)
      if ((probe.status === "completed" || probe.status === "failed") && probe.completion) {
        probeCompletion = probe.completion
      }
    } catch {
      // Transcript projection is best-effort; the event remains authoritative.
    }
  }

  op.state = outcome === "succeeded" ? "completed" : "failed"
  const completion = completionFromEvent(op, event, outcome, probeCompletion)
  completion.text = boundText(completion.text)
  if (outcome !== "succeeded") completion.error = error ?? completion.error
  op.completion = completion
  op.error = outcome === "succeeded" ? null : error
  op.delivery = "recorded"
  op.attention = null
  op.terminalEventId = event.id
  op.terminalSource = "event"
}

function isStale(op: OperationRecord, event: NormalizedEvent): boolean {
  if (op.submittedAt == null || event.created == null) return false
  return event.created < op.submittedAt
}

function sameRequest(a: PermissionRequestInfo, b: PermissionRequestInfo): boolean {
  if (a.id && b.id) return a.id === b.id
  const aSource = a.sourceEventID
  const bSource = b.sourceEventID
  if (bSource?.startsWith("event:") && a.sourceEventIDs?.length) {
    return a.sourceEventIDs.includes(bSource)
  }
  if (aSource && bSource && aSource !== bSource) {
    const aQueue = aSource.startsWith("queue:")
    const bQueue = bSource.startsWith("queue:")
    if (aQueue === bQueue) return false
  }
  return a.action === b.action && a.message === b.message &&
    JSON.stringify(a.resources ?? null) === JSON.stringify(b.resources ?? null)
}

function sameForm(a: FormInfo, b: FormInfo): boolean {
  if (a.id && b.id) return a.id === b.id
  const aSource = a.sourceEventID
  const bSource = b.sourceEventID
  if (bSource?.startsWith("event:") && a.sourceEventIDs?.length) {
    return a.sourceEventIDs.includes(bSource)
  }
  if (aSource && bSource && aSource !== bSource) {
    const aQueue = aSource.startsWith("queue:")
    const bQueue = bSource.startsWith("queue:")
    if (aQueue === bQueue) return false
  }
  return a.title === b.title
}

function eventBacked(item: { sourceEventID?: string | null }): boolean {
  return Boolean(item.sourceEventID && !item.sourceEventID.startsWith("queue:"))
}

function mergeRequestIdentity(
  existing: PermissionRequestInfo,
  incoming: PermissionRequestInfo,
): PermissionRequestInfo {
  const eventIDs = new Set(existing.sourceEventIDs ?? [])
  const primaryEventID = eventBacked(existing) ? existing.sourceEventID : null
  for (const item of [existing, incoming]) {
    if (eventBacked(item) && item.sourceEventID && item.sourceEventID !== primaryEventID) {
      eventIDs.add(item.sourceEventID)
    }
    for (const id of item.sourceEventIDs ?? []) eventIDs.add(id)
  }
  return {
    ...incoming,
    ...existing,
    id: existing.id ?? incoming.id,
    // Keep the first observed primary identity. In particular, do not upgrade
    // a queue-first shape key to a later event ID and notify it a second time.
    sourceEventID: existing.sourceEventID,
    ...(eventIDs.size > 0 ? { sourceEventIDs: [...eventIDs] } : {}),
    action: existing.action ?? incoming.action,
    resources: existing.resources ?? incoming.resources,
    message: existing.message ?? incoming.message,
  }
}

function mergeFormIdentity(existing: FormInfo, incoming: FormInfo): FormInfo {
  const eventIDs = new Set(existing.sourceEventIDs ?? [])
  const primaryEventID = eventBacked(existing) ? existing.sourceEventID : null
  for (const item of [existing, incoming]) {
    if (eventBacked(item) && item.sourceEventID && item.sourceEventID !== primaryEventID) {
      eventIDs.add(item.sourceEventID)
    }
    for (const id of item.sourceEventIDs ?? []) eventIDs.add(id)
  }
  return {
    ...incoming,
    ...existing,
    id: existing.id ?? incoming.id,
    sourceEventID: existing.sourceEventID,
    ...(eventIDs.size > 0 ? { sourceEventIDs: [...eventIDs] } : {}),
    title: existing.title ?? incoming.title,
  }
}

function mergeRequestQueues(
  existing: PermissionRequestInfo[],
  observed: PermissionRequestInfo[],
): PermissionRequestInfo[] {
  const merged = [...existing.filter(eventBacked)]
  for (const request of observed) {
    const priorQueue = existing.find((item) => !eventBacked(item) && sameRequest(item, request))
    const index = priorQueue
      ? merged.findIndex((item) => sameRequest(priorQueue, item))
      : merged.findIndex((item) => sameRequest(item, request))
    if (priorQueue && index >= 0) {
      merged[index] = mergeRequestIdentity(
        mergeRequestIdentity(priorQueue, merged[index]),
        request,
      )
    } else if (priorQueue) {
      merged.push(mergeRequestIdentity(priorQueue, request))
    } else if (index >= 0) {
      merged[index] = mergeRequestIdentity(merged[index], request)
    } else {
      merged.push(request)
    }
  }
  return merged
}

function mergeFormQueues(existing: FormInfo[], observed: FormInfo[]): FormInfo[] {
  const merged = [...existing.filter(eventBacked)]
  for (const form of observed) {
    const priorQueue = existing.find((item) => !eventBacked(item) && sameForm(item, form))
    const index = priorQueue
      ? merged.findIndex((item) => sameForm(priorQueue, item))
      : merged.findIndex((item) => sameForm(item, form))
    if (priorQueue && index >= 0) {
      merged[index] = mergeFormIdentity(
        mergeFormIdentity(priorQueue, merged[index]),
        form,
      )
    } else if (priorQueue) {
      merged.push(mergeFormIdentity(priorQueue, form))
    } else if (index >= 0) {
      merged[index] = mergeFormIdentity(merged[index], form)
    } else {
      merged.push(form)
    }
  }
  return merged
}

function mergeQueueAttention(op: OperationRecord, probe: NeedsInputProbe): boolean {
  const previous = op.attention ?? { kind: "question" as const, requests: [], forms: [] }
  const requests = probe.permission === null
    ? previous.requests
    : mergeRequestQueues(previous.requests, probe.permission)
  const forms = probe.forms === null
    ? previous.forms
    : mergeFormQueues(previous.forms, probe.forms)
  const next = normalizeAttention([...requests], [...forms])
  if (JSON.stringify(next) === JSON.stringify(op.attention)) return false
  op.attention = next
  return true
}

function normalizeAttention(
  requests: PermissionRequestInfo[],
  forms: FormInfo[],
): NeedsInput | null {
  if (requests.length === 0 && forms.length === 0) return null
  return {
    kind: requests.some((request) => request.action !== "question") ? "permission" : "question",
    requests,
    forms,
  }
}

function addRequest(op: OperationRecord, request: PermissionRequestInfo): boolean {
  const current = op.attention ?? { kind: "question" as const, requests: [], forms: [] }
  const requests = [...current.requests]
  const index = requests.findIndex((entry) => sameRequest(entry, request))
  if (index >= 0) {
    const merged = mergeRequestIdentity(requests[index], request)
    if (JSON.stringify(requests[index]) === JSON.stringify(merged)) return false
    requests[index] = merged
  } else {
    requests.push(request)
  }
  op.attention = normalizeAttention(requests, [...current.forms])
  return true
}

function addForm(op: OperationRecord, form: FormInfo): boolean {
  const current = op.attention ?? { kind: "question" as const, requests: [], forms: [] }
  const forms = [...current.forms]
  const index = forms.findIndex((entry) => sameForm(entry, form))
  if (index >= 0) {
    const merged = mergeFormIdentity(forms[index], form)
    if (JSON.stringify(forms[index]) === JSON.stringify(merged)) return false
    forms[index] = merged
  } else {
    forms.push(form)
  }
  op.attention = normalizeAttention([...current.requests], forms)
  return true
}

function removeRequest(op: OperationRecord, id: string | null): boolean {
  if (!op.attention) return false
  const requests = op.attention.requests.filter((request) =>
    id ? request.id !== id : false,
  )
  if (requests.length === op.attention.requests.length) return false
  op.attention = normalizeAttention(requests, [...op.attention.forms])
  return true
}

function removeForm(op: OperationRecord, id: string | null): boolean {
  if (!op.attention) return false
  const forms = op.attention.forms.filter((form) => (id ? form.id !== id : false))
  if (forms.length === op.attention.forms.length) return false
  op.attention = normalizeAttention([...op.attention.requests], forms)
  return true
}

function permissionInfo(data: Record<string, unknown>, sourceEventID: string): PermissionRequestInfo {
  return {
    id: stringOf(data.id),
    sourceEventID,
    action: stringOf(data.action),
    resources: data.resources ?? null,
    message: stringOf(data.message),
  }
}

function formInfo(form: Record<string, unknown>, sourceEventID: string): FormInfo {
  return {
    id: stringOf(form.id),
    sourceEventID,
    title: stringOf(form.title),
  }
}

function attentionEventIdentity(event: NormalizedEvent): string {
  if (event.id) return `event:${event.id}`
  return `event:${event.type}:${event.created ?? "?"}:${JSON.stringify(event.data)}`
}

async function listOutstanding(
  ctx: Ctx,
  sessionID?: string,
  includeTerminal = false,
): Promise<OperationRecord[]> {
  const found: OperationRecord[] = []
  let after: string | undefined
  const cursors = new Set<string>()
  while (true) {
    const page = await ctx.storage.scan({
      prefix: "operations/",
      ...(after ? { after } : {}),
      limit: SCAN_PAGE,
    })
    const entries = Array.isArray(page?.entries) ? page.entries : []
    for (const entry of entries) {
      const raw = objectOf(entry?.value)
      if (!raw || typeof raw.requestID !== "string" || typeof raw.state !== "string") continue
      if (!includeTerminal && isTerminal(raw as unknown as OperationRecord)) continue
      if (sessionID != null && raw.sessionID !== sessionID) continue
      if (raw.sessionID == null) continue
      found.push(raw as unknown as OperationRecord)
    }
    const next = typeof page?.next === "string" && page.next && page.next !== after ? page.next : undefined
    if (!next || entries.length === 0 || cursors.has(next)) break
    cursors.add(next)
    after = next
  }
  return found
}

function newer(a: OperationRecord, b: OperationRecord): boolean {
  const aTime = a.submittedAt ?? a.createdAt ?? 0
  const bTime = b.submittedAt ?? b.createdAt ?? 0
  if (aTime !== bTime) return aTime > bTime
  return a.requestID > b.requestID
}

async function findOperation(
  ctx: Ctx,
  event: NormalizedEvent,
  sessionID: string,
): Promise<OperationRecord | null> {
  const candidates = await listOutstanding(ctx, sessionID)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  // Stronger identity when an inbox id is available; otherwise the design's
  // one-outstanding-operation-per-session rule picks the newest admission.
  const inboxID = stringOf(event.data.inboxID)
  if (inboxID) {
    const matched = candidates.find((candidate) => candidate.submittedMessageID === inboxID)
    if (matched) return matched
  }
  return candidates.reduce((latest, candidate) => (newer(candidate, latest) ? candidate : latest))
}

async function applyEvent(
  ctx: Ctx,
  op: OperationRecord,
  event: NormalizedEvent,
): Promise<EventChange> {
  const changed = (attentionKey?: string): EventChange =>
    attentionKey ? { changed: true, attentionKey } : { changed: true }
  if (isStale(op, event)) return { changed: false }
  // Events only bind after the prompt submission intent is durable; a queue or
  // idle state that predates submission belongs to an earlier turn.
  if (op.submittedAt == null) return { changed: false }
  const created = event.created ?? Date.now()
  const outcome = terminalOutcome(event.type)

  if (outcome) {
    const error = outcome === "succeeded"
      ? null
      : outcome === "interrupted"
        ? `interrupted: ${stringOf(event.data.reason) ?? "unknown"}`
        : errorText(event.data.error) ?? "execution failed"
    await finishFromEvent(ctx, op, event, outcome, error)
    return changed()
  }

  switch (event.type) {
    case "session.inbox.enqueued": {
      const item = objectOf(event.data.item)
      if (item && item.type !== "user") return { changed: false }
      const inboxID = stringOf(event.data.inboxID)
      if (op.submittedMessageID && inboxID && inboxID !== op.submittedMessageID) return { changed: false }
      op.admittedAt = created
      if (op.delivery === "unknown") op.delivery = "recorded"
      if (op.state === "unknown") {
        op.state = "submitted"
        op.error = null
      }
      return changed()
    }
    case "session.inbox.delivered": {
      const inboxID = stringOf(event.data.inboxID)
      if (op.submittedMessageID && inboxID && inboxID !== op.submittedMessageID) return { changed: false }
      op.admittedAt = created
      if (op.delivery === "unknown") op.delivery = "recorded"
      if (op.state === "unknown") {
        op.state = "submitted"
        op.error = null
      }
      return changed()
    }
    case "session.execution.started": {
      op.executionStartedAt = created
      op.admittedAt ??= created
      if (op.delivery === "unknown") op.delivery = "recorded"
      if (op.state === "unknown") {
        op.state = "submitted"
        op.error = null
      }
      return changed()
    }
    case "session.text.ended": {
      const text = typeof event.data.text === "string" ? event.data.text : null
      if (text == null) return { changed: false }
      const messageID = stringOf(event.data.assistantMessageID)
      const key = `${messageID ?? "message"}:${finiteOf(event.data.ordinal) ?? "?"}`
      if (op.streamKey === key) return { changed: false }
      op.streamKey = key
      op.streamMessageID = messageID ?? op.streamMessageID ?? null
      const next = op.streamText ? `${op.streamText}\n${text}` : text
      op.streamText = boundText(next)
      return changed()
    }
    case "session.step.ended": {
      op.streamFinish = event.data.finish ?? op.streamFinish ?? null
      op.streamCost = event.data.cost ?? op.streamCost ?? null
      op.streamTokens = event.data.tokens ?? op.streamTokens ?? null
      return changed()
    }
    case "session.step.failed": {
      op.streamFinish = event.data.finish ?? "error"
      op.streamCost = event.data.cost ?? op.streamCost ?? null
      op.streamTokens = event.data.tokens ?? op.streamTokens ?? null
      const detail = errorText(event.data.error)
      if (detail) op.error = detail
      return changed()
    }
    case "session.idle": {
      // A stale idle (before submission) or an idle without any admission
      // evidence is not our turn. A fresh transcript reading is authoritative.
      let probe = null
      if (op.sessionID != null && op.boundary != null) {
        try {
          probe = await probeTranscript(ctx, op.sessionID, op.boundary)
        } catch {
          probe = null
        }
      }
      if (probe && (probe.status === "completed" || probe.status === "failed") && probe.completion) {
        op.state = probe.status
        op.completion = { ...probe.completion, text: boundText(probe.completion.text) }
        op.error = null
        op.attention = null
        op.terminalEventId = event.id
        op.terminalSource = "event"
        op.delivery = "recorded"
        return changed()
      }
      if (op.admittedAt == null && op.executionStartedAt == null && op.delivery !== "recorded") {
        return { changed: false }
      }
      await finishFromEvent(ctx, op, event, "succeeded", null)
      return changed()
    }
    case "permission.asked": {
      const request = permissionInfo(event.data, attentionEventIdentity(event))
      if (!addRequest(op, request)) return { changed: false }
      const recorded = op.attention?.requests.find((item) => sameRequest(item, request)) ?? request
      return changed(permissionAttentionKey(recorded))
    }
    case "permission.replied": {
      return { changed: removeRequest(op, stringOf(event.data.requestID) ?? stringOf(event.data.id)) }
    }
    case "form.created": {
      const form = objectOf(event.data.form)
      if (!form) return { changed: false }
      const info = formInfo(form, attentionEventIdentity(event))
      if (!addForm(op, info)) return { changed: false }
      const recorded = op.attention?.forms.find((item) => sameForm(item, info)) ?? info
      return changed(formAttentionKey(recorded))
    }
    case "form.replied":
    case "form.cancelled": {
      return { changed: removeForm(op, stringOf(event.data.id)) }
    }
  }
  return { changed: false }
}

/**
 * Record one server event against the operation it belongs to. Returns an
 * ignored result for unhandled, malformed, stale, unrelated or duplicate
 * events. Every mutation is serialized with operation dispatch and the updated
 * record is persisted before this resolves.
 */
export async function recordExecutionEvent(
  ctx: Ctx,
  raw: unknown,
): Promise<EventResult> {
  const event = normalize(raw)
  if (!event) return ignored("unhandled-event")
  const sessionID = sessionIDOf(event)
  if (!sessionID) return ignored("no-session")

  let candidate: OperationRecord | null
  try {
    candidate = await findOperation(ctx, event, sessionID)
  } catch (error) {
    return ignored(`operation-scan-failed: ${errorText(error) ?? "unknown"}`)
  }
  if (!candidate) return { handled: false, reason: "no-operation", sessionID }

  return withLock(candidate.requestID, async () => {
    const op = await loadOperation(ctx, candidate!.requestID)
    if (!op || op.sessionID !== sessionID) {
      return { handled: false, reason: "operation-moved", sessionID }
    }
    if (isTerminal(op)) {
      return {
        handled: false,
        reason: op.terminalEventId && op.terminalEventId === event.id ? "duplicate-terminal" : "terminal",
        requestID: op.requestID,
        sessionID,
        state: op.state,
        terminal: true,
      }
    }
    const change = await applyEvent(ctx, op, event)
    if (!change.changed) {
      return {
        handled: false,
        reason: "no-change",
        requestID: op.requestID,
        sessionID,
        state: op.state,
        terminal: isTerminal(op),
      }
    }
    await saveOperation(ctx, op)
    return {
      handled: true,
      requestID: op.requestID,
      sessionID,
      state: op.state,
      terminal: isTerminal(op),
      ...(change.attentionKey ? { attentionKey: change.attentionKey } : {}),
    }
  })
}

/**
 * Read-only reconciliation for subscription startup and reconnects: advance
 * every nonterminal operation from its recorded turn boundary. Never creates or
 * resubmits anything. Returns the requestIDs that became terminal during this
 * pass so the caller can deliver outcomes missed while the stream was down.
 */
export async function reconcileOutstanding(ctx: Ctx): Promise<string[]> {
  let operations: OperationRecord[]
  try {
    operations = await listOutstanding(ctx)
  } catch {
    return []
  }
  const terminal: string[] = []
  for (const candidate of operations) {
    await withLock(candidate.requestID, async () => {
      const op = await loadOperation(ctx, candidate.requestID)
      if (!op || isTerminal(op) || op.sessionID == null || op.boundary == null) return
      const before = op.state
      const after = await reconcileOperation(ctx, op)
      if (before !== "completed" && before !== "failed" && isTerminal(after)) {
        terminal.push(after.requestID)
      }
    })
  }
  return terminal
}

function resultDeliveryKey(op: OperationRecord): string {
  return op.completion?.outputId ?? op.terminalEventId ??
    `${op.state}:${op.submittedAt ?? op.createdAt}`
}

function operationAttentionKeys(op: OperationRecord): string[] {
  if (!op.attention) return []
  return [
    ...op.attention.requests.map(permissionAttentionKey),
    ...op.attention.forms.map(formAttentionKey),
  ]
}

/**
 * Reconcile durable push work after each subscription. This scans terminal
 * records as well as live runs so an operation finalized by status/wait tools,
 * or finalized just before a process reload, still gets its one missing push.
 * Active runs also refresh their permission/form queue from the OpenCode
 * service, allowing attention that occurred during a stream outage to be sent.
 */
export async function reconcileDeliveryState(
  ctx: Ctx,
  onlyRequestIDs?: ReadonlySet<string>,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DeliveryReconciliation> {
  let operations: OperationRecord[]
  try {
    operations = await listOutstanding(ctx, undefined, true)
  } catch {
    return { candidates: [], terminalizedRequestIDs: [], transientRequestIDs: [] }
  }

  const candidates = new Map<string, DeliveryReconciliationCandidate>()
  const terminalizedRequestIDs: string[] = []
  const transientRequestIDs = new Set<string>()
  for (const candidate of operations) {
    if (onlyRequestIDs && !onlyRequestIDs.has(candidate.requestID)) continue
    await withLock(candidate.requestID, async () => {
      let op = await loadOperation(ctx, candidate.requestID)
      if (!op) return
      const wantsDelivery = op.notify === true && Boolean(op.codexThreadId)
      const wasTerminal = isTerminal(op)

      if (!wasTerminal && op.sessionID != null) {
        // Queue outcomes are tri-state: unknown preserves stored observations;
        // known-empty clears stale queue items but keeps event-backed requests.
        if (wantsDelivery) {
          try {
            const observed = await probeNeedsInput(
              ctx,
              op.sessionID,
              op.identity.directory ?? op.notifyDirectory ?? undefined,
              probeTimeoutMs,
            )
            if (mergeQueueAttention(op, observed)) await saveOperation(ctx, op)
          } catch {
            // Attention probing is best-effort; keep the last persisted state.
          }
        }
        let transient = false
        op = await reconcileOperation(ctx, op, () => { transient = true }, probeTimeoutMs)
        if (transient) transientRequestIDs.add(op.requestID)
        if (!wasTerminal && isTerminal(op)) terminalizedRequestIDs.push(op.requestID)
      }

      if (!wantsDelivery) return

      const events = op.codexDelivery?.events ?? {}
      const result = isTerminal(op) && op.completion != null &&
        !events[resultDeliveryKey(op)]
      const attention = !isTerminal(op)
        ? operationAttentionKeys(op).filter((key) => isAttentionKey(key) && !events[key])
        : []
      if (result || attention.length > 0) {
        const previous = candidates.get(op.requestID)
        candidates.set(op.requestID, {
          requestID: op.requestID,
          result: result || previous?.result === true,
          attentionKeys: [...new Set([...(previous?.attentionKeys ?? []), ...attention])],
        })
      }
    })
  }
  return {
    candidates: [...candidates.values()],
    terminalizedRequestIDs,
    transientRequestIDs: [...transientRequestIDs],
  }
}

export interface EventStream {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
}

export interface ExecutionMonitorOptions {
  reconnectDelayMs?: number
  maxReconnectDelayMs?: number
  reconcileRetryMs?: number
  // Full bounded operation scan cadence while subscribed; defaults to 15s.
  reconcileIntervalMs?: number
  // Per-operation bound for transcript and attention queue probes.
  operationTimeoutMs?: number
  onError?: (error: unknown) => void
  onSubscribed?: (attempt: number) => void
  onUnsubscribed?: (attempt: number) => void
  // Called after each (re)subscription reconciliation with operations that
  // became terminal while the stream was unavailable.
  onReconciled?: (requestIDs: string[], attempt: number) => void
  onDeliveryReconciled?: (candidates: DeliveryReconciliationCandidate[], attempt: number) => void
  onEvent?: (event: unknown, result: EventResult) => void
}

export interface ExecutionMonitor {
  readonly ready: Promise<void>
  readonly available: boolean
  stop(): void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * Subscribe before any consumer can start an operation, reconcile on every
 * (re)subscription, and consume events sequentially so one event is persisted
 * before the next is observed. A broken stream reconnects with bounded backoff.
 */
export function startExecutionMonitor(
  ctx: Ctx,
  options: ExecutionMonitorOptions = {},
): ExecutionMonitor {
  const source = ctx.event as EventStream | undefined
  const controller = new AbortController()
  let stopped = false
  let subscribed = false
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  let readySettled = false
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (readySettled) return
      readySettled = true
      resolve()
    }
    rejectReady = (error) => {
      if (readySettled) return
      readySettled = true
      reject(error)
    }
  })
  // Plugin startup must not surface an unhandled rejection when the host has no
  // event stream; callers may still observe `ready` explicitly.
  ready.catch(() => {})

  if (!source || typeof source.subscribe !== "function") {
    resolveReady()
    return {
      ready,
      available: false,
      stop() {
        stopped = true
        controller.abort()
      },
    }
  }

  const reconnectDelay = Math.max(0, options.reconnectDelayMs ?? 250)
  const maxDelay = Math.max(reconnectDelay, options.maxReconnectDelayMs ?? 30_000)
  const reconcileRetryDelay = Math.max(10, options.reconcileRetryMs ?? 1_000)
  const reconcileInterval = Math.max(10, options.reconcileIntervalMs ?? 15_000)
  const operationTimeout = Math.max(10, options.operationTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
  const pendingTransient = new Set<string>()
  let retryTask = false
  let reconciliationQueue = Promise.resolve()
  let subscriptionAttempt = 0

  // Startup, retry, reconnect, and periodic scans share one serialized lane.
  // The transcript scan is bounded, and a slow scan cannot overlap another one.
  const reconcile = (requestIDs?: ReadonlySet<string>) => {
    const task = reconciliationQueue.then(() => stopped
      ? { candidates: [], terminalizedRequestIDs: [], transientRequestIDs: [] }
      : reconcileDeliveryState(ctx, requestIDs, operationTimeout))
    reconciliationQueue = task.then(() => {}, () => {})
    return task
  }

  const reportReconciliation = (result: DeliveryReconciliation, attempt: number) => {
    if (result.terminalizedRequestIDs.length > 0) {
      try {
        options.onReconciled?.(result.terminalizedRequestIDs, attempt)
      } catch (error) {
        options.onError?.(error)
      }
    }
    if (result.candidates.length > 0) {
      try {
        options.onDeliveryReconciled?.(result.candidates, attempt)
      } catch (error) {
        options.onError?.(error)
      }
    }
    for (const requestID of result.transientRequestIDs) pendingTransient.add(requestID)
  }

  const retryTransient = async () => {
    if (retryTask) return
    retryTask = true
    let delay = reconcileRetryDelay
    try {
      while (!stopped && pendingTransient.size > 0) {
        await sleep(delay, controller.signal)
        if (stopped) break
        const requestIDs = new Set(pendingTransient)
        pendingTransient.clear()
        try {
          const result = await reconcile(requestIDs)
          reportReconciliation(result, 0)
          delay = reconcileRetryDelay
        } catch (error) {
          options.onError?.(error)
          for (const requestID of requestIDs) pendingTransient.add(requestID)
          delay = Math.min(maxDelay, Math.max(reconcileRetryDelay, delay * 2))
        }
      }
    } finally {
      retryTask = false
      if (!stopped && pendingTransient.size > 0) void retryTransient()
    }
  }

  const periodicReconcile = async () => {
    while (!stopped) {
      await sleep(reconcileInterval, controller.signal)
      if (stopped) return
      if (!subscribed) continue
      try {
        const result = await reconcile()
        reportReconciliation(result, subscriptionAttempt)
        if (pendingTransient.size > 0) void retryTransient()
      } catch (error) {
        options.onError?.(error)
      }
    }
  }
  void periodicReconcile()

  async function run(): Promise<void> {
    let attempt = 0
    let delay = reconnectDelay
    let hasSubscribed = false
    while (!stopped) {
      let iterator: AsyncIterator<unknown> | undefined
      try {
        const stream = source!.subscribe({ signal: controller.signal })
        if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
          throw new Error("event source did not return an async iterable")
        }
        attempt += 1
        subscriptionAttempt = attempt
        try {
          const reconciled = await reconcile()
          reportReconciliation(reconciled, attempt)
          if (pendingTransient.size > 0) void retryTransient()
        } catch (error) {
          options.onError?.(error)
        }
        iterator = stream[Symbol.asyncIterator]()
        let next = iterator.next()
        subscribed = true
        if (!hasSubscribed) {
          hasSubscribed = true
          resolveReady()
        }
        options.onSubscribed?.(attempt)
        delay = reconnectDelay
        while (!stopped) {
          const item = await next
          if (item.done) break
          if (stopped) break
          try {
            const result = await recordExecutionEvent(ctx, item.value)
            options.onEvent?.(item.value, result)
          } catch (error) {
            options.onError?.(error)
          }
          next = iterator.next()
        }
      } catch (error) {
        if (stopped) break
        const wasSubscribed = subscribed
        subscribed = false
        if (wasSubscribed) options.onUnsubscribed?.(attempt)
        if (!hasSubscribed) {
          rejectReady(error)
          options.onError?.(error)
        } else {
          options.onError?.(error)
        }
      } finally {
        const wasSubscribed = subscribed
        subscribed = false
        if (wasSubscribed) options.onUnsubscribed?.(attempt)
        if (stopped) {
          try { void iterator?.return?.() } catch {}
        }
      }
      if (stopped) break
      await sleep(delay, controller.signal)
      delay = Math.min(maxDelay, Math.max(reconnectDelay, delay * 2))
    }
    resolveReady()
  }

  void run().catch((error) => {
    options.onError?.(error)
    rejectReady(error)
  })

  return {
    ready,
    get available() {
      return subscribed && !stopped
    },
    stop() {
      stopped = true
      controller.abort()
    },
  }
}

export const EXECUTION_EVENT_LOG = LOG
