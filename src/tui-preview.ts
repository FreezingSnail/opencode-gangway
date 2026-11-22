import type { SessionMessageInfo } from "@opencode/client"
import { formatAge } from "./tui-helpers"

// Pure projections for the gangway session peek. Everything here is
// side-effect free so the TUI can render live store data without owning any
// message state, and so the tricky cases (tool state, turn boundaries,
// terminal text) stay testable outside Solid.

export type ToolStatus = "streaming" | "running" | "completed" | "error"

export type TimestampSource = "completed" | "ran" | "created" | "started" | "message" | "none"

export interface ObservedAction {
  readonly kind: "tool" | "shell"
  readonly name: string
  readonly status: ToolStatus
  readonly timestamp?: number
  readonly timestampSource: TimestampSource
  readonly messageIndex: number
  readonly partIndex: number
}

export interface AssistantExcerpt {
  readonly text: string
  readonly earlier: boolean
  readonly timestamp: number
  readonly truncated: boolean
}

export interface ExcerptOptions {
  readonly maxChars?: number
  readonly maxLines?: number
}

const ACTIVE_TOOL_STATUSES: readonly ToolStatus[] = ["streaming", "running"]
const DEFAULT_MAX_CHARS = 600
const DEFAULT_MAX_LINES = 10

function firstTimestamp(
  candidates: ReadonlyArray<readonly [number | undefined, Exclude<TimestampSource, "none">]>,
): { timestamp?: number; timestampSource: TimestampSource } {
  for (const [value, source] of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return { timestamp: value, timestampSource: source }
  }
  return { timestampSource: "none" }
}

function messageCreated(message: SessionMessageInfo): number | undefined {
  const time = (message as { time?: { created?: unknown } }).time
  return typeof time?.created === "number" ? time.created : undefined
}

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>

function isAssistant(message: SessionMessageInfo): message is AssistantMessage {
  return message.type === "assistant"
}

function observedTools(messages: readonly SessionMessageInfo[]): ObservedAction[] {
  const result: ObservedAction[] = []
  messages.forEach((message, messageIndex) => {
    if (!isAssistant(message)) return
    message.content.forEach((part, partIndex) => {
      if (part.type !== "tool") return
      const time = part.time ?? {}
      const state = part.state
      const fallback = messageCreated(message)
      const picked =
        state.status === "completed"
          ? firstTimestamp([
              [time.completed, "completed"],
              [time.ran, "ran"],
              [time.created, "created"],
              [fallback, "message"],
            ])
          : state.status === "error"
            ? firstTimestamp([
                [part.state.error?.time?.created, "message"],
                [time.ran, "ran"],
                [time.created, "created"],
                [fallback, "message"],
              ])
            : state.status === "running"
              ? firstTimestamp([
                  [time.ran, "ran"],
                  [time.created, "created"],
                  [fallback, "message"],
                ])
              : firstTimestamp([
                  [time.created, "created"],
                  [fallback, "message"],
                ])
      result.push({
        kind: "tool",
        name: part.name,
        status: state.status,
        ...picked,
        messageIndex,
        partIndex,
      })
    })
  })
  return result
}

function observedShells(messages: readonly SessionMessageInfo[]): ObservedAction[] {
  const result: ObservedAction[] = []
  messages.forEach((message, messageIndex) => {
    if (message.type !== "shell") return
    const status: ToolStatus =
      message.status === "running" ? "running" : message.status === "exited" ? "completed" : "error"
    const picked = firstTimestamp([
      [message.time.completed, "completed"],
      [message.time.created, "created"],
    ])
    result.push({
      kind: "shell",
      name: message.command,
      status,
      ...picked,
      messageIndex,
      partIndex: 0,
    })
  })
  return result
}

/** Every tool part in transcript order, with a concrete timestamp fallback chain. */
export function observedActions(messages: readonly SessionMessageInfo[]): ObservedAction[] {
  return [...observedTools(messages), ...observedShells(messages)].sort(
    (a, b) => a.messageIndex - b.messageIndex || a.partIndex - b.partIndex,
  )
}

/** The newest observed tool/shell action, regardless of whether it is still active. */
export function latestAction(messages: readonly SessionMessageInfo[]): ObservedAction | undefined {
  return observedActions(messages).at(-1)
}

function lastUserIndex(messages: readonly SessionMessageInfo[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.type === "user") return index
  }
  return -1
}

/**
 * The running/streaming tool that belongs to the current work. A newer user
 * prompt starts a new turn, so a stale streaming tool from an earlier turn is
 * never reported as the active one. Idle sessions never have an active tool.
 */
export function activeTool(messages: readonly SessionMessageInfo[], running: boolean): ObservedAction | undefined {
  if (!running) return undefined
  const turnStart = lastUserIndex(messages) + 1
  return observedActions(messages)
    .filter(
      (action) =>
        action.kind === "tool" && action.messageIndex >= turnStart && ACTIVE_TOOL_STATUSES.includes(action.status),
    )
    .at(-1)
}

function clipLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return { text, truncated: false }
  return { text: lines.slice(-maxLines).join("\n"), truncated: true }
}

/**
 * Plain, terminal-safe text. Strips ANSI/OSC escapes and control characters
 * (newlines survive), and expands tabs. Markdown is left alone; the caller
 * renders this with the TUI text component, not as terminal input.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "")
    .replace(/\t/g, "  ")
}

/**
 * Bound an excerpt by characters and lines, keeping the newest tail so the
 * preview shows where the run currently stands. A leading ellipsis marks a
 * clipped head. The result never exceeds maxChars (for a sane maxChars).
 */
export function clipExcerpt(
  text: string,
  options: ExcerptOptions = {},
): { text: string; truncated: boolean } {
  const maxChars = Math.max(2, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS))
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES))
  const clean = sanitizeTerminalText(text).replace(/\n+$/, "").trim()
  if (!clean) return { text: "", truncated: false }
  const byLines = clipLines(clean, maxLines)
  if (byLines.text.length <= maxChars) {
    return { text: byLines.truncated ? `…${byLines.text}` : byLines.text, truncated: byLines.truncated }
  }
  return { text: `…${byLines.text.slice(-(maxChars - 1))}`, truncated: true }
}

/**
 * Latest assistant text, bounded for the peek. `earlier` is true when a newer
 * user prompt follows the assistant message, so the UI can label the excerpt
 * as earlier output instead of current output.
 */
export function assistantExcerpt(
  messages: readonly SessionMessageInfo[],
  options: ExcerptOptions = {},
): AssistantExcerpt | undefined {
  const promptIndex = lastUserIndex(messages)
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!
    if (!isAssistant(message)) continue
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex]!
      if (part.type !== "text" || !part.text.trim()) continue
      const clipped = clipExcerpt(part.text, options)
      if (!clipped.text) continue
      const time = message.time
      const timestamp = time.completed ?? time.streamed ?? time.created
      return {
        text: clipped.text,
        earlier: promptIndex > messageIndex,
        timestamp,
        truncated: clipped.truncated,
      }
    }
  }
  return undefined
}

/**
 * Newest activity timestamp across the session metadata and its messages.
 * Session `updated` is the fallback when no message carries a usable time.
 */
export function latestActivityAt(messages: readonly SessionMessageInfo[], fallback = 0): number {
  let latest = Number.isFinite(fallback) ? fallback : 0
  const observe = (value: number | undefined) => {
    if (typeof value === "number" && Number.isFinite(value) && value > latest) latest = value
  }
  for (const message of messages) {
    const time = (message as { time?: { created?: number; completed?: number; streamed?: number } }).time
    observe(time?.created)
    observe(time?.streamed)
    observe(time?.completed)
    if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type !== "tool") continue
        observe(part.time?.created)
        observe(part.time?.ran)
        observe(part.time?.completed)
        if (part.state.status === "error") observe(part.state.error?.time?.created)
      }
    }
  }
  return latest
}

/** Short relative age for the peek; an absent timestamp reads as unknown. */
export function activityAge(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return "unknown"
  const age = formatAge(timestamp, now)
  return age === "now" ? "just now" : `${age} ago`
}
