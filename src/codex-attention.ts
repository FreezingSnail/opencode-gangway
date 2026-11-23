// Stable dedupe keys for needs-input push delivery (gangway-34r.5).
//
// A permission/form request gets one key derived from its upstream id, or from
// its stable shape when the host omits an id. Replayed or coalesced events for
// the same request therefore cannot send a second Codex wake.

import type { FormInfo, PermissionRequestInfo } from "./attention"

export const ATTENTION_KEY_PREFIX = "attention:"

function stable(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function permissionAttentionKey(request: PermissionRequestInfo): string {
  const identity = request.sourceEventID?.startsWith("event:")
    ? request.sourceEventID
    : request.id
      ? `id:${request.id}`
      : request.sourceEventID
        ? `event:${request.sourceEventID}`
        : `shape:${stable([request.action, request.message, request.resources ?? null])}`
  return `${ATTENTION_KEY_PREFIX}permission:${identity}`
}

export function formAttentionKey(form: FormInfo): string {
  const identity = form.sourceEventID?.startsWith("event:")
    ? form.sourceEventID
    : form.id
      ? `id:${form.id}`
      : form.sourceEventID
        ? `event:${form.sourceEventID}`
        : `shape:${stable([form.title])}`
  return `${ATTENTION_KEY_PREFIX}form:${identity}`
}

export function isAttentionKey(key: string): boolean {
  return key.startsWith(ATTENTION_KEY_PREFIX)
}
