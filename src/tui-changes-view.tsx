import { Plugin } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { sanitizeTerminalText } from "./tui-preview"
import { truncateHead, truncatePath } from "./tui-helpers"
import {
  CHANGES_PAGE,
  DIFF_CONTEXT,
  LATEST_TURN_LABEL,
  boundPatch,
  changesDestination,
  changesNotice,
  changesScopeNote,
  createChangesFeed,
  failureLabel,
  formatFileDeltas,
  formatTotals,
  patchUnavailableText,
  patchWindow,
  statusMarker,
  statusWord,
  windowAround,
  type ChangeStatus,
  type ChangesState,
} from "./tui-changes"

function terminalWidth(context: Plugin.Context): number {
  const renderer = context.renderer as unknown as { width?: unknown }
  if (typeof renderer?.width === "number" && renderer.width > 0) return renderer.width
  return process.stdout.columns ?? 100
}

function terminalHeight(context: Plugin.Context): number {
  const renderer = context.renderer as unknown as { height?: unknown }
  if (typeof renderer?.height === "number" && renderer.height > 0) return renderer.height
  return process.stdout.rows ?? 32
}

function statusColor(theme: Plugin.Context["theme"], status: ChangeStatus): string {
  if (status === "added") return theme.text.feedback.info.base
  if (status === "deleted") return theme.text.feedback.warning.base
  if (status === "modified") return theme.hue.accent[200]
  return theme.text.muted
}

function patchLineColor(theme: Plugin.Context["theme"], line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.text.feedback.info.base
  if (line.startsWith("-") && !line.startsWith("---")) return theme.text.feedback.warning.base
  if (line.startsWith("@@")) return theme.hue.accent[200]
  if (line.startsWith("…")) return theme.text.muted
  return theme.text.base
}

function routeSessionID(context: Plugin.Context): string | undefined {
  const route = context.ui.router.current()
  if (route.type !== "plugin" || route.name !== CHANGES_PAGE) return undefined
  const value = route.data?.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isChangesPage(context: Plugin.Context): boolean {
  const route = context.ui.router.current()
  return route.type === "plugin" && route.name === CHANGES_PAGE
}

/** Navigate without opening or focusing a chat tab. */
export function openLatestTurnChanges(context: Plugin.Context, sessionID: string): void {
  context.ui.router.navigate(changesDestination(sessionID))
}

/** Keymap command for the existing Gangway list; caller supplies the selected ID. */
export function changesKeyCommand(
  context: Plugin.Context,
  selectedSessionID: () => string | undefined,
): { bind: string; title: string; run: () => void } {
  return {
    bind: "d",
    title: LATEST_TURN_LABEL,
    run: () => {
      const sessionID = selectedSessionID()
      if (sessionID) openLatestTurnChanges(context, sessionID)
    },
  }
}

function ChangesPage(props: {
  context: Plugin.Context
  sessionID?: string
  sessionsPage: string
}) {
  const context = props.context
  const theme = context.theme
  const [width, setWidth] = createSignal(terminalWidth(context))
  const [height, setHeight] = createSignal(terminalHeight(context))
  const [selected, setSelected] = createSignal(0)
  const [patchOpen, setPatchOpen] = createSignal(false)
  const [patchOffset, setPatchOffset] = createSignal(0)
  const feed = createChangesFeed({
    fetchDiff: (sessionID, signal) =>
      context.client.session.diff({ sessionID, context: DIFF_CONTEXT }, { signal }),
    hasTurn: async (sessionID, signal) => {
      const response = await context.client.message.list(
        { sessionID, limit: 1, order: "desc", type: "user" },
        { signal },
      )
      return response.data.length > 0
    },
    supportsDiff: async (sessionID) => {
      const info = context.data.session.get(sessionID)
      if (!info) return undefined
      try {
        await context.data.location.vcs.sync(info.location)
      } catch {
        return undefined
      }
      const vcs = context.data.location.vcs.info(info.location)
      if (!vcs) return undefined
      return vcs.provider === "git"
    },
  })
  const [state, setState] = createSignal<ChangesState>(feed.state())

  const session = createMemo<SessionInfo | undefined>(() =>
    props.sessionID ? context.data.session.get(props.sessionID) : undefined,
  )
  const directory = createMemo(() =>
    sanitizeTerminalText(
      context.ui.format.path(session()?.location.directory ?? state().location ?? "?"),
    ),
  )
  const title = createMemo(() => sanitizeTerminalText(session()?.title ?? "(session unavailable)"))
  const running = createMemo(() => {
    const id = props.sessionID
    if (!id) return false
    return state().running || context.data.session.status(id) === "running"
  })
  const notice = createMemo(() => changesNotice(state()))
  const totals = createMemo(() => formatTotals(state().totals))
  const files = () => state().files
  const selectedIndex = createMemo(() => Math.min(selected(), Math.max(0, files().length - 1)))
  const selectedFile = createMemo(() => files()[selectedIndex()])
  const patch = createMemo(() => boundPatch(selectedFile()?.patch))
  const listRows = createMemo(() => Math.max(3, height() - 12))
  const patchRows = createMemo(() => Math.max(3, height() - 11))
  const fileWindow = createMemo(() => windowAround(selectedIndex(), files().length, listRows()))
  const visibleFiles = createMemo(() => files().slice(fileWindow().start, fileWindow().end))
  const patchView = createMemo(() => patchWindow(patch().lines, patchOffset(), patchRows()))
  const pathWidth = createMemo(() => Math.max(12, width() - 30))
  const patchLineWidth = createMemo(() => Math.max(20, width() - 4))
  const showStateNote = createMemo(() => state().stale || state().locationChanged || state().loading)

  const move = (delta: number) => {
    if (patchOpen()) return
    const length = files().length
    if (length === 0) return
    setSelected(Math.min(length - 1, Math.max(0, selectedIndex() + delta)))
  }

  const openPatch = () => {
    if (!selectedFile()) return
    setPatchOffset(0)
    setPatchOpen(true)
  }

  const closePatch = () => {
    setPatchOpen(false)
    setPatchOffset(0)
  }

  const scrollPatch = (delta: number) => {
    if (!patchOpen()) return
    const window = patchWindow(patch().lines, patchOffset() + delta, patchRows())
    setPatchOffset(window.offset)
  }

  const stepOut = () => {
    if (patchOpen()) closePatch()
    else context.ui.router.navigate({ type: "plugin", name: props.sessionsPage })
  }

  const refresh = () => feed.refresh()

  onMount(() => {
    const measure = () => {
      setWidth(terminalWidth(context))
      setHeight(terminalHeight(context))
    }
    measure()
    process.stdout.on("resize", measure)
    const unsubscribe = feed.subscribe(setState)
    const id = props.sessionID
    let stopEvents: () => void = () => {}
    if (id) {
      const info = context.data.session.get(id)
      feed.open({
        sessionID: id,
        running: info ? context.data.session.status(id) === "running" : false,
        location: info?.location.directory,
      })
      const mine = (event: { data?: { sessionID?: string } }) => event.data?.sessionID === id
      const refreshFor = () => {
        feed.noteRunning(context.data.session.status(id) === "running")
        feed.noteLocation(context.data.session.get(id)?.location.directory)
        feed.scheduleRefresh()
      }
      const stops = [
        context.data.on("session.status", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.idle", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.execution.started", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.execution.succeeded", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.execution.failed", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.execution.interrupted", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.inbox.delivered", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.tool.success", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.tool.failed", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.revert.staged", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.revert.committed", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.revert.cleared", (event) => {
          if (mine(event)) refreshFor()
        }),
        context.data.on("session.moved", (event) => {
          if (!mine(event)) return
          feed.noteLocation(event.data.location.directory)
          feed.scheduleRefresh()
        }),
        context.data.on("session.deleted", (event) => {
          if (mine(event)) feed.noteGone()
        }),
      ]
      stopEvents = () => stops.forEach((stop) => stop())
    } else {
      feed.close()
    }
    onCleanup(() => {
      process.stdout.off("resize", measure)
      unsubscribe()
      stopEvents()
      feed.close()
    })
  })

  context.keymap.layer(() => ({
    enabled: () => isChangesPage(context),
    commands: [
      {
        bind: "return",
        title: patchOpen() ? "Patch open" : "Show patch",
        run: () => {
          if (!patchOpen()) openPatch()
        },
      },
      {
        bind: "up,k",
        title: patchOpen() ? "Scroll patch up" : "Previous file",
        run: () => (patchOpen() ? scrollPatch(-1) : move(-1)),
      },
      {
        bind: "down,j",
        title: patchOpen() ? "Scroll patch down" : "Next file",
        run: () => (patchOpen() ? scrollPatch(1) : move(1)),
      },
      {
        bind: "pageup",
        title: patchOpen() ? "Patch page up" : "Previous files",
        run: () => (patchOpen() ? scrollPatch(-patchRows()) : move(-listRows())),
      },
      {
        bind: "pagedown",
        title: patchOpen() ? "Patch page down" : "Next files",
        run: () => (patchOpen() ? scrollPatch(patchRows()) : move(listRows())),
      },
      {
        bind: "r",
        title: "Refresh latest turn changes",
        run: refresh,
      },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    enabled: () => isChangesPage(context) && context.keymap.mode.current() !== "modal",
    commands: [
      {
        bind: "escape",
        title: patchOpen() ? "Back to files" : "Back to Gangway sessions",
        run: stepOut,
      },
    ],
  }))

  const stateColor = () => {
    if (notice().kind === "error" || notice().kind === "stale") return theme.text.feedback.warning.base
    if (running()) return theme.text.feedback.info.base
    return theme.text.muted
  }

  return (
    <box width="100%" height="100%" backgroundColor={theme.background.base}>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="column">
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.text.base}>
            <b>{LATEST_TURN_LABEL}</b>
          </text>
          <text fg={theme.text.muted}>{patchOpen() ? "esc files" : "esc back"}</text>
        </box>
        <text fg={theme.text.base}>{truncateHead(title(), Math.max(20, width() - 4))}</text>
        <text fg={theme.text.muted}>{truncatePath(directory(), Math.max(12, width() - 4))}</text>
        <box flexDirection="row" gap={1}>
          <text fg={running() ? theme.text.feedback.info.base : theme.text.muted}>
            {running() ? "running" : "idle"}
          </text>
          <text fg={theme.text.muted}>{`· ${totals()}`}</text>
          <Show when={props.sessionID}>
            <text fg={theme.text.muted}>{`· ${props.sessionID}`}</text>
          </Show>
        </box>
        <text fg={theme.text.muted}>{changesScopeNote(running())}</text>
        <Show when={notice().message}>
          <text fg={stateColor()}>{truncateHead(notice().message, Math.max(20, width() - 4))}</text>
        </Show>
        <Show when={showStateNote() && state().failure && notice().kind !== "stale" && notice().kind !== "error"}>
          <text fg={theme.text.feedback.warning.base}>
            {truncateHead(`Last refresh failed: ${failureLabel(state().failure!)}`, Math.max(20, width() - 4))}
          </text>
        </Show>
        <Show when={state().locationChanged}>
          <text fg={theme.text.feedback.warning.base}>
            {truncateHead("Session location changed; refreshing the latest turn.", Math.max(20, width() - 4))}
          </text>
        </Show>
      </box>

      <box flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} flexDirection="column">
        <Show
          when={patchOpen()}
          fallback={
            <Show
              when={files().length > 0}
              fallback={
                <box flexGrow={1} minHeight={0}>
                  <Show when={notice().kind === "empty"} fallback={<text fg={theme.text.muted}>Waiting for a snapshot…</text>}>
                    <text fg={theme.text.muted}>{notice().message}</text>
                  </Show>
                </box>
              }
            >
              <box flexGrow={1} minHeight={0} flexDirection="column">
                <For each={visibleFiles()}>
                  {(file, index) => {
                    const row = () => fileWindow().start + index()
                    const active = () => row() === selectedIndex()
                    return (
                      <box
                        flexShrink={0}
                        flexDirection="row"
                        gap={1}
                        backgroundColor={active() ? theme.background.raised.high : undefined}
                      >
                        <box width={2} flexShrink={0}>
                          <text fg={statusColor(theme, file.status)}>{statusMarker(file.status)}</text>
                        </box>
                        <box flexGrow={1} minWidth={0}>
                          <text fg={theme.text.base}>
                            {truncatePath(sanitizeTerminalText(file.file), pathWidth())}
                          </text>
                        </box>
                        <box width={8} flexShrink={0}>
                          <text fg={theme.text.muted}>{statusWord(file.status)}</text>
                        </box>
                        <box width={12} flexShrink={0}>
                          <text fg={theme.text.muted}>{formatFileDeltas(file)}</text>
                        </box>
                      </box>
                    )
                  }}
                </For>
                <Show when={files().length > listRows()}>
                  <text fg={theme.text.muted}>
                    {`showing ${fileWindow().start + 1}–${fileWindow().end} of ${files().length} files`}
                  </text>
                </Show>
              </box>
            </Show>
          }
        >
          <box flexGrow={1} minHeight={0} flexDirection="column">
            <Show
              when={selectedFile()}
              fallback={<text fg={theme.text.feedback.warning.base}>The selected file is no longer in this snapshot.</text>}
            >
              {(file) => (
                <>
                  <box flexShrink={0} flexDirection="row" gap={1}>
                    <text fg={statusColor(theme, file().status)}>{statusMarker(file().status)}</text>
                    <text fg={theme.text.base}>
                      {truncatePath(sanitizeTerminalText(file().file), Math.max(12, width() - 24))}
                    </text>
                    <text fg={theme.text.muted}>{formatFileDeltas(file())}</text>
                  </box>
                  <Show when={!patch().available}>
                    <text fg={theme.text.muted}>{patchUnavailableText(patch().reason)}</text>
                  </Show>
                  <Show when={patch().truncated}>
                    <text fg={theme.text.feedback.warning.base}>
                      {patch().cue ?? "Patch display is truncated."}
                    </text>
                  </Show>
                  <Show when={patch().available}>
                    <text fg={theme.text.muted}>
                      {`lines ${patchView().start + 1}–${patchView().end} of ${patch().lines.length} · j/k scroll · esc files`}
                    </text>
                    <box flexGrow={1} minHeight={0} flexDirection="column">
                      <For each={patchView().lines}>
                        {(line) => (
                          <text fg={patchLineColor(theme, line)}>
                            {truncateHead(line, patchLineWidth())}
                          </text>
                        )}
                      </For>
                    </box>
                  </Show>
                </>
              )}
            </Show>
          </box>
        </Show>
      </box>

      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>
          {patchOpen()
            ? "j/k scroll · pgup/pgdn page · esc files · r refresh"
            : "j/k move · enter patch · r refresh · esc back"}
        </text>
      </box>
    </box>
  )
}

export interface ChangesViewHandle {
  readonly unregister: () => void
  readonly open: (sessionID: string) => void
}

/**
 * Register the standalone latest-turn changes route. The route carries the
 * pinned session ID in its data, fetches only while mounted, and never opens a
 * chat tab. Integrate by registering once from the TUI plugin setup and adding
 * `changesKeyCommand(context, () => selected()?.id)` to the Gangway list layer.
 */
export function registerChangesView(
  context: Plugin.Context,
  options: { readonly sessionsPage?: string } = {},
): ChangesViewHandle {
  const sessionsPage = options.sessionsPage ?? "gangway.sessions"
  const unregister = context.ui.router.register({
    name: CHANGES_PAGE,
    render: (input) => {
      const value = input.data?.sessionID
      const sessionID = typeof value === "string" && value.length > 0 ? value : routeSessionID(context)
      return <ChangesPage context={context} sessionID={sessionID} sessionsPage={sessionsPage} />
    },
  })
  return {
    unregister,
    open: (sessionID) => openLatestTurnChanges(context, sessionID),
  }
}
