import { Plugin } from "@opencode/plugin/tui"
import type { LocationRef, PermissionRequest, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  GANGWAY_FILTERS,
  applyGangwayFilter,
  classifyNeedsInput,
  countWaitingSessions,
  formatAge,
  hasGangwayMarker,
  isGangwaySession,
  modelLabel,
  sessionGlyph,
  shouldOpenPanelOnLeft,
  titleLabel,
  truncateHead,
  truncatePath,
  type GangwayFilter,
  type NeedsInput,
} from "./tui-helpers"
import {
  activeTool,
  activityAge,
  assistantExcerpt,
  latestAction,
  latestActivityAt,
  sanitizeTerminalText,
} from "./tui-preview"
import { createGangwayStats, STATS_SHORTCUT, type GangwayStatsFeature } from "./tui-stats"
import { changesKeyCommand, registerChangesView } from "./tui-changes-view"
import { dispatchKeyCommand, registerDispatchRoute } from "./tui-dispatch-view"
import { registerTimelineRoute, timelineKeyCommand } from "./tui-timeline-view"
import { installInbox } from "./tui-inbox"
import { registerUsageFeature } from "./tui-usage-page"

const PAGE = "gangway.sessions"
const LIST_LIMIT = 500
const REFRESH_MS = 5000
const MODEL_WIDTH = 22
const PATH_WIDTH = 30
const WIDE_MIN = 116
const PREVIEW_WIDTH = 46
const PREVIEW_HEIGHT = 16
const AGE_TICK_MS = 15000

interface PreviewApi {
  list(sessionID: string): SessionMessageInfo[]
  sync(sessionID: string): Promise<void>
}

interface PeekSnapshot {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly location: LocationRef
}

interface PeekHistory {
  readonly id: string
  readonly status: "loading" | "ready" | "error"
  readonly error?: string
  readonly fallback?: boolean
}

interface FallbackMessages {
  readonly id: string
  readonly messages: SessionMessageInfo[]
}

function terminalWidth(context: Plugin.Context): number {
  const renderer = context.renderer as unknown as { width?: unknown }
  if (typeof renderer?.width === "number" && renderer.width > 0) return renderer.width
  return process.stdout.columns ?? 100
}

/**
 * The host's data session owns message caching and event updates. Older hosts
 * may not expose it; in that case the caller reads the same session directly
 * with `client.message.list`.
 */
function previewApi(context: Plugin.Context): PreviewApi | undefined {
  const message = (context.data.session as unknown as { message?: Partial<PreviewApi> }).message
  if (!message || typeof message.list !== "function" || typeof message.sync !== "function") return undefined
  return message as PreviewApi
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ageLabel(timestamp: number | undefined, now: number): string {
  return activityAge(timestamp, now)
}

// The runtime data store (solid client) exposes `remember`, which hydrates a
// session from an already-fetched SessionInfo without an extra GET. The TUI
// SDK type omits it; narrow it once instead of re-fetching per session.
type SessionDataWithRemember = Plugin.Context["data"]["session"] & {
  remember(info: SessionInfo): void
}

/**
 * Hydrate gangway sessions from every location, not just the current one.
 * The store is populated by server events for anything created while the TUI
 * runs; this covers sessions created before the TUI (or while disconnected).
 * Busy sessions with unsynced permission/form lists are synced once; the keys
 * dedupe concurrent sweeps and defined lists are never refetched.
 */
const attentionSyncs = new Map<string, Promise<void>>()

async function syncAttention(context: Plugin.Context, sessions: readonly SessionInfo[] = context.data.session.list()) {
  const tasks: Promise<void>[] = []
  for (const session of sessions) {
    if (!isGangwaySession(session) || session.parentID) continue
    if (context.data.session.status(session.id) !== "running") continue

    if (context.data.session.permission.list(session.id) === undefined) {
      const key = `permission:${session.id}`
      if (!attentionSyncs.has(key)) {
        const task = context.data.session.permission
          .sync(session.id)
          .catch(() => {})
          .finally(() => attentionSyncs.delete(key))
        attentionSyncs.set(key, task)
      }
      const pending = attentionSyncs.get(key)
      if (pending) tasks.push(pending)
    }

    if (context.data.session.form.list(session.id, session.location) === undefined) {
      const key = `form:${session.id}:${session.location.directory}`
      if (!attentionSyncs.has(key)) {
        const task = context.data.session.form
          .sync(session.id, session.location)
          .catch(() => {})
          .finally(() => attentionSyncs.delete(key))
        attentionSyncs.set(key, task)
      }
      const pending = attentionSyncs.get(key)
      if (pending) tasks.push(pending)
    }
  }
  await Promise.all(tasks)
}

async function hydrate(context: Plugin.Context) {
  let listed: readonly SessionInfo[] = []
  try {
    const response = await context.client.session.list({
      parentID: null,
      limit: LIST_LIMIT,
      order: "desc",
    })
    listed = response.data
    for (const info of response.data) {
      if (!isGangwaySession(info)) continue
      if (!context.data.session.get(info.id)) (context.data.session as SessionDataWithRemember).remember(info)
    }
  } catch {
    // Transient transport failure: events still keep the list live.
  }
  await syncAttention(context, [...listed, ...context.data.session.list()])
}

const FILTER_LABEL: Record<GangwayFilter, string> = { here: "here", active: "active", all: "all" }

function SessionsPage(props: {
  context: Plugin.Context
  filter: () => GangwayFilter
  setFilter: (filter: GangwayFilter) => void
  onBack: () => void
  stats: GangwayStatsFeature
}) {
  const context = props.context
  const theme = context.theme
  const [selected, setSelected] = createSignal(0)
  const [peekID, setPeekID] = createSignal<string>()
  const [peekSnapshot, setPeekSnapshot] = createSignal<PeekSnapshot>()
  const [peekHistory, setPeekHistory] = createSignal<PeekHistory>()
  const [fallbackMessages, setFallbackMessages] = createSignal<FallbackMessages>()
  const [now, setNow] = createSignal(Date.now())
  const [width, setWidth] = createSignal(terminalWidth(context))
  let previewRequest = 0

  // Current TUI location: the directory the "here" filter is scoped to.
  const directory = createMemo(() => context.location?.directory ?? context.data.location.default().directory)

  // Live view over the shared data store: sessions appear, update status and
  // disappear through server events without any manual refresh.
  const sessions = createMemo(() =>
    context.data.session.list().filter((session) => isGangwaySession(session) && !session.parentID),
  )
  const statusOf = (session: SessionInfo) => context.data.session.status(session.id)
  const attentionOf = (session: SessionInfo): NeedsInput | undefined =>
    classifyNeedsInput({
      permissions: context.data.session.permission.list(session.id),
      forms: context.data.session.form.list(session.id, session.location),
    })

  const counts = createMemo(() => {
    const result: Record<GangwayFilter, number> = { here: 0, active: 0, all: 0 }
    for (const filter of GANGWAY_FILTERS)
      result[filter] = applyGangwayFilter(sessions(), filter, {
        directory: directory(),
        status: statusOf,
        attention: attentionOf,
      }).length
    return result
  })
  const visible = createMemo(() =>
    applyGangwayFilter(sessions(), props.filter(), {
      directory: directory(),
      status: statusOf,
      attention: attentionOf,
    }),
  )
  const waiting = createMemo(() => countWaitingSessions(visible(), attentionOf))
  const selectedIndex = createMemo(() => Math.min(selected(), Math.max(0, visible().length - 1)))

  const wide = () => width() >= WIDE_MIN

  // The peek is pinned to the ID captured at open time. It resolves that ID
  // through the shared store on every update, so reorders and status changes
  // never substitute a different session.
  const peekSession = createMemo(() => {
    const id = peekID()
    return id ? context.data.session.get(id) : undefined
  })
  const peekMessages = createMemo(() => {
    const id = peekID()
    if (!id) return [] as SessionMessageInfo[]
    const api = previewApi(context)
    if (api) return api.list(id)
    const fallback = fallbackMessages()
    return fallback?.id === id ? fallback.messages : []
  })
  const peekLocation = createMemo(() => peekSession()?.location ?? peekSnapshot()?.location)
  const peekPermissions = createMemo<PermissionRequest[] | undefined>(() => {
    const id = peekID()
    return id ? context.data.session.permission.list(id) : undefined
  })
  const peekForms = createMemo(() => {
    const id = peekID()
    return id ? context.data.session.form.list(id, peekLocation()) : undefined
  })
  const peekAttention = createMemo(() =>
    classifyNeedsInput({ permissions: peekPermissions(), forms: peekForms() }),
  )
  const peekRunning = createMemo(() => {
    const session = peekSession()
    return session !== undefined && context.data.session.status(session.id) === "running"
  })
  const peekActive = createMemo(() => activeTool(peekMessages(), peekRunning()))
  const peekLatest = createMemo(() => latestAction(peekMessages()))
  const peekExcerpt = createMemo(() =>
    assistantExcerpt(peekMessages(), {
      maxChars: wide() ? 600 : 320,
      maxLines: wide() ? 10 : 5,
    }),
  )
  const peekActivity = createMemo(() =>
    latestActivityAt(peekMessages(), peekSession()?.time.updated ?? 0),
  )
  const peekTitle = createMemo(() => {
    const value = peekSession()?.title ?? peekSnapshot()?.title ?? "(untitled)"
    return sanitizeTerminalText(value)
  })
  const peekDirectory = createMemo(() => {
    const value = peekSession()?.location.directory ?? peekSnapshot()?.directory ?? "?"
    return sanitizeTerminalText(context.ui.format.path(value))
  })
  const previewTextWidth = () => Math.max(12, (wide() ? PREVIEW_WIDTH : width()) - 4)
  const peekHistoryNote = createMemo(() => {
    const history = peekHistory()
    const hasMessages = peekMessages().length > 0
    if (!peekID()) return undefined
    if (!peekSession()) return "Session no longer available."
    if (history?.status === "loading") return hasMessages ? "Updating history…" : "Loading history…"
    if (history?.status === "error") {
      const message = sanitizeTerminalText(history.error ?? "fetch failed")
      return hasMessages ? `History may be stale: ${message}` : `History unavailable: ${message}`
    }
    if (history?.fallback) return "Showing a direct snapshot; live history is unavailable."
    if (!hasMessages) return "No messages yet."
    return undefined
  })
  const peekStateLabel = createMemo(() => {
    if (peekID() && !peekSession()) return "unavailable"
    if (peekAttention()?.kind === "permission") return "waiting for permission"
    if (peekAttention()?.kind === "question") return "waiting for answer"
    return peekRunning() ? "running" : "idle"
  })
  const peekStateColor = createMemo(() => {
    if (peekID() && !peekSession()) return theme.text.feedback.warning.base
    if (peekAttention()?.kind === "permission") return theme.text.feedback.warning.base
    if (peekAttention()?.kind === "question") return theme.hue.accent[200]
    return peekRunning() ? theme.text.feedback.info.base : theme.text.muted
  })

  const loadPeek = (session: SessionInfo) => {
    const id = session.id
    const request = ++previewRequest
    setPeekHistory({ id, status: "loading" })
    const api = previewApi(context)
    if (api) {
      void api.sync(id).then(
        () => {
          if (request !== previewRequest || peekID() !== id) return
          setPeekHistory({ id, status: "ready" })
        },
        (error: unknown) => {
          if (request !== previewRequest || peekID() !== id) return
          setPeekHistory({ id, status: "error", error: errorText(error) })
        },
      )
      return
    }
    void context.client.message.list({ sessionID: id, limit: 20, order: "desc" }).then(
      (response) => {
        if (request !== previewRequest || peekID() !== id) return
        setFallbackMessages({ id, messages: [...response.data].reverse() })
        setPeekHistory({ id, status: "ready", fallback: true })
      },
      (error: unknown) => {
        if (request !== previewRequest || peekID() !== id) return
        setPeekHistory({ id, status: "error", error: errorText(error) })
      },
    )
  }

  const openPeek = () => {
    const session = visible()[selectedIndex()]
    if (!session) return
    setPeekSnapshot({
      id: session.id,
      title: titleLabel(session),
      directory: session.location.directory,
      location: session.location,
    })
    setPeekID(session.id)
    setFallbackMessages(undefined)
    if (context.data.session.permission.list(session.id) === undefined) {
      void context.data.session.permission.sync(session.id).catch(() => {})
    }
    if (context.data.session.form.list(session.id, session.location) === undefined) {
      void context.data.session.form.sync(session.id, session.location).catch(() => {})
    }
    loadPeek(session)
  }

  const closePeek = () => {
    previewRequest += 1
    setPeekID(undefined)
    setPeekSnapshot(undefined)
    setPeekHistory(undefined)
    setFallbackMessages(undefined)
  }

  const togglePeek = () => {
    if (peekID()) closePeek()
    else openPeek()
  }

  const refreshPeek = () => {
    const session = peekSession()
    if (session) loadPeek(session)
  }

  const switchFilter = (filter: GangwayFilter) => {
    if (filter === props.filter()) return
    props.setFilter(filter)
    setSelected(0)
  }

  onMount(() => {
    void hydrate(context)
    const measure = () => setWidth(terminalWidth(context))
    measure()
    process.stdout.on("resize", measure)
    const ticker = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    onCleanup(() => {
      previewRequest += 1
      process.stdout.off("resize", measure)
      clearInterval(ticker)
    })
  })

  const open = (session: SessionInfo) => {
    context.ui.router.navigate({ type: "session", sessionID: session.id })
  }

  const selectedSession = () => visible()[selectedIndex()]
  const selectedSessionID = () => selectedSession()?.id
  const openStats = () => props.stats.open({ directory: directory() })

  const interrupt = (session: SessionInfo) => {
    void context.client.session.interrupt({ sessionID: session.id }).then(
      () => context.ui.toast.show({ sessionID: session.id, message: "Interrupt sent", variant: "info" }),
      () => context.ui.toast.show({ message: "Interrupt failed", variant: "error" }),
    )
  }

  context.keymap.layer(() => ({
    commands: [
      {
        bind: "return",
        title: "Open session",
        run: () => {
          const session = visible()[selectedIndex()]
          if (session) open(session)
        },
      },
      {
        bind: "p",
        title: peekID() ? "Close peek" : "Peek session",
        run: togglePeek,
      },
      {
        bind: STATS_SHORTCUT,
        title: "Gangway stats",
        group: "Gangway",
        run: openStats,
      },
      changesKeyCommand(context, selectedSessionID),
      dispatchKeyCommand(context, selectedSessionID),
      timelineKeyCommand(context, selectedSessionID),
      {
        bind: "up,k",
        title: "Previous session",
        run: () => setSelected(Math.max(0, selectedIndex() - 1)),
      },
      {
        bind: "down,j",
        title: "Next session",
        run: () => setSelected(Math.min(visible().length - 1, selectedIndex() + 1)),
      },
      {
        bind: "i",
        title: "Interrupt session",
        run: () => {
          const session = visible()[selectedIndex()]
          if (session) interrupt(session)
        },
      },
      {
        bind: "r",
        title: "Refresh",
        run: () => {
          void hydrate(context)
          refreshPeek()
        },
      },
      ...GANGWAY_FILTERS.map((filter, index) => ({
        bind: String(index + 1),
        title: `Filter: ${FILTER_LABEL[filter]}`,
        run: () => switchFilter(filter),
      })),
    ],
  }))

  // Escape must leave this page even if the session input mode stack is not at
  // base (background tabs can leave a form/autocomplete mode pushed). Modal
  // dialogs keep their own escape handling. An open peek owns the first escape.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    enabled: () => context.keymap.mode.current() !== "modal",
    commands: [
      {
        bind: "escape",
        title: peekID() ? "Close peek" : "Back",
        run: () => {
          if (peekID()) closePeek()
          else props.onBack()
        },
      },
    ],
  }))

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
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base}>
            <b>Gangway sessions</b>
          </text>
          <Show when={waiting() > 0}>
            <text fg={theme.text.feedback.warning.base}>{`· ${waiting()} waiting`}</text>
          </Show>
        </box>
        <box flexDirection="row" gap={2}>
          <For each={GANGWAY_FILTERS}>
            {(filter, index) => {
              const active = () => filter === props.filter()
              const label = () => `${index() + 1} ${FILTER_LABEL[filter]} (${counts()[filter]})`
              return (
                <text fg={active() ? theme.text.base : theme.text.muted}>
                  {active() ? <b>{label()}</b> : label()}
                </text>
              )
            }}
          </For>
        </box>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection={wide() ? "row" : "column"} gap={wide() ? 1 : 0}>
        <scrollbox flexGrow={1} minWidth={0} minHeight={0}>
          <Show
            when={visible().length > 0}
            fallback={<EmptyState context={context} filter={() => props.filter()} directory={directory()} />}
          >
            <For each={visible()}>
              {(session, index) => {
                const running = () => statusOf(session) === "running"
                const attention = () => attentionOf(session)
                const glyphColor = () => {
                  const needs = attention()
                  if (needs?.kind === "permission") return theme.text.feedback.warning.base
                  if (needs?.kind === "question") return theme.hue.accent[200]
                  return running() ? theme.text.feedback.info.base : theme.text.muted
                }
                const active = () => index() === selectedIndex()
                return (
                  <box
                    flexShrink={0}
                    flexDirection="row"
                    gap={1}
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={active() ? theme.background.raised.high : undefined}
                  >
                    <box width={2} flexShrink={0}>
                      <text fg={glyphColor()}>{sessionGlyph(statusOf(session), attention())}</text>
                    </box>
                    <box flexGrow={1} minWidth={0} flexShrink={1}>
                      <text fg={theme.text.base}>{titleLabel(session)}</text>
                    </box>
                    <box width={MODEL_WIDTH} flexShrink={0}>
                      <text fg={theme.text.muted}>{truncateHead(modelLabel(session), MODEL_WIDTH)}</text>
                    </box>
                    <box width={5} flexShrink={0}>
                      <text fg={theme.text.muted}>{formatAge(session.time.updated).padStart(5)}</text>
                    </box>
                    <box width={PATH_WIDTH} flexShrink={0}>
                      <text fg={theme.text.muted}>
                        {truncatePath(context.ui.format.path(session.location.directory), PATH_WIDTH)}
                      </text>
                    </box>
                  </box>
                )
              }}
            </For>
          </Show>
        </scrollbox>
        <Show when={peekID()}>
          <box
            width={wide() ? PREVIEW_WIDTH : undefined}
            height={wide() ? undefined : PREVIEW_HEIGHT}
            flexShrink={0}
            minHeight={0}
            flexDirection="column"
            backgroundColor={theme.background.raised.high}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
          >
            <box flexShrink={0} flexDirection="row" justifyContent="space-between" gap={1}>
              <text fg={theme.text.base}>
                <b>Peek</b>
              </text>
              <text fg={theme.text.muted}>{wide() ? "p/esc close" : "esc close"}</text>
            </box>
            <text fg={theme.text.base}>{truncateHead(peekTitle(), previewTextWidth())}</text>
            <text fg={theme.text.muted}>{truncatePath(peekDirectory(), previewTextWidth())}</text>
            <box flexShrink={0} flexDirection="row" gap={1}>
              <text fg={peekStateColor()}>{peekStateLabel()}</text>
              <text fg={theme.text.muted}>{`· last activity ${ageLabel(peekActivity(), now())}`}</text>
            </box>
            <Show when={(peekPermissions()?.length ?? 0) > 0}>
              <For each={peekPermissions()!.slice(0, 2)}>
                {(permission) => (
                  <box flexShrink={0}>
                    <text fg={theme.text.feedback.warning.base}>
                      {truncateHead(
                        `! Permission · ${sanitizeTerminalText(permission.action)}`,
                        previewTextWidth(),
                      )}
                    </text>
                    <Show when={permission.resources.length > 0}>
                      <text fg={theme.text.muted}>
                        {truncateHead(
                          sanitizeTerminalText(permission.resources.join(", ")),
                          previewTextWidth(),
                        )}
                      </text>
                    </Show>
                  </box>
                )}
              </For>
            </Show>
            <Show when={(peekForms()?.length ?? 0) > 0}>
              <For each={peekForms()!.slice(0, 2)}>
                {(form) => (
                  <text fg={theme.hue.accent[200]}>
                    {truncateHead(`? ${sanitizeTerminalText(form.title)}`, previewTextWidth())}
                  </text>
                )}
              </For>
            </Show>
            <Show when={peekHistoryNote()}>
              {(note) => (
                <text
                  fg={peekHistory()?.status === "error" ? theme.text.feedback.warning.base : theme.text.muted}
                >
                  {note()}
                </text>
              )}
            </Show>
            <scrollbox flexGrow={1} minHeight={0}>
              <Show
                when={peekActive()}
                fallback={
                  <Show when={peekLatest()}>
                    {(latest) => (
                      <text fg={theme.text.muted}>
                        {truncateHead(
                          `${latest().kind === "tool" ? "Tool" : "Shell"} · ${sanitizeTerminalText(latest().name)} · ${latest().status} · ${ageLabel(latest().timestamp, now())}`,
                          previewTextWidth(),
                        )}
                      </text>
                    )}
                  </Show>
                }
              >
                {(active) => (
                  <text fg={theme.text.feedback.info.base}>
                    {truncateHead(
                      `Active tool · ${sanitizeTerminalText(active().name)} · ${active().status}`,
                      previewTextWidth(),
                    )}
                  </text>
                )}
              </Show>
              <Show when={peekExcerpt()}>
                {(excerpt) => (
                  <>
                    <box flexShrink={0} paddingTop={1}>
                      <text fg={theme.text.muted}>{excerpt().earlier ? "Earlier output" : "Latest output"}</text>
                    </box>
                    <text fg={theme.text.base}>{excerpt().text}</text>
                  </>
                )}
              </Show>
            </scrollbox>
          </box>
        </Show>
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>
          {`${waiting() > 0 ? `${waiting()} waiting · ` : ""}1/2/3 filter · j/k · enter open · p ${peekID() ? "close peek" : "peek"} · s stats · a inbox · d changes · o dispatch · t timeline · u usage · i stop · r refresh · esc ${peekID() ? "close peek" : "back"}`}
        </text>
      </box>
    </box>
  )
}

function EmptyState(props: { context: Plugin.Context; filter: () => GangwayFilter; directory?: string }) {
  const theme = props.context.theme
  const message = createMemo(() => {
    const filter = props.filter()
    if (filter === "all") return "No gangway sessions yet. They appear live when a client starts one."
    if (filter === "active") return "No active gangway sessions right now."
    return `No active gangway sessions in ${props.context.ui.format.path(props.directory ?? "?")}.`
  })
  return (
    <box paddingLeft={2} paddingRight={2}>
      <text fg={theme.text.muted}>{message()}</text>
    </box>
  )
}

export default Plugin.define({
  id: "gangway.tui",
  setup(context) {
    const [previous, setPrevious] = createSignal({ ...context.ui.router.current() })
    const [prefs, updatePrefs] = context.storage.store("panel", {
      initial: { filter: "here" as GangwayFilter },
    })

    // Hydrate immediately so the footer counter and the panel are correct
    // from plugin load, even when no server event has been seen yet. The sweep
    // also resolves unknown permission/form lists for busy sessions.
    void hydrate(context)
    const interval = setInterval(() => void hydrate(context), REFRESH_MS)

    // Standalone feature routes. Each owns its page component and view-local
    // bindings; the sessions list contributes only the entry action.
    const stats = createGangwayStats(context, {
      historyLimit: LIST_LIMIT,
      onRefresh: () => void hydrate(context),
    })
    const changes = registerChangesView(context, { sessionsPage: PAGE })
    const unregisterDispatch = registerDispatchRoute(context)
    const unregisterTimeline = registerTimelineRoute(context)
    const inbox = installInbox(context)
    const unregisterUsage = registerUsageFeature(context, {
      enabled: () => {
        const route = context.ui.router.current()
        return route.type === "plugin" && route.name === PAGE && context.keymap.mode.current() !== "modal"
      },
    })

    // Returning to a session route that is gone (closed tab, deleted session,
    // unresolved --continue placeholder) would land on a blank page. Fall back
    // to the new-chat home route instead.
    const back = () => {
      const target = previous()
      if (target.type === "session") {
        const info = context.data.session.get(target.sessionID)
        const open = !context.ui.tabs.enabled() || context.ui.tabs.list().some((tab) => tab.sessionID === target.sessionID)
        if (target.sessionID === "dummy" || !info || !open) {
          context.ui.router.navigate({
            type: "home",
            location: info?.location ?? context.location ?? context.data.location.default(),
          })
          return
        }
      }
      context.ui.router.navigate(target)
    }

    const unregisterRoute = context.ui.router.register({
      name: PAGE,
      render: () => (
        <SessionsPage
          context={context}
          filter={() => prefs.filter}
          setFilter={(filter) => void updatePrefs((draft) => (draft.filter = filter))}
          onBack={back}
          stats={stats}
        />
      ),
    })

    // Shared by the leader binding, palette, slash command and the empty-prompt
    // left gesture: remember where to return, dismiss any dialog, open the page.
    const openSessions = () => {
      const current = context.ui.router.current()
      if (current.type === "plugin" && current.name === PAGE) return
      setPrevious({ ...current })
      context.ui.dialog.clear()
      context.ui.router.navigate({ type: "plugin", name: PAGE })
    }

    // Global command layer: lives in the app slot so the binding, palette
    // entry and slash command stay available everywhere.
    const unregisterAppSlot = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "gangway.sessions",
              title: "Gangway sessions",
              group: "Gangway",
              bind: "<leader>d",
              palette: true,
              slash: { name: "gangway", aliases: ["gangway-sessions"] },
              run: openSessions,
            },
          ],
        }))
        // Empty-prompt gesture from the blank new-chat page or any session.
        // Base mode keeps it out of dialogs, autocomplete and form modes;
        // priority 2 beats the prompt layers (1) and the managed textarea
        // bindings. A non-empty prompt returns false so the event continues to
        // the cursor/selection bindings untouched. Read the route in the factory
        // body so navigation refreshes the layer; never attach a one-shot
        // `target` accessor, which can be captured before the prompt editor
        // exists.
        const openOnEmptyLeft = () => {
          const allowed = shouldOpenPanelOnLeft({
            routeType: context.ui.router.current().type,
            mode: context.keymap.mode.current(),
            editorText: context.renderer.currentFocusedEditor?.plainText ?? "",
          })
          if (!allowed) return false
          openSessions()
        }
        context.keymap.layer(() => {
          const routeType = context.ui.router.current().type
          return {
            mode: "base",
            priority: 2,
            enabled: routeType === "session" || routeType === "home",
            commands: [
              { bind: "left", title: "Gangway sessions", group: "Gangway", run: openOnEmptyLeft },
              { bind: "shift+left", title: "Gangway sessions", group: "Gangway", run: openOnEmptyLeft },
            ],
          }
        })
        return null
      },
    })

    const unregisterStatus = context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const sessions = createMemo(() => context.data.session.list().filter(isGangwaySession))
        const attentionOf = (session: SessionInfo) =>
          classifyNeedsInput({
            permissions: context.data.session.permission.list(session.id),
            forms: context.data.session.form.list(session.id, session.location),
          })
        const waiting = createMemo(() => countWaitingSessions(sessions(), attentionOf))
        return (
          <Show when={sessions().length > 0}>
            <text fg={context.theme.text.muted}>{`gangway ${sessions().length}${waiting() > 0 ? ` · ${waiting()} waiting` : ""}`}</text>
          </Show>
        )
      },
    })

    const stopCreated = context.data.on("session.created", (event) => {
      if (!hasGangwayMarker(event.data)) return
      context.ui.toast.show({
        sessionID: event.data.sessionID,
        message: "Gangway session started",
        variant: "info",
      })
    })

    // One toast per pending prompt id; cleared when the prompt is answered or
    // cancelled so a re-issued id can announce again. Display only: replies
    // stay with the user.
    const seenPermissions = new Set<string>()
    const seenForms = new Set<string>()

    const stopPermissionAsked = context.data.on("permission.asked", (event) => {
      if (seenPermissions.has(event.data.id)) return
      const session = context.data.session.get(event.data.sessionID)
      if (!session || !hasGangwayMarker(session)) return
      seenPermissions.add(event.data.id)
      context.ui.toast.show({
        sessionID: event.data.sessionID,
        message:
          event.data.action === "question" ? "Gangway session needs an answer" : "Gangway session needs permission",
        variant: "warning",
      })
    })

    const stopPermissionReplied = context.data.on("permission.replied", (event) => {
      seenPermissions.delete(event.data.requestID)
    })

    const stopFormCreated = context.data.on("form.created", (event) => {
      if (event.data.form.sessionID === "global") return
      if (seenForms.has(event.data.form.id)) return
      const session = context.data.session.get(event.data.form.sessionID)
      if (!session || !hasGangwayMarker(session)) return
      seenForms.add(event.data.form.id)
      context.ui.toast.show({
        sessionID: event.data.form.sessionID,
        message: "Gangway session has a question",
        variant: "warning",
      })
    })

    const stopFormReplied = context.data.on("form.replied", (event) => {
      seenForms.delete(event.data.id)
    })

    const stopFormCancelled = context.data.on("form.cancelled", (event) => {
      seenForms.delete(event.data.id)
    })

    return () => {
      clearInterval(interval)
      unregisterUsage()
      inbox.dispose()
      unregisterTimeline()
      unregisterDispatch()
      changes.unregister()
      stats.dispose()
      unregisterRoute()
      unregisterAppSlot()
      unregisterStatus()
      stopCreated()
      stopPermissionAsked()
      stopPermissionReplied()
      stopFormCreated()
      stopFormReplied()
      stopFormCancelled()
    }
  },
})
