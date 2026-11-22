import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  DEFAULT_USAGE_CAPS,
  UsageAbortedError,
  UsageCache,
  formatCost,
  formatNumber,
  formatTokenFields,
  loadUsage,
  usageBar,
  type UsageBreakdown,
  type UsageClient,
  type UsageProgress,
  type UsageRangeDays,
  type UsageScope,
  type UsageSummary,
} from "./tui-usage"
import { truncateHead, truncatePath } from "./tui-helpers"

// The Usage page is a self-contained feature module: `registerUsageFeature`
// owns its route, `u` command and cleanup, so integrating it does not require
// touching the live Stats page. The integration pass only needs to call
// `registerUsageFeature(context)` once (or load `tui-usage-plugin.tsx`).

export const USAGE_PAGE = "gangway.usage"

const DEBOUNCE_MS = 250
const MODEL_WIDTH = 34
const PATH_WIDTH = 40
const COMPACT_WIDTH = 96

function terminalWidth(context: Plugin.Context): number {
  const renderer = context.renderer as unknown as { width?: unknown }
  if (typeof renderer?.width === "number" && renderer.width > 0) return renderer.width
  return process.stdout.columns ?? 100
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const REASON_LABELS: Record<string, string> = {
  "session-page-cap": "session page cap",
  "session-list-failed": "session list failed",
  "message-page-cap": "history page cap",
  "message-list-failed": "history fetch failed",
  "fork-history-unverified": "fork attribution incomplete",
  "no-directory-scope": "no current directory",
}

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason
}

interface UsagePrefs {
  range: UsageRangeDays
  scope: UsageScope
  bars: boolean
}

export interface UsageFeatureOptions {
  /** Global key binding for the page. Defaults to `u`; `false` disables it. */
  readonly bind?: string | false
  /** Adds a slash command; defaults to `gangway-usage`. */
  readonly slashName?: string
  /**
   * Limits the key binding and palette entry to a context where single-key
   * typing is not owned by a prompt editor. The standalone plugin leaves this
   * unset; the Gangway panel binds `u` on its own page only.
   */
  readonly enabled?: () => boolean
}

export function registerUsageFeature(
  context: Plugin.Context,
  options: UsageFeatureOptions = {},
): () => void {
  const [previous, setPrevious] = createSignal(context.ui.router.current())

  const back = () => {
    const target = previous()
    if (target.type === "session" && !context.data.session.get(target.sessionID)) {
      context.ui.router.navigate({ type: "home" })
      return
    }
    context.ui.router.navigate(target)
  }

  const cache = new UsageCache()
  const unregisterRoute = context.ui.router.register({
    name: USAGE_PAGE,
    render: () => <UsagePage context={context} onBack={back} cache={cache} />,
  })

  const openUsage = () => {
    const current = context.ui.router.current()
    if (current.type === "plugin" && current.name === USAGE_PAGE) return
    setPrevious({ ...current })
    context.ui.dialog.clear()
    context.ui.router.navigate({ type: "plugin", name: USAGE_PAGE })
  }

  const bind = options.bind ?? "u"
  const unregisterSlot = context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({
        mode: "global",
        enabled: options.enabled,
        commands: [
          {
            id: "gangway.usage",
            title: "Gangway usage",
            group: "Gangway",
            bind,
            palette: true,
            slash: { name: options.slashName ?? "gangway-usage" },
            run: openUsage,
          },
        ],
      }))
      return null
    },
  })

  return () => {
    unregisterRoute()
    unregisterSlot()
  }
}

export function UsagePage(props: {
  context: Plugin.Context
  onBack: () => void
  /** Optional feature-lifetime cache so range revisits reuse a complete scan. */
  cache?: UsageCache
}) {
  const context = props.context
  const theme = context.theme
  const cache = props.cache ?? new UsageCache()
  const [prefs, updatePrefs] = context.storage.store<UsagePrefs>("usage", {
    initial: { range: 7, scope: "all", bars: true },
  })
  const [summary, setSummary] = createSignal<UsageSummary>()
  const [status, setStatus] = createSignal<"idle" | "loading" | "ready" | "error">("idle")
  const [error, setError] = createSignal<string>()
  const [progress, setProgress] = createSignal<UsageProgress>()
  const [width, setWidth] = createSignal(terminalWidth(context))

  const range = (): UsageRangeDays => (prefs.range === 30 ? 30 : 7)
  const scope = (): UsageScope => (prefs.scope === "current" ? "current" : "all")
  const directory = createMemo(() => context.location?.directory ?? context.data.location.default().directory)
  const compact = () => width() < COMPACT_WIDTH
  const barWidth = () => (compact() ? 0 : Math.max(0, Math.min(18, width() - 78)))

  let requestID = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  const invalidateLoad = () => {
    requestID += 1
    controller?.abort()
    controller = undefined
  }

  const runLoad = async (force: boolean) => {
    const request = ++requestID
    controller?.abort()
    controller = new AbortController()
    const current = controller
    setStatus("loading")
    setError(undefined)
    try {
      const result = await loadUsage({
        client: context.client as unknown as UsageClient,
        range: range(),
        scope: scope(),
        directory: scope() === "current" ? directory() : undefined,
        now: Date.now(),
        caps: DEFAULT_USAGE_CAPS,
        cache,
        force,
        signal: current.signal,
        onProgress: (value) => {
          if (disposed || request !== requestID) return
          setProgress(value)
        },
      })
      if (disposed || request !== requestID) return
      setSummary(result)
      setStatus("ready")
    } catch (caught) {
      if (disposed || request !== requestID || caught instanceof UsageAbortedError) return
      setError(errorText(caught))
      setStatus("error")
    }
  }

  const scheduleLoad = (force = false, delay = DEBOUNCE_MS, reset = false) => {
    if (timer) clearTimeout(timer)
    if (reset) {
      // Invalidate immediately so an older in-flight range cannot land after
      // the setting changed, then debounce the new scan.
      invalidateLoad()
      setProgress(undefined)
      setSummary(undefined)
      setStatus("loading")
      setError(undefined)
    }
    timer = setTimeout(() => {
      timer = undefined
      void runLoad(force)
    }, delay)
  }

  const switchRange = (next: UsageRangeDays) => {
    if (next === range()) return
    void updatePrefs((draft) => {
      draft.range = next
    })
    scheduleLoad(false, DEBOUNCE_MS, true)
  }

  const switchScope = () => {
    void updatePrefs((draft) => {
      draft.scope = draft.scope === "current" ? "all" : "current"
    })
    scheduleLoad(false, DEBOUNCE_MS, true)
  }

  const toggleBars = () => {
    void updatePrefs((draft) => {
      draft.bars = !draft.bars
    })
  }

  onMount(() => {
    const measure = () => setWidth(terminalWidth(context))
    measure()
    process.stdout.on("resize", measure)
    scheduleLoad(false, 0)
    onCleanup(() => {
      disposed = true
      requestID += 1
      controller?.abort()
      if (timer) clearTimeout(timer)
      process.stdout.off("resize", measure)
    })
  })

  context.keymap.layer(() => ({
    commands: [
      { bind: "1", title: "Usage: 7 days", run: () => switchRange(7) },
      { bind: "2", title: "Usage: 30 days", run: () => switchRange(30) },
      {
        bind: "d",
        title: scope() === "current" ? "Usage: all directories" : "Usage: current directory",
        run: switchScope,
      },
      { bind: "b", title: prefs.bars ? "Usage: hide bars" : "Usage: show bars", run: toggleBars },
      { bind: "r", title: "Usage: refresh", run: () => {
        invalidateLoad()
        scheduleLoad(true, 0)
      } },
    ],
  }))

  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    enabled: () => context.keymap.mode.current() !== "modal",
    commands: [{ bind: "escape", title: "Back", run: props.onBack }],
  }))

  const data = () => summary()
  const totals = () => data()?.totals
  const maxDayCost = createMemo(() => {
    const values = data()?.days.map((day) => day.cost).filter((value): value is number => value !== undefined) ?? []
    return values.length > 0 ? Math.max(...values) : undefined
  })
  const scopeLabel = () => (scope() === "current" ? "current directory" : "all directories")
  const windowLabel = () => {
    const current = data()
    if (!current) return ""
    const start = new Date(current.window.start)
    const last = new Date(current.window.end - 1)
    const format = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`
    return `${format(start)}–${format(last)} local`
  }
  const coverageNote = createMemo(() => {
    const current = data()
    if (!current) return undefined
    const coverage = current.coverage
    const scanned = `scanned ${formatNumber(coverage.scannedSessions)} sessions · ${formatNumber(coverage.messagePages)} message pages`
    if (coverage.partial) {
      const reasons = coverage.reasons.map(reasonLabel).join(", ") || "partial scan"
      return `partial: ${reasons} · ${scanned}`
    }
    return `complete · ${scanned}`
  })
  const statusNote = createMemo(() => {
    if (status() === "loading") {
      const value = progress()
      if (!value || value.totalSessions === 0) return "scanning Gangway roots…"
      return `scanning ${formatNumber(value.scannedSessions)}/${formatNumber(value.totalSessions)} sessions…`
    }
    if (status() === "error") {
      return data() ? `load failed (${error() ?? "unknown"}); showing previous scan` : `load failed: ${error() ?? "unknown"}`
    }
    return undefined
  })

  const BreakdownRow = (item: UsageBreakdown, kind: "model" | "directory") => {
    const label =
      kind === "directory"
        ? truncatePath(context.ui.format.path(item.key), compact() ? 26 : PATH_WIDTH)
        : truncateHead(item.key, compact() ? 24 : MODEL_WIDTH)
    return (
      <box flexShrink={0} flexDirection="column" paddingLeft={2}>
        <text fg={theme.text.base}>{label}</text>
        <text fg={theme.text.muted}>
          {`${formatCost(item.cost)} · ${formatTokenFields(item.tokens)} · ${formatNumber(item.steps)} steps`}
        </text>
      </box>
    )
  }

  return (
    <box width="100%" height="100%" backgroundColor={theme.background.base}>
      <box
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        gap={1}
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base}>
            <b>Gangway usage</b>
          </text>
          <text fg={theme.text.muted}>{`${range()}d`}</text>
          <text fg={theme.text.muted}>{scopeLabel()}</text>
        </box>
        <text fg={theme.text.muted}>{windowLabel()}</text>
      </box>

      <box flexShrink={0} paddingLeft={2} paddingRight={2} flexDirection="column">
        <text fg={theme.text.muted}>
          Gangway root sessions · assistant-step usage · title/compaction/child excluded
        </text>
        <text fg={theme.text.muted}>directory = owning session's directory · ranges are local half-open days</text>
        <Show when={statusNote()}>
          {(note) => (
            <text fg={status() === "error" ? theme.text.feedback.warning.base : theme.text.muted}>{note()}</text>
          )}
        </Show>
        <Show when={coverageNote()}>
          {(note) => (
            <text fg={data()?.coverage.partial ? theme.text.feedback.warning.base : theme.text.muted}>{note()}</text>
          )}
        </Show>
      </box>

      <Show
        when={totals()}
        fallback={
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={theme.text.muted}>
              {status() === "idle"
                ? "Select a range to scan recorded usage."
                : status() === "loading"
                  ? "Scanning Gangway usage…"
                  : "No recorded Gangway usage yet."}
            </text>
          </box>
        }
      >
        {(value) => (
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="column">
            <text fg={theme.text.base}>
              {`cost ${formatCost(value().cost)} · ${formatNumber(value().steps)} assistant steps`}
            </text>
            <text fg={theme.text.muted}>{formatTokenFields(value().tokens)}</text>
            <text fg={theme.text.muted}>
              {`total ${formatNumber(value().totalTokens)} tokens · cost measured ${formatNumber(value().measuredCostSteps)} steps · tokens measured ${formatNumber(value().measuredTokenSteps)} steps`}
            </text>
          </box>
        )}
      </Show>

      <scrollbox flexGrow={1} minHeight={0}>
        <Show when={data()} fallback={null}>
          {(value) => (
            <>
              <box flexShrink={0} paddingLeft={2} paddingTop={1}>
                <text fg={theme.text.base}>
                  <b>Daily</b>
                </text>
              </box>
              <For each={value().days}>
                {(day) => (
                  <box flexShrink={0} flexDirection="column" paddingLeft={2}>
                    <box flexDirection="row" gap={1}>
                      <box width={6} flexShrink={0}>
                        <text fg={theme.text.muted}>{day.label}</text>
                      </box>
                      <Show when={prefs.bars && barWidth() > 0}>
                        <box width={barWidth()} flexShrink={0}>
                          <text fg={theme.text.feedback.info.base}>
                            {usageBar(day.cost, maxDayCost(), barWidth())}
                          </text>
                        </box>
                      </Show>
                      <text fg={theme.text.base}>
                        {`${formatCost(day.cost)} · ${formatNumber(day.steps)} steps`}
                      </text>
                    </box>
                    <text fg={theme.text.muted}>{formatTokenFields(day.tokens)}</text>
                  </box>
                )}
              </For>

              <box flexShrink={0} paddingLeft={2} paddingTop={1}>
                <text fg={theme.text.base}>
                  <b>Top models</b>
                </text>
              </box>
              <Show
                when={value().models.length > 0}
                fallback={
                  <box paddingLeft={2}>
                    <text fg={theme.text.muted}>No recorded model usage.</text>
                  </box>
                }
              >
                <For each={value().models.slice(0, 5)}>{(item) => BreakdownRow(item, "model")}</For>
              </Show>

              <box flexShrink={0} paddingLeft={2} paddingTop={1}>
                <text fg={theme.text.base}>
                  <b>Top directories</b>
                </text>
              </box>
              <Show
                when={value().directories.length > 0}
                fallback={
                  <box paddingLeft={2}>
                    <text fg={theme.text.muted}>No recorded directory usage.</text>
                  </box>
                }
              >
                <For each={value().directories.slice(0, 5)}>{(item) => BreakdownRow(item, "directory")}</For>
              </Show>
            </>
          )}
        </Show>
      </scrollbox>

      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted}>
          {"1 7d · 2 30d · d scope · b bars · r refresh · esc back"}
        </text>
      </box>
    </box>
  )
}
