import { realpathSync } from "node:fs"
import { serviceFetch, type ServiceConfig } from "./service"
import type { Ctx } from "./tools"

// A bridge session is "waiting on input" when its own permission queue or its
// question-form queue is non-empty. Classification is best-effort: a probe that
// cannot answer yields `null` (unknown), never an empty claim.

export interface PermissionRequestInfo {
  id: string | null
  /** Internal event/queue identity used when OpenCode omits the permission id. */
  sourceEventID?: string | null
  /** Event identities already merged into a queue-first observation. */
  sourceEventIDs?: string[]
  action: string | null
  resources: unknown
  message: string | null
}

export interface FormInfo {
  id: string | null
  /** Internal event/queue identity used when OpenCode omits the form id. */
  sourceEventID?: string | null
  /** Event identities already merged into a queue-first observation. */
  sourceEventIDs?: string[]
  title: string | null
}

export interface NeedsInput {
  kind: "permission" | "question"
  requests: PermissionRequestInfo[]
  forms: FormInfo[]
}

export interface NeedsInputProbe {
  /** null means the queue could not be read; [] is a known-empty queue. */
  permission: PermissionRequestInfo[] | null
  /** null means the queue could not be read; [] is a known-empty queue. */
  forms: FormInfo[] | null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out after " + timeoutMs + "ms")), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function canonicalDirectory(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    const trimmed = directory.replace(/\/+$/, "")
    return trimmed || "/"
  }
}

function sameDirectory(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return canonicalDirectory(a) === canonicalDirectory(b)
}

// The plugin's permission/form domains are instance-scoped (one location per
// plugin graph), so they are only trustworthy when the ctx and the session live
// in the same directory. A foreign session must be probed through the service.
function useLocalInstances(ctx: Ctx, directory: string | undefined): boolean {
  const local = ctx.location?.directory
  if (!local) return true // no location means a single implicit instance
  if (!directory) return true
  return sameDirectory(local, directory)
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const data = (value as { data?: unknown } | null | undefined)?.data
  if (Array.isArray(data)) return data
  throw new Error("attention list response is not an array")
}

async function httpList(
  sessionID: string,
  endpoint: "permission" | "form",
  directory: string | undefined,
  config?: ServiceConfig,
): Promise<unknown[]> {
  if (!directory) throw new Error("session directory is unknown")
  const query = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  const response = await serviceFetch(
    `/api/session/${encodeURIComponent(sessionID)}/${endpoint}${query}`,
    { timeoutMs: 4000, ...(config ? { config } : {}) },
  )
  if (!response.ok) throw new Error(`attention request returned HTTP ${response.status}`)
  return listOf(await response.json())
}

async function probePermission(
  ctx: Ctx,
  sessionID: string,
  directory: string | undefined,
  local: boolean,
): Promise<unknown[] | null> {
  try {
    if (local && ctx.permission && typeof ctx.permission.list === "function") {
      return listOf(await ctx.permission.list({ sessionID }))
    }
    return await httpList(sessionID, "permission", directory)
  } catch {
    return null
  }
}

async function probeForm(
  ctx: Ctx,
  sessionID: string,
  directory: string | undefined,
  local: boolean,
): Promise<unknown[] | null> {
  try {
    if (local && ctx.form && typeof ctx.form.list === "function") {
      return listOf(await ctx.form.list({ sessionID }))
    }
    return await httpList(sessionID, "form", directory)
  } catch {
    return null
  }
}

function permissionInfo(entry: unknown): PermissionRequestInfo {
  const item = entry as Record<string, unknown> | null | undefined
  const sourceEventID = queueIdentity(item)
  return {
    id: typeof item?.id === "string" ? item.id : null,
    ...(sourceEventID ? { sourceEventID } : {}),
    action: typeof item?.action === "string" ? item.action : null,
    resources: item?.resources ?? null,
    message: typeof item?.message === "string" ? item.message : null,
  }
}

function formInfo(entry: unknown): FormInfo {
  const item = entry as Record<string, unknown> | null | undefined
  const sourceEventID = queueIdentity(item)
  return {
    id: typeof item?.id === "string" ? item.id : null,
    ...(sourceEventID ? { sourceEventID } : {}),
    title: typeof item?.title === "string" ? item.title : null,
  }
}

// The queue APIs usually provide an upstream id. Some hosts omit it while
// retaining a stable timestamp or sequence on the pending item. Preserve that
// identity so a later same-shape request is not hidden by durable dedupe.
function queueIdentity(item: Record<string, unknown> | null | undefined): string | null {
  if (!item) return null
  const time = item.time && typeof item.time === "object"
    ? item.time as Record<string, unknown>
    : null
  for (const [field, value] of [
    ["sequence", item.sequence],
    ["seq", item.seq],
    ["createdAt", item.createdAt],
    ["created", item.created],
    ["timestamp", item.timestamp],
    ["time.created", time?.created],
    ["time.createdAt", time?.createdAt],
  ] as const) {
    if ((typeof value === "string" && value.length > 0) ||
        (typeof value === "number" && Number.isFinite(value))) {
      return `queue:${field}:${String(value)}`
    }
  }
  return null
}

function classify(source: NeedsInputProbe): NeedsInput | null {
  if (source.permission === null && source.forms === null) return null
  const requests = source.permission ?? []
  const forms = source.forms ?? []
  if (requests.length === 0 && forms.length === 0) return null

  // A pending `question` permission is the same stall as a pending form; both
  // are answerable only in the TUI. Other permission actions need approval.
  const needsApproval = requests.some((request) => request.action !== "question")
  return {
    kind: needsApproval ? "permission" : "question",
    requests,
    forms,
  }
}

/**
 * Detect whether a session is stalled waiting for the user. `directory` is the
 * session's own location when known; it selects between the local plugin
 * instances and the authenticated HTTP queues. Any unreadable probe is treated
 * as unknown (`null`), so the bridge never claims a session needs no input.
 */
export async function detectNeedsInput(
  ctx: Ctx,
  sessionID: string,
  directory?: string | null,
  timeoutMs = 5_000,
): Promise<NeedsInput | null> {
  return classify(await probeNeedsInput(ctx, sessionID, directory, timeoutMs))
}

/**
 * Probe each queue independently. Unknown (null) remains distinct from a
 * known-empty list so reconciliation can preserve event state on probe failure
 * and clear stale queue observations when an empty queue is confirmed.
 */
export async function probeNeedsInput(
  ctx: Ctx,
  sessionID: string,
  directory?: string | null,
  timeoutMs = 5_000,
): Promise<NeedsInputProbe> {
  let target = typeof directory === "string" && directory ? directory : undefined
  if (!target) {
    try {
      const info: any = await ctx.session.get({ sessionID })
      const found = info?.location?.directory
      if (typeof found === "string" && found) target = found
    } catch {
      // Fall back to the local instance directory (if any) below.
    }
  }
  if (!target) target = ctx.location?.directory
  const local = useLocalInstances(ctx, target)

  const [permission, form] = await Promise.all([
    withTimeout(probePermission(ctx, sessionID, target, local), timeoutMs, "permission queue").catch(() => null),
    withTimeout(probeForm(ctx, sessionID, target, local), timeoutMs, "form queue").catch(() => null),
  ])
  return {
    permission: permission?.map(permissionInfo) ?? null,
    forms: form?.map(formInfo) ?? null,
  }
}
