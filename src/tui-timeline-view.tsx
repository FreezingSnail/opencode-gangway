import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { activityAge, sanitizeTerminalText } from "./tui-preview"
import { classifyNeedsInput, truncateHead } from "./tui-helpers"
import {
  applyTimelineEvent,
  applyTimelineHistory,
  createTimelineState,
  readTimelineHistory,
  setTimelineCoverage,
  timelineNotice,
  timelineOutcome,
  type TimelineEvent,
  type TimelineInputEvent,
  type TimelineState,
  type TimelineTone,
} from "./tui-timeline"

export const TIMELINE_PAGE = "gangway.timeline"
const SESSIONS_PAGE = "gangway.sessions"
const AGE_TICK_MS = 15000
const TIMESTAMP_WIDTH = 12

/** Event types that can carry activity worth showing, live. */
export const TIMELINE_LIVE_EVENTS = [
  "session.inbox.delivered",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
  "session.idle",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const

interface LogSession {
  log?: (input: { sessionID: string; follow?: boolean }, options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
}

function logStream(context: Plugin.Context, sessionID: string, signal: AbortSignal): AsyncIterable<TimelineInputEvent> | undefined {
  const session = context.client.session as unknown as LogSession
  if (typeof session.log !== "function") return undefined
  const stream = session.log({ sessionID, follow: false }, { signal })
  return stream as AsyncIterable<TimelineInputEvent>
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return sanitizeTerminalText(message).replace(/\s+/g, " ").trim().slice(0, 90)
}

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "--:--:--"
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function toneColor(theme: Plugin.Context["theme"], tone: TimelineTone): string {
  switch (tone) {
    case "success":
      return theme.text.feedback.info.base
    case "warning":
      return theme.text.feedback.warning.base
    case "attention":
      return theme.hue.accent[200]
    case "muted":
      return theme.text.muted
    case "info":
      return theme.text.feedback.info.base
    default:
      return theme.text.base
  }
}

function outcomeLabel(
  events: readonly TimelineEvent[],
  status: "idle" | "running",
): { label: string; tone: TimelineTone } {
  const outcome = timelineOutcome(events, status)
  if (outcome === "running") return { label: "running", tone: "info" }
  if (outcome === "finished") return { label: "finished", tone: "success" }
  if (outcome === "failed") return { label: "failed", tone: "warning" }
  if (outcome === "interrupted") return { label: "interrupted", tone: "warning" }
  return { label: "idle", tone: "muted" }
}

export interface TimelinePageProps {
  readonly context: Plugin.Context
  readonly sessionID?: string
  readonly onBack?: () => void
}

/**
 * Standalone activity route for one pinned session. History is read once on
 * open with a hard cap; live events arrive through `context.data.on`. Nothing
 * here polls other sessions or retains message bodies.
 */
export function TimelinePage(props: TimelinePageProps) {
  const context = props.context
  const theme = context.theme
  const sessionID = props.sessionID ?? ""
  const [state, setState] = createSignal<TimelineState>(createTimelineState(sessionID))
  const [now, setNow] = createSignal(Date.now())

  const session = createMemo(() => (sessionID ? context.data.session.get(sessionID) : undefined))
  const title = createMemo(() => sanitizeTerminalText(session()?.title ?? (sessionID ? "(session unavailable)" : "No session selected")))
  const status = createMemo<"idle" | "running">(() => (session() ? context.data.session.status(session()!.id) : "idle"))
  const pending = createMemo(() =>
    session()
      ? classifyNeedsInput({
          permissions: context.data.session.permission.list(session()!.id),
          forms: context.data.session.form.list(session()!.id, session()!.location),
        })
      : undefined,
  )
  const outcome = createMemo(() => outcomeLabel(state().events, status()))
  const note = createMemo(() => timelineNotice(state()))
  const age = createMemo(() => activityAge(state().lastActivityAt, now()))

  const back = () => {
    if (props.onBack) {
      props.onBack()
      return
    }
    context.ui.router.navigate({ type: "plugin", name: SESSIONS_PAGE })
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 2,
    enabled: () => context.keymap.mode.current() !== "modal",
    commands: [{ bind: "escape", title: "Back", run: back }],
  }))

  const apply = (next: TimelineInputEvent) => {
    setState((current) => applyTimelineEvent(current, next))
  }

  onMount(() => {
    const stops: Array<() => void> = []
    const controller = new AbortController()
    let disposed = false

    if (!sessionID) {
      setState((current) => setTimelineCoverage(current, { status: "error", detail: "no session selected" }))
    } else {
      void context.data.session.sync(sessionID).catch(() => {})
      if (context.data.session.permission.list(sessionID) === undefined) {
        void context.data.session.permission.sync(sessionID).catch(() => {})
      }
      const location = session()?.location
      if (location && context.data.session.form.list(sessionID, location) === undefined) {
        void context.data.session.form.sync(sessionID, location).catch(() => {})
      }

      // Subscribe before the history read so a live event that lands during the
      // read is already in the reducer when the overlapping snapshot arrives.
      for (const type of TIMELINE_LIVE_EVENTS) {
        stops.push(
          (context.data.on as unknown as (type: string, handler: (event: TimelineInputEvent) => void) => () => void)(
            type,
            apply,
          ),
        )
      }

      const stream = logStream(context, sessionID, controller.signal)
      if (!stream) {
        setState((current) => setTimelineCoverage(current, { status: "unsupported" }))
      } else {
        setState((current) => setTimelineCoverage(current, { status: "loading" }))
        void readTimelineHistory(stream, { signal: controller.signal })
          .then((history) => {
            if (disposed) return
            setState((current) => {
              const merged = applyTimelineHistory(current, history.items)
              return setTimelineCoverage(merged, { status: "ready", partial: history.partial })
            })
          })
          .catch((error: unknown) => {
            if (disposed || controller.signal.aborted) return
            setState((current) =>
              setTimelineCoverage(current, { status: "error", detail: errorText(error) || undefined }),
            )
          })
      }
    }

    const ticker = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    onCleanup(() => {
      disposed = true
      controller.abort()
      clearInterval(ticker)
      for (const stop of stops) stop()
    })
  })

  return (
    <box width="100%" height="100%" backgroundColor={theme.background.base}>
      <box
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <box flexDirection="row" gap={1} minWidth={0}>
          <text fg={theme.text.base}>
            <b>Activity</b>
          </text>
          <text fg={theme.text.base}>{truncateHead(title(), 48)}</text>
        </box>
        <text fg={theme.text.muted}>esc back</text>
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} flexDirection="row" gap={1}>
        <text fg={toneColor(theme, outcome().tone)}>{outcome().label}</text>
        <text fg={theme.text.muted}>{`· last activity ${age()}`}</text>
        <Show when={pending()}>
          {(needs) => (
            <text fg={needs().kind === "permission" ? theme.text.feedback.warning.base : theme.hue.accent[200]}>
              {needs().kind === "permission" ? "· waiting for permission" : "· waiting for answer"}
            </text>
          )}
        </Show>
      </box>
      <Show when={note()}>
        {(value) => (
          <box flexShrink={0} paddingLeft={2} paddingRight={2}>
            <text fg={value().warning ? theme.text.feedback.warning.base : theme.text.muted}>{value().text}</text>
          </box>
        )}
      </Show>
      <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <Show
          when={state().events.length > 0}
          fallback={<text fg={theme.text.muted}>No activity observed yet.</text>}
        >
          <For each={state().events}>
            {(event) => (
              <box flexShrink={0} flexDirection="row" gap={1}>
                <box width={TIMESTAMP_WIDTH} flexShrink={0}>
                  <text fg={theme.text.muted}>{formatTime(event.at)}</text>
                </box>
                <text fg={toneColor(theme, event.tone)}>{truncateHead(event.label, 90)}</text>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>
          {state().events.length > 0
            ? `${state().events.length} event${state().events.length === 1 ? "" : "s"} · newest first · esc back`
            : "esc back"}
        </text>
      </box>
    </box>
  )
}

/** Navigate to the timeline route for one pinned root session. */
export function openTimeline(context: Plugin.Context, sessionID: string): void {
  context.ui.router.navigate({ type: "plugin", name: TIMELINE_PAGE, data: { sessionID } })
}

/**
 * Keymap command for the sessions list. Integration spreads this into the
 * existing page-layer command list so `t` opens the pinned selected session.
 */
export function timelineKeyCommand(
  context: Plugin.Context,
  selectedSessionID: () => string | undefined,
): { readonly bind: string; readonly title: string; readonly group: string; readonly run: () => void } {
  return {
    bind: "t",
    title: "Session activity",
    group: "Gangway",
    run: () => {
      const sessionID = selectedSessionID()
      if (sessionID) openTimeline(context, sessionID)
    },
  }
}

/**
 * Register the feature's standalone route. Integration calls this once in the
 * plugin setup; the returned cleanup unregisters it.
 */
export function registerTimelineRoute(
  context: Plugin.Context,
  options: { readonly onBack?: () => void } = {},
): () => void {
  return context.ui.router.register({
    name: TIMELINE_PAGE,
    render: (input) => {
      const sessionID = typeof input.data?.sessionID === "string" ? input.data.sessionID : undefined
      return <TimelinePage context={context} sessionID={sessionID} onBack={options.onBack} />
    },
  })
}
