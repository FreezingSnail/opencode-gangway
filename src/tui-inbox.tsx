import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  INBOX_REFRESH_MS,
  InboxTracker,
  hydrateInbox,
  inboxAgeLabel,
  inboxSources,
  resolveInboxSelection,
  type InboxDataStore,
  type InboxRow,
} from "./inbox"
import { truncateHead, truncatePath } from "./tui-helpers"

export const INBOX_PAGE = "gangway.inbox"
const SESSIONS_PAGE = "gangway.sessions"
const AGE_TICK_MS = 15000
const PATH_WIDTH = 34
const TITLE_WIDTH = 42
const AGE_WIDTH = 20

interface InboxPageProps {
  readonly context: Plugin.Context
  readonly tracker: InboxTracker
  readonly onBack: () => void
}

function terminalWidth(context: Plugin.Context): number {
  const renderer = context.renderer as unknown as { width?: unknown }
  if (typeof renderer?.width === "number" && renderer.width > 0) return renderer.width
  return process.stdout.columns ?? 100
}

function widthText(context: Plugin.Context): number {
  return Math.max(24, terminalWidth(context) - 8)
}

/**
 * Standalone needs-input inbox view. Reads only the shared session/permission/
 * form store; the native prompt remains the only place to answer a request.
 */
export function InboxPage(props: InboxPageProps) {
  const context = props.context
  const theme = context.theme
  const [now, setNow] = createSignal(Date.now())
  const [width, setWidth] = createSignal(terminalWidth(context))
  const [selectedKey, setSelectedKey] = createSignal<string>()
  const [fallbackIndex, setFallbackIndex] = createSignal(0)

  const sources = createMemo(() => inboxSources(context.data as unknown as InboxDataStore))
  const build = createMemo(() => props.tracker.build(sources(), now()))
  const rows = createMemo(() => build().rows)
  const selection = createMemo(() => resolveInboxSelection(rows(), selectedKey(), fallbackIndex()))

  // Keep the pin in sync when the selected row disappears or the list reorders.
  createEffect(() => {
    const current = selection()
    if (current.key !== selectedKey()) setSelectedKey(current.key)
    if (current.index !== fallbackIndex()) setFallbackIndex(current.index)
  })

  const textWidth = () => widthText(context)

  onMount(() => {
    void hydrateInbox(context as unknown as Parameters<typeof hydrateInbox>[0], props.tracker)
    const measure = () => setWidth(terminalWidth(context))
    measure()
    process.stdout.on("resize", measure)
    const ticker = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    const refresh = setInterval(
      () => void hydrateInbox(context as unknown as Parameters<typeof hydrateInbox>[0], props.tracker),
      INBOX_REFRESH_MS,
    )
    onCleanup(() => {
      process.stdout.off("resize", measure)
      clearInterval(ticker)
      clearInterval(refresh)
    })
  })

  const move = (delta: number) => {
    const current = selection()
    if (rows().length === 0) return
    const index = Math.max(0, Math.min(rows().length - 1, current.index + delta))
    setFallbackIndex(index)
    setSelectedKey(rows()[index]?.key)
  }

  const openSelected = () => {
    const row = rows()[selection().index]
    if (!row) return
    context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
  }

  const refresh = () => {
    void hydrateInbox(context as unknown as Parameters<typeof hydrateInbox>[0], props.tracker)
    setNow(Date.now())
  }

  context.keymap.layer(() => ({
    commands: [
      {
        bind: "return",
        title: "Open owning session",
        run: openSelected,
      },
      {
        bind: "up,k",
        title: "Previous request",
        run: () => move(-1),
      },
      {
        bind: "down,j",
        title: "Next request",
        run: () => move(1),
      },
      {
        bind: "r",
        title: "Refresh needs input",
        run: refresh,
      },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    enabled: () => context.keymap.mode.current() !== "modal",
    commands: [
      {
        bind: "escape",
        title: "Back",
        run: props.onBack,
      },
    ],
  }))

  const kindLabel = (row: InboxRow) => (row.kind === "permission" ? "approval" : "question")
  const kindColor = (row: InboxRow) =>
    row.kind === "permission" ? theme.text.feedback.warning.base : theme.hue.accent[200]

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
            <b>Gangway needs input</b>
          </text>
          <text fg={theme.text.muted}>{`· ${rows().length} pending`}</text>
        </box>
        <text fg={theme.text.muted}>{`${sources().sessions.length} session(s) across directories`}</text>
      </box>
      <Show when={build().note}>
        {(note) => (
          <box flexShrink={0} paddingLeft={2} paddingRight={2}>
            <text fg={theme.text.feedback.warning.base}>{note()}</text>
          </box>
        )}
      </Show>
      <scrollbox flexGrow={1} minHeight={0} paddingTop={1}>
        <Show
          when={rows().length > 0}
          fallback={
            <box paddingLeft={2} paddingRight={2}>
              <text fg={theme.text.muted}>{build().emptyMessage}</text>
            </box>
          }
        >
          <For each={rows()}>
            {(row) => {
              const active = () => row.key === selection().key
              return (
                <box
                  flexShrink={0}
                  flexDirection="row"
                  gap={1}
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  paddingBottom={1}
                  backgroundColor={active() ? theme.background.raised.high : undefined}
                >
                  <box width={2} flexShrink={0}>
                    <text fg={kindColor(row)}>{row.kind === "permission" ? "!" : "?"}</text>
                  </box>
                  <box flexGrow={1} minWidth={0} flexDirection="column">
                    <box flexDirection="row" gap={2}>
                      <box flexShrink={1} minWidth={0}>
                        <text fg={theme.text.base}>{truncateHead(row.sessionTitle, TITLE_WIDTH)}</text>
                      </box>
                      <text fg={kindColor(row)}>{kindLabel(row)}</text>
                      <text fg={theme.text.muted}>
                        {truncatePath(context.ui.format.path(row.directory), PATH_WIDTH)}
                      </text>
                    </box>
                    <text fg={theme.text.base}>{truncateHead(row.summary, textWidth())}</text>
                    <Show when={row.detail}>
                      {(detail) => (
                        <text fg={theme.text.muted}>{truncateHead(detail(), textWidth())}</text>
                      )}
                    </Show>
                  </box>
                  <box width={AGE_WIDTH} flexShrink={0}>
                    <text fg={theme.text.muted}>{truncateHead(inboxAgeLabel(row, now()), AGE_WIDTH)}</text>
                  </box>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>
          {"j/k move · enter open session · r refresh · esc back · answers stay in the session"}
        </text>
      </box>
    </box>
  )
}

export interface InboxInstall {
  readonly tracker: InboxTracker
  /** Open the inbox, remembering the current route for Escape. */
  open(): void
  /** Navigate back to the route that opened the inbox. */
  back(): void
  dispose(): void
}

/**
 * Register the standalone inbox route, the `a` action on the sessions list, and
 * the shared event-time subscription. Call once from TUI plugin setup:
 *
 *   const inbox = installInbox(context)
 *   // ... and return `inbox.dispose` from setup's cleanup.
 *
 * The sessions panel itself is intentionally untouched.
 */
export function installInbox(context: Plugin.Context): InboxInstall {
  const tracker = new InboxTracker()
  let previous = { ...context.ui.router.current() }

  const back = () => context.ui.router.navigate(previous)

  const unregisterRoute = context.ui.router.register({
    name: INBOX_PAGE,
    render: () => <InboxPage context={context} tracker={tracker} onBack={back} />,
  })

  const open = () => {
    const current = context.ui.router.current()
    if (current.type === "plugin" && current.name === INBOX_PAGE) return
    previous = { ...current }
    context.ui.dialog.clear()
    context.ui.router.navigate({ type: "plugin", name: INBOX_PAGE })
    void hydrateInbox(context as unknown as Parameters<typeof hydrateInbox>[0], tracker)
  }

  const stopPermissionAsked = context.data.on("permission.asked", (event) => tracker.noteEvent(event))
  const stopFormCreated = context.data.on("form.created", (event) => tracker.noteEvent(event))

  // The `a` action belongs to the sessions list only; this standalone layer is
  // inert on session, home and modal routes, so prompt typing is unaffected.
  const unregisterAppSlot = context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => {
        const route = context.ui.router.current()
        return {
          mode: "global",
          enabled: route.type === "plugin" && route.name === SESSIONS_PAGE,
          commands: [
            {
              id: "gangway.inbox",
              title: "Gangway needs-input inbox",
              group: "Gangway",
              bind: "a",
              run: open,
            },
          ],
        }
      })
      return null
    },
  })

  void hydrateInbox(context as unknown as Parameters<typeof hydrateInbox>[0], tracker)
  const interval = setInterval(
    () => void hydrateInbox(context as unknown as Parameters<typeof hydrateInbox>[0], tracker),
    INBOX_REFRESH_MS,
  )

  return {
    tracker,
    open,
    back,
    dispose: () => {
      clearInterval(interval)
      stopPermissionAsked()
      stopFormCreated()
      unregisterAppSlot()
      unregisterRoute()
    },
  }
}
