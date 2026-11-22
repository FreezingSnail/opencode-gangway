import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import {
  createDispatchRequestGate,
  describeDispatchDetails,
  loadDispatchIfCurrent,
  type DispatchLine,
  type DispatchRpcClient,
  type DispatchTone,
  type DispatchView,
} from "./tui-dispatch"

// Standalone dispatch-details route for the Gangway list. Integration calls
// registerDispatchRoute(context) once in the TUI plugin setup and adds
// dispatchKeyCommand(context, () => selected()?.id) to the list keymap. The
// route reads records only; live status comes from the host's shared store.

export const DISPATCH_PAGE = "gangway.dispatch"

export function openDispatch(context: Plugin.Context, sessionID: string): void {
  const directory = context.data.session.get(sessionID)?.location.directory
  context.ui.router.navigate({
    type: "plugin",
    name: DISPATCH_PAGE,
    data: { sessionID, ...(directory ? { directory } : {}) },
  })
}

/**
 * Keymap command for the existing Gangway list. The caller supplies the
 * currently selected session ID; `o` opens the pinned details route.
 */
export function dispatchKeyCommand(
  context: Plugin.Context,
  selectedSessionID: () => string | undefined,
): { readonly bind: string; readonly title: string; readonly group: string; readonly run: () => void } {
  return {
    bind: "o",
    title: "Dispatch details",
    group: "Gangway",
    run: () => {
      const sessionID = selectedSessionID()
      if (sessionID) openDispatch(context, sessionID)
    },
  }
}

function toneColor(theme: Plugin.Context["theme"], tone: DispatchTone): string {
  if (tone === "warning") return theme.text.feedback.warning.base
  if (tone === "info") return theme.text.feedback.info.base
  if (tone === "muted") return theme.text.muted
  return theme.text.base
}

function DispatchPage(props: {
  readonly context: Plugin.Context
  readonly sessionID?: string
  readonly directory?: string
  readonly onBack?: () => void
}) {
  const context = props.context
  const theme = context.theme
  const gate = createDispatchRequestGate()
  const [view, setView] = createSignal<DispatchView>()
  let controller: AbortController | undefined
  let active = true

  const session = () => (props.sessionID ? context.data.session.get(props.sessionID) : undefined)
  const live = (): "idle" | "running" | "unavailable" => {
    const id = props.sessionID
    if (!id || !session()) return "unavailable"
    return context.data.session.status(id)
  }

  const load = () => {
    const sessionID = props.sessionID
    if (!sessionID) {
      setView(undefined)
      return
    }
    controller?.abort()
    controller = new AbortController()
    setView(undefined)
    const location = session()?.location ?? (props.directory ? { directory: props.directory } : undefined)
    const client = context.client as unknown as DispatchRpcClient
    void loadDispatchIfCurrent(gate, client, { sessionID }, location, controller.signal).then((result) => {
      if (active && result) setView(result)
    })
  }

  const back = () => {
    gate.invalidate()
    controller?.abort()
    if (props.onBack) props.onBack()
    else if (context.ui.router.current().type === "plugin") {
      context.ui.router.navigate({ type: "plugin", name: "gangway.sessions" })
    }
  }

  const pageActive = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === DISPATCH_PAGE
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    enabled: () => pageActive() && context.keymap.mode.current() !== "modal",
    commands: [
      {
        bind: "r",
        title: "Refresh dispatch details",
        run: load,
      },
      {
        bind: "escape",
        title: "Back",
        run: back,
      },
    ],
  }))

  onMount(() => {
    load()
    onCleanup(() => {
      active = false
      gate.invalidate()
      controller?.abort()
    })
  })

  const lines = (): DispatchLine[] => {
    const sessionID = props.sessionID
    if (!sessionID) return [{ text: "No session selected.", tone: "muted" }]
    return describeDispatchDetails({
      view: view(),
      pinnedSessionID: sessionID,
      currentSessionID: sessionID,
      live: live(),
      ...(session()?.time.updated ? { liveUpdatedAt: session()!.time.updated } : {}),
    })
  }

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background.base}>
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={theme.text.base}>
          <b>Dispatch details</b>
        </text>
        <text fg={theme.text.muted}>{props.sessionID ?? "no session"}</text>
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2}>
        <Show when={session()} fallback={<text fg={theme.text.muted}>Session no longer available.</text>}>
          {(info) => (
            <text fg={theme.text.muted}>
              {`${info().title ?? "(untitled)"} · ${context.ui.format.path(info().location.directory)}`}
            </text>
          )}
        </Show>
      </box>
      <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <For each={lines()}>
          {(line) => (
            <text fg={toneColor(theme, line.tone)}>{line.text}</text>
          )}
        </For>
      </scrollbox>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>recorded delivery is not current chat state · r refresh · esc back</text>
      </box>
    </box>
  )
}

/**
 * Register the standalone dispatch route. Integration calls this once from the
 * TUI plugin setup; the returned cleanup unregisters it.
 */
export function registerDispatchRoute(
  context: Plugin.Context,
  options: { readonly onBack?: () => void } = {},
): () => void {
  return context.ui.router.register({
    name: DISPATCH_PAGE,
    render: (input) => {
      const sessionID = typeof input.data?.sessionID === "string" ? input.data.sessionID : undefined
      const directory = typeof input.data?.directory === "string" ? input.data.directory : undefined
      return (
        <DispatchPage
          context={context}
          sessionID={sessionID}
          directory={directory}
          onBack={options.onBack}
        />
      )
    },
  })
}
