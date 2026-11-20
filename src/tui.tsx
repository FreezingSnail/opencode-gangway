import { Plugin } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  GANGWAY_FILTERS,
  applyGangwayFilter,
  formatAge,
  isGangwaySession,
  modelLabel,
  titleLabel,
  truncateHead,
  truncatePath,
  type GangwayFilter,
} from "./tui-helpers"

const PAGE = "gangway.sessions"
const LIST_LIMIT = 500
const REFRESH_MS = 5000
const MODEL_WIDTH = 22
const PATH_WIDTH = 30

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
 */
async function hydrate(context: Plugin.Context) {
  try {
    const response = await context.client.session.list({
      parentID: null,
      limit: LIST_LIMIT,
      order: "desc",
    })
    for (const info of response.data) {
      if (!isGangwaySession(info)) continue
      if (!context.data.session.get(info.id)) (context.data.session as SessionDataWithRemember).remember(info)
    }
  } catch {
    // Transient transport failure: events still keep the list live.
  }
}

const FILTER_LABEL: Record<GangwayFilter, string> = { here: "here", active: "active", all: "all" }

function SessionsPage(props: {
  context: Plugin.Context
  filter: () => GangwayFilter
  setFilter: (filter: GangwayFilter) => void
  onBack: () => void
}) {
  const context = props.context
  const theme = context.theme
  const [selected, setSelected] = createSignal(0)

  // Current TUI location: the directory the "here" filter is scoped to.
  const directory = createMemo(() => context.location?.directory ?? context.data.location.default().directory)

  // Live view over the shared data store: sessions appear, update status and
  // disappear through server events without any manual refresh.
  const sessions = createMemo(() =>
    context.data.session.list().filter((session) => isGangwaySession(session) && !session.parentID),
  )
  const statusOf = (session: SessionInfo) => context.data.session.status(session.id)

  const counts = createMemo(() => {
    const result: Record<GangwayFilter, number> = { here: 0, active: 0, all: 0 }
    for (const filter of GANGWAY_FILTERS)
      result[filter] = applyGangwayFilter(sessions(), filter, { directory: directory(), status: statusOf }).length
    return result
  })
  const visible = createMemo(() =>
    applyGangwayFilter(sessions(), props.filter(), { directory: directory(), status: statusOf }),
  )
  const selectedIndex = createMemo(() => Math.min(selected(), Math.max(0, visible().length - 1)))

  const switchFilter = (filter: GangwayFilter) => {
    if (filter === props.filter()) return
    props.setFilter(filter)
    setSelected(0)
  }

  onMount(() => {
    void hydrate(context)
    const interval = setInterval(() => void hydrate(context), REFRESH_MS)
    onCleanup(() => clearInterval(interval))
  })

  const open = (session: SessionInfo) => {
    context.ui.router.navigate({ type: "session", sessionID: session.id })
  }

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
        run: () => void hydrate(context),
      },
      {
        bind: "escape",
        title: "Back",
        run: props.onBack,
      },
      ...GANGWAY_FILTERS.map((filter, index) => ({
        bind: String(index + 1),
        title: `Filter: ${FILTER_LABEL[filter]}`,
        run: () => switchFilter(filter),
      })),
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
        <text fg={theme.text.base}>
          <b>Gangway sessions</b>
        </text>
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
      <scrollbox flexGrow={1} minHeight={0}>
        <Show
          when={visible().length > 0}
          fallback={<EmptyState context={context} filter={() => props.filter()} directory={directory()} />}
        >
          <For each={visible()}>
            {(session, index) => {
              const running = () => statusOf(session) === "running"
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
                    <text fg={running() ? theme.text.feedback.info.base : theme.text.muted}>
                      {running() ? "▶" : "○"}
                    </text>
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
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>1/2/3 filter · j/k move · enter open · i interrupt · r refresh · esc back</text>
      </box>
    </box>
  )
}

function EmptyState(props: { context: Plugin.Context; filter: () => GangwayFilter; directory?: string }) {
  const theme = props.context.theme
  const message = createMemo(() => {
    const filter = props.filter()
    if (filter === "all") return "No gangway sessions yet. They appear live when Codex starts one."
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
    // from plugin load, even when no server event has been seen yet.
    void hydrate(context)

    const unregisterRoute = context.ui.router.register({
      name: PAGE,
      render: () => (
        <SessionsPage
          context={context}
          filter={() => prefs.filter}
          setFilter={(filter) => void updatePrefs((draft) => (draft.filter = filter))}
          onBack={() => context.ui.router.navigate(previous())}
        />
      ),
    })

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
              run: () => {
                const current = context.ui.router.current()
                if (current.type === "plugin" && current.name === PAGE) return
                setPrevious({ ...current })
                context.ui.dialog.clear()
                context.ui.router.navigate({ type: "plugin", name: PAGE })
              },
            },
          ],
        }))
        return null
      },
    })

    const unregisterStatus = context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const count = createMemo(() => context.data.session.list().filter(isGangwaySession).length)
        return (
          <Show when={count() > 0}>
            <text fg={context.theme.text.muted}>{`gangway ${count()}`}</text>
          </Show>
        )
      },
    })

    const stopCreated = context.data.on("session.created", (event) => {
      if (event.data.metadata?.codexMcp !== true) return
      context.ui.toast.show({
        sessionID: event.data.sessionID,
        message: "Codex started a gangway session",
        variant: "info",
      })
    })

    return () => {
      unregisterRoute()
      unregisterAppSlot()
      unregisterStatus()
      stopCreated()
    }
  },
})
