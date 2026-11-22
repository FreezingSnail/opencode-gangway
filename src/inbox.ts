import type { FormInfo, PermissionRequest, SessionInfo } from "@opencode/client"
import { formatAge, hasGangwayMarker, truncateHead } from "./tui-helpers"
import { activityAge, sanitizeTerminalText } from "./tui-preview"

// Cross-directory needs-input inbox model. This file is deliberately free of
// Solid and TUI host imports: the view layer only renders these rows, and the
// queue/timestamp reconciliation stays testable outside a running TUI.

export const INBOX_SUMMARY_LIMIT = 160
export const INBOX_DETAIL_LIMIT = 220
export const INBOX_TITLE_LIMIT = 90
export const INBOX_SESSION_LIMIT = 500
export const INBOX_REFRESH_MS = 5000

export type InboxKind = "permission" | "question"
export type InboxSource = "permission" | "form" | "permission+form"
export type InboxAgeSource = "server" | "first-seen"

export interface InboxPermission {
  readonly id?: string | null
  readonly action?: string | null
  readonly resources?: readonly unknown[] | null
  readonly message?: string | null
  readonly metadata?: Readonly<Record<string, unknown>> | null
  readonly source?: { readonly type?: string; readonly messageID?: string; readonly id?: string } | null
}

export interface InboxFormField {
  readonly key?: string | null
  readonly type?: string | null
  readonly title?: string | null
  readonly description?: string | null
  readonly placeholder?: string | null
  readonly hidden?: boolean | null
}

export interface InboxForm {
  readonly id?: string | null
  readonly title?: string | null
  readonly fields?: readonly InboxFormField[] | null
  readonly metadata?: Readonly<Record<string, unknown>> | null
}

export interface InboxSession {
  readonly id: string
  readonly title?: string | null
  readonly parentID?: string | null
  readonly metadata?: Readonly<Record<string, unknown>> | null
  readonly location: { readonly directory: string }
}

export interface InboxSessionQueues {
  readonly session: InboxSession
  /** `undefined` means the queue has not been synced yet. */
  readonly permissions?: readonly InboxPermission[] | undefined
  /** `undefined` means the queue has not been synced yet. */
  readonly forms?: readonly InboxForm[] | undefined
}

export interface InboxSources {
  readonly sessions: readonly InboxSessionQueues[]
}

export interface InboxQueueFailures {
  readonly permission?: ReadonlySet<string>
  readonly form?: ReadonlySet<string>
}

export interface InboxRow {
  /** Stable identity: request/form namespace plus owner session and request id. */
  readonly key: string
  readonly kind: InboxKind
  readonly source: InboxSource
  readonly sessionID: string
  readonly sessionTitle: string
  readonly directory: string
  readonly summary: string
  readonly detail?: string
  readonly action?: string
  readonly requestID?: string
  readonly formID?: string
  /** Server event creation time, when an event carried one. */
  readonly createdAt?: number
  /** First time this inbox observed the request. Always present. */
  readonly firstSeenAt: number
  readonly ageSource: InboxAgeSource
  /** Sort key: a real event time when known, otherwise the first-seen time. */
  readonly sortTime: number
}

export interface InboxVisibility {
  readonly complete: boolean
  readonly permissionUnsynced: readonly string[]
  readonly formUnsynced: readonly string[]
  readonly permissionFailed: readonly string[]
  readonly formFailed: readonly string[]
}

export interface InboxBuildResult {
  readonly rows: readonly InboxRow[]
  readonly visibility: InboxVisibility
  readonly note?: string
  readonly emptyMessage?: string
  /** Merged first-seen observations; feed these back into later builds. */
  readonly firstSeen: ReadonlyMap<string, number>
}

export interface InboxSelection {
  readonly index: number
  readonly key?: string
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" ? (value as Readonly<Record<string, unknown>>) : undefined
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function clean(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim()
}

function safe(value: unknown, fallback: string, limit: number): string {
  const flattened = typeof value === "string" ? clean(value) : ""
  return flattened ? truncateHead(flattened, limit) : fallback
}

function resourceList(resources: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(resources)) return []
  return resources.flatMap((resource) => {
    const value = typeof resource === "string" ? clean(resource) : ""
    return value ? [value] : []
  })
}

export function permissionKey(sessionID: string, permission: InboxPermission, index = 0): string {
  const id = text(permission.id) || `index-${index}`
  return `permission:${sessionID}:${id}`
}

export function formKey(sessionID: string, form: InboxForm, index = 0): string {
  const id = text(form.id) || `index-${index}`
  return `form:${sessionID}:${id}`
}

/**
 * A permission and a form are duplicates only when they carry an explicit shared
 * identity. Matching prompt text is not enough: two independent questions may
 * legitimately ask the same thing.
 */
function permissionLinksForm(permission: InboxPermission, form: InboxForm): boolean {
  if (permission.action !== "question") return false
  const permissionID = text(permission.id)
  const formID = text(form.id)
  if (permissionID && formID && permissionID === formID) return true

  const permissionMeta = record(permission.metadata)
  const formMeta = record(form.metadata)
  if (
    permissionID &&
    (text(formMeta?.permissionID) === permissionID ||
      text(formMeta?.permissionId) === permissionID ||
      text(formMeta?.requestID) === permissionID)
  ) {
    return true
  }
  if (formID && (text(permissionMeta?.formID) === formID || text(permissionMeta?.formId) === formID)) {
    return true
  }
  return Boolean(formID && text(permission.source?.id) === formID)
}

function permissionParts(permission: InboxPermission): {
  kind: InboxKind
  action: string
  summary: string
  detail?: string
} {
  const action = safe(permission.action, "permission", 40)
  const message = text(permission.message)
  const resources = resourceList(permission.resources)
  const resourceText = resources.length > 0 ? `resources: ${resources.join(", ")}` : ""

  if (permission.action === "question") {
    const summary = message
      ? safe(message, "Question", INBOX_SUMMARY_LIMIT)
      : resources.length > 0
        ? safe(`Question · ${resources.join(", ")}`, "Question", INBOX_SUMMARY_LIMIT)
        : "Question"
    const detail = resourceText ? truncateHead(clean(resourceText), INBOX_DETAIL_LIMIT) : undefined
    return { kind: "question", action, summary, detail }
  }

  const summary = message
    ? safe(`${action} · ${message}`, `${action} request`, INBOX_SUMMARY_LIMIT)
    : `${action} request`
  const detail = resourceText ? truncateHead(clean(resourceText), INBOX_DETAIL_LIMIT) : undefined
  return { kind: "permission", action, summary, detail }
}

function fieldPrompt(field: InboxFormField): string {
  if (field.hidden === true) return ""
  const title = text(field.title)
  const description = text(field.description)
  const placeholder = text(field.placeholder)
  const key = text(field.key)
  const primary = title || description || placeholder || key
  if (!primary) return ""
  if (title && description && title !== description) return `${title} — ${description}`
  return primary
}

function formParts(form: InboxForm): { summary: string; detail?: string } {
  const summary = safe(form.title, "Question", INBOX_SUMMARY_LIMIT)
  // Only prompt text is read. Answers, defaults and metadata are never exposed.
  const prompts = (Array.isArray(form.fields) ? form.fields : [])
    .flatMap((field) => {
      const prompt = fieldPrompt(field)
      return prompt ? [truncateHead(clean(prompt), 80)] : []
    })
    .slice(0, 3)
  const detail = prompts.length > 0 ? truncateHead(prompts.join(" · "), INBOX_DETAIL_LIMIT) : undefined
  return { summary, detail: detail || undefined }
}

function uniqueParts(parts: ReadonlyArray<string | undefined>): string | undefined {
  const seen = new Set<string>()
  const values: string[] = []
  for (const part of parts) {
    const value = part ? clean(part) : ""
    if (!value || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values.length > 0 ? truncateHead(values.join(" · "), INBOX_DETAIL_LIMIT) : undefined
}

function rowTimes(
  keys: readonly string[],
  events: ReadonlyMap<string, number>,
  firstSeen: ReadonlyMap<string, number>,
  now: number,
): { createdAt?: number; firstSeenAt: number; ageSource: InboxAgeSource; sortTime: number; updates: Map<string, number> } {
  const eventTimes = keys.flatMap((key) => {
    const value = finite(events.get(key))
    return value === undefined ? [] : [value]
  })
  const seenTimes = keys.flatMap((key) => {
    const value = finite(firstSeen.get(key))
    return value === undefined ? [] : [value]
  })
  const createdAt = eventTimes.length > 0 ? Math.min(...eventTimes) : undefined
  const firstSeenAt = seenTimes.length > 0 ? Math.min(...seenTimes) : now
  const ageSource: InboxAgeSource = createdAt === undefined ? "first-seen" : "server"
  const updates = new Map<string, number>()
  for (const key of keys) updates.set(key, firstSeenAt)
  return {
    createdAt,
    firstSeenAt,
    ageSource,
    sortTime: createdAt ?? firstSeenAt,
    updates,
  }
}

function compareRows(a: InboxRow, b: InboxRow): number {
  const group = (row: InboxRow) => (row.ageSource === "server" ? 0 : 1)
  const byGroup = group(a) - group(b)
  if (byGroup !== 0) return byGroup
  const byTime = a.sortTime - b.sortTime
  if (byTime !== 0) return byTime
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function sessionTitle(session: InboxSession): string {
  return safe(session.title, "(untitled)", INBOX_TITLE_LIMIT)
}

export function inboxVisibility(sources: InboxSources, failures: InboxQueueFailures = {}): InboxVisibility {
  const permissionUnsynced: string[] = []
  const formUnsynced: string[] = []
  for (const queues of sources.sessions) {
    if (queues.permissions === undefined) permissionUnsynced.push(queues.session.id)
    if (queues.forms === undefined) formUnsynced.push(queues.session.id)
  }
  const permissionFailed = [...(failures.permission ?? [])].sort()
  const formFailed = [...(failures.form ?? [])].sort()
  return {
    complete:
      permissionUnsynced.length === 0 &&
      formUnsynced.length === 0 &&
      permissionFailed.length === 0 &&
      formFailed.length === 0,
    permissionUnsynced: permissionUnsynced.sort(),
    formUnsynced: formUnsynced.sort(),
    permissionFailed,
    formFailed,
  }
}

/** A short, honest explanation of which queues are not represented yet. */
export function visibilityNote(visibility: InboxVisibility): string | undefined {
  if (visibility.complete) return undefined
  const parts: string[] = []
  if (visibility.permissionUnsynced.length > 0) {
    parts.push(`${visibility.permissionUnsynced.length} permission queue(s) not synced yet`)
  }
  if (visibility.formUnsynced.length > 0) {
    parts.push(`${visibility.formUnsynced.length} form queue(s) not synced yet`)
  }
  if (visibility.permissionFailed.length > 0) {
    parts.push(`${visibility.permissionFailed.length} permission queue(s) failed to sync`)
  }
  if (visibility.formFailed.length > 0) {
    parts.push(`${visibility.formFailed.length} form queue(s) failed to sync`)
  }
  return parts.length > 0 ? `Visibility incomplete — ${parts.join("; ")}.` : undefined
}

export function emptyInboxMessage(sources: InboxSources, visibility: InboxVisibility): string {
  if (sources.sessions.length === 0) return "No Gangway sessions found across known directories."
  if (!visibility.complete) return "No pending approvals or questions are visible yet. Visibility is incomplete."
  return "No pending approvals or questions."
}

/**
 * Build the inbox projection from live queues.
 *
 * `events` maps request keys to the server's event creation time; `firstSeen`
 * carries observations from earlier builds. A row without an event time is
 * labelled as first-seen instead of borrowing an age it cannot prove.
 */
export function buildInbox(
  sources: InboxSources,
  now: number,
  events: ReadonlyMap<string, number> = new Map(),
  priorFirstSeen: ReadonlyMap<string, number> = new Map(),
  failures: InboxQueueFailures = {},
): InboxBuildResult {
  const firstSeen = new Map(priorFirstSeen)
  const rows: InboxRow[] = []

  for (const queues of sources.sessions) {
    const session = queues.session
    const permissions = queues.permissions
    const forms = queues.forms

    const usedForms = new Set<number>()
    const permissionRows: InboxRow[] = []

    ;(permissions ?? []).forEach((permission, index) => {
      const permissionKeyValue = permissionKey(session.id, permission, index)
      const linkedIndex =
        permission.action === "question"
          ? (forms ?? []).findIndex(
              (form, formIndex) => !usedForms.has(formIndex) && permissionLinksForm(permission, form),
            )
          : -1
      const linked = linkedIndex >= 0 ? (forms ?? [])[linkedIndex] : undefined
      if (linkedIndex >= 0) usedForms.add(linkedIndex)

      const parts = permissionParts(permission)
      const linkedParts = linked ? formParts(linked) : undefined
      const linkedKey = linked ? formKey(session.id, linked, linkedIndex) : undefined

      const keys = linkedKey ? [permissionKeyValue, linkedKey] : [permissionKeyValue]
      // Keep the permission key as canonical when a form is a representation of
      // the same prompt; it is the request the native TUI answers.
      const timing = rowTimes(keys, events, firstSeen, now)
      for (const [key, value] of timing.updates) firstSeen.set(key, value)

      permissionRows.push({
        key: permissionKeyValue,
        kind: parts.kind,
        source: linked ? "permission+form" : "permission",
        sessionID: session.id,
        sessionTitle: sessionTitle(session),
        directory: session.location.directory,
        summary: linkedParts
          ? truncateHead(clean(parts.summary === "Question" ? linkedParts.summary : parts.summary), INBOX_SUMMARY_LIMIT)
          : parts.summary,
        detail: uniqueParts([parts.detail, linkedParts?.detail]),
        action: parts.action,
        requestID: text(permission.id) || undefined,
        formID: linked ? text(linked.id) || undefined : undefined,
        createdAt: timing.createdAt,
        firstSeenAt: timing.firstSeenAt,
        ageSource: timing.ageSource,
        sortTime: timing.sortTime,
      })
    })

    rows.push(...permissionRows)

    ;(forms ?? []).forEach((form, index) => {
      if (usedForms.has(index)) return
      const key = formKey(session.id, form, index)
      const parts = formParts(form)
      const timing = rowTimes([key], events, firstSeen, now)
      for (const [seenKey, value] of timing.updates) firstSeen.set(seenKey, value)
      rows.push({
        key,
        kind: "question",
        source: "form",
        sessionID: session.id,
        sessionTitle: sessionTitle(session),
        directory: session.location.directory,
        summary: parts.summary,
        detail: parts.detail,
        formID: text(form.id) || undefined,
        createdAt: timing.createdAt,
        firstSeenAt: timing.firstSeenAt,
        ageSource: timing.ageSource,
        sortTime: timing.sortTime,
      })
    })
  }

  rows.sort(compareRows)
  const visibility = inboxVisibility(sources, failures)
  const note = visibilityNote(visibility)
  return {
    rows,
    visibility,
    note,
    emptyMessage: rows.length === 0 ? emptyInboxMessage(sources, visibility) : undefined,
    firstSeen,
  }
}

/** Human age label; first-seen rows never pretend to know a real wait. */
export function inboxAgeLabel(row: InboxRow, now: number): string {
  if (row.ageSource === "server" && row.createdAt !== undefined) {
    const age = formatAge(row.createdAt, now)
    return age === "now" ? "waiting just now" : `waiting ${age}`
  }
  return `first seen ${activityAge(row.firstSeenAt, now)}`
}

/**
 * Keep the same request selected across row churn. When the selected request
 * disappears, fall back to the same visible index, clamped to the new list.
 */
export function resolveInboxSelection(
  rows: readonly InboxRow[],
  selectedKey: string | undefined,
  fallbackIndex: number,
): InboxSelection {
  if (rows.length === 0) return { index: 0, key: undefined }
  if (selectedKey) {
    const found = rows.findIndex((row) => row.key === selectedKey)
    if (found >= 0) return { index: found, key: rows[found]!.key }
  }
  const raw = Number.isFinite(fallbackIndex) ? Math.floor(fallbackIndex) : 0
  const index = Math.max(0, Math.min(rows.length - 1, raw))
  return { index, key: rows[index]!.key }
}

export interface InboxServerEvent {
  readonly type: string
  readonly created?: number
  readonly data?: {
    readonly id?: string
    readonly sessionID?: string
    readonly requestID?: string
    readonly form?: { readonly id?: string; readonly sessionID?: string }
  }
}

export function eventRequestKey(event: InboxServerEvent): string | undefined {
  if (event.type === "permission.asked") {
    const sessionID = text(event.data?.sessionID)
    if (!sessionID) return undefined
    return `permission:${sessionID}:${text(event.data?.id) || "index-0"}`
  }
  if (event.type === "form.created") {
    const sessionID = text(event.data?.form?.sessionID)
    if (!sessionID) return undefined
    return `form:${sessionID}:${text(event.data?.form?.id) || "index-0"}`
  }
  return undefined
}

export interface InboxDataStore {
  session: {
    list(): readonly InboxSession[]
    get(sessionID: string): InboxSession | undefined
    remember?(info: InboxSession): void
    permission: {
      list(sessionID: string): readonly InboxPermission[] | undefined
      sync(sessionID: string): Promise<void>
    }
    form: {
      list(sessionID: string, location?: InboxSession["location"]): readonly InboxForm[] | undefined
      sync(sessionID: string, location?: InboxSession["location"]): Promise<void>
    }
  }
}

export interface InboxHydrationContext {
  readonly client: {
    session: {
      list(input: { parentID: null; limit: number; order: "desc" }): Promise<{ data: readonly InboxSession[] }>
    }
  }
  readonly data: InboxDataStore
}

function isInboxSession(session: InboxSession): boolean {
  return !session.parentID && hasGangwayMarker({ metadata: session.metadata as Record<string, unknown> | null, title: session.title })
}

/** Live row sources from the shared data store, keeping the same marker rules. */
export function inboxSources(data: InboxDataStore): InboxSources {
  return {
    sessions: data.session
      .list()
      .filter(isInboxSession)
      .map((session) => ({
        session,
        permissions: data.session.permission.list(session.id),
        forms: data.session.form.list(session.id, session.location),
      })),
  }
}

const syncs = new Map<string, Promise<void>>()

/**
 * Sync only unresolved permission/form queues. Defined (including empty) lists
 * are never refetched, and concurrent syncs share one in-flight promise.
 */
export async function syncInboxQueues(
  data: InboxDataStore,
  sessions: readonly InboxSession[],
  tracker?: InboxTracker,
): Promise<void> {
  const pending: Promise<void>[] = []

  for (const session of sessions) {
    if (!isInboxSession(session)) continue

    if (data.session.permission.list(session.id) === undefined) {
      const key = `permission:${session.id}`
      let task = syncs.get(key)
      if (!task) {
        task = data.session.permission
          .sync(session.id)
          .then(() => tracker?.clearSyncFailure(session.id, "permission"))
          .catch(() => tracker?.markSyncFailure(session.id, "permission"))
          .finally(() => syncs.delete(key))
        syncs.set(key, task)
      }
      pending.push(task)
    }

    if (data.session.form.list(session.id, session.location) === undefined) {
      const key = `form:${session.id}:${session.location.directory}`
      let task = syncs.get(key)
      if (!task) {
        task = data.session.form
          .sync(session.id, session.location)
          .then(() => tracker?.clearSyncFailure(session.id, "form"))
          .catch(() => tracker?.markSyncFailure(session.id, "form"))
          .finally(() => syncs.delete(key))
        syncs.set(key, task)
      }
      pending.push(task)
    }
  }

  await Promise.all(pending)
}

/**
 * Hydrate gangway sessions across locations, then sync unresolved queues. Mirrors
 * the sessions panel's list + `remember` fallback so pre-existing waits appear
 * even when no server event was observed.
 */
export async function hydrateInbox(context: InboxHydrationContext, tracker?: InboxTracker): Promise<void> {
  let listed: readonly InboxSession[] = []
  try {
    const response = await context.client.session.list({
      parentID: null,
      limit: INBOX_SESSION_LIMIT,
      order: "desc",
    })
    listed = response.data
    for (const info of response.data) {
      if (!isInboxSession(info)) continue
      if (!context.data.session.get(info.id) && context.data.session.remember) context.data.session.remember(info)
    }
  } catch {
    // Transient transport failure: live store events still update the inbox.
  }

  const unique = new Map<string, InboxSession>()
  for (const session of [...listed, ...context.data.session.list()]) {
    if (!isInboxSession(session)) continue
    unique.set(session.id, session)
  }
  await syncInboxQueues(context.data, [...unique.values()], tracker)
}

/** Mutable event/first-seen/sync-failure state shared by the inbox view. */
export class InboxTracker {
  private readonly events = new Map<string, number>()
  private firstSeen = new Map<string, number>()
  private readonly permissionFailures = new Set<string>()
  private readonly formFailures = new Set<string>()

  noteEvent(event: InboxServerEvent): void {
    // An event carries the row itself, so any earlier sync failure for that
    // queue is no longer a visibility gap.
    if (event.type === "permission.asked" && event.data?.sessionID) {
      this.permissionFailures.delete(event.data.sessionID)
    }
    if (event.type === "form.created" && event.data?.form?.sessionID) {
      this.formFailures.delete(event.data.form.sessionID)
    }

    const created = finite(event.created)
    const key = eventRequestKey(event)
    if (!key || created === undefined) return
    this.events.set(key, created)
  }

  markSyncFailure(sessionID: string, queue: "permission" | "form"): void {
    if (queue === "permission") this.permissionFailures.add(sessionID)
    else this.formFailures.add(sessionID)
  }

  clearSyncFailure(sessionID: string, queue: "permission" | "form"): void {
    if (queue === "permission") this.permissionFailures.delete(sessionID)
    else this.formFailures.delete(sessionID)
  }

  failures(): InboxQueueFailures {
    return {
      permission: new Set(this.permissionFailures),
      form: new Set(this.formFailures),
    }
  }

  build(sources: InboxSources, now: number): InboxBuildResult {
    const result = buildInbox(sources, now, this.events, this.firstSeen, this.failures())
    this.firstSeen = new Map(result.firstSeen)
    return result
  }
}

export type { FormInfo, PermissionRequest, SessionInfo }
