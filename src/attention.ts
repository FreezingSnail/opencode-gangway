import { realpathSync } from "node:fs"
import { serviceFetch, type ServiceConfig } from "./service"
import type { Ctx } from "./tools"

// A bridge session is "waiting on input" when its own permission queue or its
// question-form queue is non-empty. Classification is best-effort: a probe that
// cannot answer yields `null` (unknown), never an empty claim.

export interface PermissionRequestInfo {
  id: string | null
  action: string | null
  resources: unknown
  message: string | null
}

export interface FormInfo {
  id: string | null
  title: string | null
}

export interface NeedsInput {
  kind: "permission" | "question"
  requests: PermissionRequestInfo[]
  forms: FormInfo[]
}

interface ProbeSource {
  permission: unknown[] | null
  form: unknown[] | null
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
  return {
    id: typeof item?.id === "string" ? item.id : null,
    action: typeof item?.action === "string" ? item.action : null,
    resources: item?.resources ?? null,
    message: typeof item?.message === "string" ? item.message : null,
  }
}

function formInfo(entry: unknown): FormInfo {
  const item = entry as Record<string, unknown> | null | undefined
  return {
    id: typeof item?.id === "string" ? item.id : null,
    title: typeof item?.title === "string" ? item.title : null,
  }
}

function classify(source: ProbeSource): NeedsInput | null {
  if (source.permission === null && source.form === null) return null
  const requests = (source.permission ?? []).map(permissionInfo)
  const forms = (source.form ?? []).map(formInfo)
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
): Promise<NeedsInput | null> {
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
    probePermission(ctx, sessionID, target, local),
    probeForm(ctx, sessionID, target, local),
  ])
  return classify({ permission, form })
}
