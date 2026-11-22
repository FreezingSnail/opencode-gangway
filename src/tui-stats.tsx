import type { Plugin } from "@opencode/plugin/tui"
import type { PermissionRequest, SessionInfo } from "@opencode/client"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  LIVE_BUCKET_LABELS,
  STATS_OUTCOME_LABELS,
  bucketCountsLabel,
  buildStatsSnapshot,
  drilldown,
  liveBucket,
  observedAgeLabel,
  type LiveBucket,
  type ObservedAt,
  type StatsFilter,
  type StatsScope,
  type StatsSession,
} from "./stats"
import {
  classifyNeedsInput,
  isGangwaySession,
  truncateHead,
  truncatePath,
  type NeedsInput,
} from "./tui-helpers"

// Feature-local Gangway Stats page. Integration owns exactly two calls:
//
//   const stats = createGangwayStats(context, { historyLimit: LIST_LIMIT, onRefresh: hydrate })
//   // ...later, from SessionsPage:
//   stats.open({ directory: directory() })
//
// `open` captures the current plugin route (the Gangway list) as the return
// context, so Escape on the Stats overview goes back exactly one level to the
// list. Closing the page calls an explicit `onClose` override when supplied;
// otherwise it navigates to that captured route (or `returnTo`).

export const STATS_PAGE = "gangway.stats"

/** Suggested binding for the existing Gangway sessions panel. */
export const STATS_SHORTCUT = "s"

const REFRESH_MS = 15_000
const DIRECTORY_WIDTH = 46
const ROW_LIMIT = 5

export type StatsReturnRoute =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | {
      readonly type: "plugin"
      readonly id?: string
      readonly name: string
      readonly data?: Record<string, any>
    }

export interface StatsOpenOptions {
  /** Caller's directory, used by the "current directory" scope. */
  readonly directory?: string
  /** Route to restore when the page closes; defaults to the route captured at open time. */
  readonly returnTo?: StatsReturnRoute
  /** Override the default one-level return (for example, a caller-owned back helper). */
  readonly onClose?: () => void
}

export interface GangwayStatsOptions {
  /** Hydration cap the caller used, shown as the loaded-history scope. */
  readonly historyLimit?: number
  /** Existing store hydration sweep, invoked by `r`. */
  readonly onRefresh?: () => void
  readonly now?: () => number
}

export interface GangwayStatsFeature {
  readonly page: string
  open(options?: StatsOpenOptions): void
  dispose(): void
}

interface StatsRouteData {
  readonly directory?: string
  readonly returnTo?: StatsReturnRoute
}

interface StatsObservations {
  permissionAskedAt(): Readonly<Record<string, number>>
  formCreatedAt(): Readonly<Record<string, number>>
  executionStartedAt(): Readonly<Record<string, number>>
  firstSeen(key: string): number | undefined
  noteFirstSeen(key: string, at: number): void
  clearFirstSeen(key: string): void
}

type Tone = "warning" | "accent" | "info" | "muted" | "base"

interface StatsRow {
  readonly key: string
  readonly label: string
  readonly detail: string
  readonly filter?: StatsFilter
  readonly sessionID?: string
  readonly tone: Tone
}

interface StatsSection {
  readonly key: string
  readonly title: string
  readonly note?: string
  readonly rows: readonly StatsRow[]
}

function emptyRecord(): Record<string, number> {
  return {}
}

function withEntry(record: Readonly<Record<string, number>>, key: string, at: number): Record<string, number> {
  if (record[key] === at) return record as Record<string, number>
  return { ...record, [key]: at }
}

function withoutEntry(record: Readonly<Record<string, number>>, key: string): Record<string, number> {
  if (!(key in record)) return record as Record<string, number>
  const next = { ...record }
  delete next[key]
  return next
}

function pendingIDs(permissions: readonly PermissionRequest[] | undefined, forms: readonly { id: string }[] | undefined): string[] {
  const ids: string[] = []
  for (const permission of permissions ?? []) ids.push(permission.id)
  for (const form of forms ?? []) ids.push(form.id)
  return ids
}

function observedWait(
  sessionID: string,
  permissions: readonly PermissionRequest[] | undefined,
  forms: readonly { id: string }[] | undefined,
  observations: StatsObservations,
): ObservedAt | undefined {
  const asked = observations.permissionAskedAt()
  const created = observations.formCreatedAt()
  let oldest: number | undefined
  for (const id of pendingIDs(permissions, forms)) {
    const at = asked[id] ?? created[id]
    if (at !== undefined && Number.isFinite(at) && at > 0) {
      if (oldest === undefined || at < oldest) oldest = at
    }
  }
  if (oldest !== undefined) return { at: oldest, source: "event" }
  const seen = observations.firstSeen(`wait:${sessionID}`)
  return seen === undefined ? undefined : { at: seen, source: "first-seen" }
}

function observedRun(
  sessionID: string,
  observations: StatsObservations,
): ObservedAt | undefined {
  const at = observations.executionStartedAt()[sessionID]
  if (at !== undefined && Number.isFinite(at) && at > 0) return { at, source: "event" }
  const seen = observations.firstSeen(`run:${sessionID}`)
  return seen === undefined ? undefined : { at: seen, source: "first-seen" }
}

function idleAge(session: StatsSession, now: number): string {
  if (session.idleAt === undefined) return "idle time unknown"
  return observedAgeLabel({ at: session.idleAt, source: "event" }, now)
}

function sessionDetail(session: StatsSession, now: number, directory: string): string {
  const partial = session.attentionKnown ? "" : " · attention partial"
  if (session.bucket === "permission" || session.bucket === "question") {
    return `${LIVE_BUCKET_LABELS[session.bucket]} · wait ${observedAgeLabel(session.wait, now)} · ${directory}${partial}`
  }
  if (session.bucket === "running") {
    return `Running · ${observedAgeLabel(session.run, now)} · ${directory}${partial}`
  }
  if (session.outcome === undefined) return `Idle · outcome unknown · ${directory}${partial}`
  return `Idle · ${STATS_OUTCOME_LABELS[session.outcome]} · ${idleAge(session, now)} · ${directory}${partial}`
}

function StatsPage(props: {
  context: Plugin.Context
  open: StatsRouteData
  close: () => void
  observations: StatsObservations
  historyLimit?: number
  onRefresh?: () => void
  now: () => number
}) {
  const context = props.context
  const theme = context.theme
  const [scope, setScope] = createSignal<StatsScope>("all")
  const [drill, setDrill] = createSignal<StatsFilter>()
  const [selection, setSelection] = createSignal<{ key?: string; index: number }>({ index: 0 })
  const [overviewKey, setOverviewKey] = createSignal<string>()
  const [now, setNow] = createSignal(props.now())

  const directory = createMemo(
    () =>
      props.open.directory ??
      context.location?.directory ??
      context.data.location.default().directory,
  )

  const sessions = createMemo(() =>
    context.data.session.list().filter((session) => isGangwaySession(session) && !session.parentID),
  )

  const permissionsOf = (session: SessionInfo): PermissionRequest[] | undefined =>
    context.data.session.permission.list(session.id) as PermissionRequest[] | undefined
  const formsOf = (session: SessionInfo) =>
    context.data.session.form.list(session.id, session.location)
  const runningOf = (session: SessionInfo) => context.data.session.status(session.id) === "running"
  const attentionOf = (session: SessionInfo): NeedsInput | undefined =>
    classifyNeedsInput({ permissions: permissionsOf(session), forms: formsOf(session) })

  // Record first sightings for waits/runs that arrived without a live event.
  // Clearing on state exit means a later run/wait gets a fresh sighting.
  createEffect(() => {
    const at = Date.now()
    for (const session of sessions()) {
      const permissions = permissionsOf(session)
      const forms = formsOf(session)
      const needs = classifyNeedsInput({ permissions, forms })
      const bucket = liveBucket(runningOf(session), needs?.kind)
      const waitKey = `wait:${session.id}`
      const runKey = `run:${session.id}`
      if (bucket === "permission" || bucket === "question") props.observations.noteFirstSeen(waitKey, at)
      else props.observations.clearFirstSeen(waitKey)
      if (bucket === "running") props.observations.noteFirstSeen(runKey, at)
      else props.observations.clearFirstSeen(runKey)
    }
  })

  const snapshot = createMemo(() =>
    buildStatsSnapshot({
      now: now(),
      scope: scope(),
      currentDirectory: directory(),
      ...(props.historyLimit === undefined ? {} : { historyLimit: props.historyLimit }),
      sessions: sessions().map((session) => {
        const permissions = permissionsOf(session)
        const forms = formsOf(session)
        const needs = classifyNeedsInput({ permissions, forms })
        const running = runningOf(session)
        const wait = observedWait(session.id, permissions, forms, props.observations)
        const run = observedRun(session.id, props.observations)
        return {
          session,
          running,
          ...(needs === undefined ? {} : { attention: needs.kind }),
          attentionKnown: permissions !== undefined && forms !== undefined,
          ...(wait === undefined ? {} : { wait }),
          ...(run === undefined ? {} : { run }),
        }
      }),
    }),
  )

  const toneColor = (tone: Tone): string => {
    if (tone === "warning") return theme.text.feedback.warning.base
    if (tone === "accent") return theme.hue.accent[200]
    if (tone === "info") return theme.text.feedback.info.base
    if (tone === "muted") return theme.text.muted
    return theme.text.base
  }

  const bucketTone = (bucket: LiveBucket): Tone => {
    if (bucket === "permission") return "warning"
    if (bucket === "question") return "accent"
    if (bucket === "running") return "info"
    return "muted"
  }

  const outcomeTone = (outcome: "succeeded" | "failed" | "interrupted"): Tone => {
    if (outcome === "failed") return "warning"
    if (outcome === "interrupted") return "accent"
    return "info"
  }

  const overviewSections = createMemo<StatsSection[]>(() => {
    const snap = snapshot()
    const scopeLabel = snap.scopeLabel
    const live: StatsRow[] = snap.buckets.map((row) => ({
      key: `bucket:${row.bucket}`,
      label: `${row.label} · ${row.count}`,
      detail: `${row.count} ${row.count === 1 ? "session" : "sessions"} · ${scopeLabel}`,
      filter: { kind: "bucket", bucket: row.bucket },
      tone: bucketTone(row.bucket),
    }))
    const directories: StatsRow[] = snap.directories.map((row) => ({
      key: `directory:${row.directory}`,
      label: truncatePath(context.ui.format.path(row.directory), DIRECTORY_WIDTH),
      detail: `${row.total} · ${bucketCountsLabel(row.counts)} · ${scopeLabel}`,
      filter: { kind: "directory", directory: row.directory },
      tone: "base" as Tone,
    }))
    const waits: StatsRow[] = snap.waits.slice(0, ROW_LIMIT).map((session) => ({
      key: `wait:${session.id}`,
      label: truncateHead(session.title, 60),
      detail: `${LIVE_BUCKET_LABELS[session.bucket]} · wait ${observedAgeLabel(session.wait, now())} · ${truncatePath(context.ui.format.path(session.directory), 32)}${session.attentionKnown ? "" : " · attention partial"}`,
      sessionID: session.id,
      tone: bucketTone(session.bucket),
    }))
    const active: StatsRow[] = snap.active.slice(0, ROW_LIMIT).map((session) => ({
      key: `active:${session.id}`,
      label: truncateHead(session.title, 60),
      detail: `Running · ${observedAgeLabel(session.run, now())} · ${truncatePath(context.ui.format.path(session.directory), 32)}${session.attentionKnown ? "" : " · attention partial"}`,
      sessionID: session.id,
      tone: "info" as Tone,
    }))
    const recent: StatsRow[] = snap.recent.map((row) => ({
      key: `outcome:${row.outcome}`,
      label: `${row.label} · ${row.count}`,
      detail: `${row.count} ${row.count === 1 ? "session" : "sessions"} · past 24h · ${scopeLabel}`,
      filter: { kind: "outcome", outcome: row.outcome },
      tone: outcomeTone(row.outcome),
    }))

    const sections: StatsSection[] = [
      { key: "live", title: "Live states", rows: live },
      {
        key: "directories",
        title: "Directories",
        ...(directories.length === 0 ? { note: "None in this scope." } : {}),
        rows: directories,
      },
    ]
    if (waits.length > 0) {
      sections.push({
        key: "waits",
        title:
          snap.waits.length > ROW_LIMIT
            ? `Oldest waits · top ${ROW_LIMIT} of ${snap.waits.length}`
            : "Oldest waits",
        rows: waits,
      })
    }
    if (active.length > 0) {
      sections.push({
        key: "active",
        title:
          snap.active.length > ROW_LIMIT
            ? `Longest active runs · top ${ROW_LIMIT} of ${snap.active.length}`
            : "Longest active runs",
        rows: active,
      })
    }
    sections.push({ key: "recent", title: "Recent outcomes · past 24h", rows: recent })
    return sections
  })

  const overviewRows = createMemo(() => overviewSections().flatMap((section) => section.rows))

  const drillSessions = createMemo(() => {
    const filter = drill()
    if (!filter) return undefined
    return drilldown(snapshot(), filter)
  })

  const drillRows = createMemo<StatsRow[]>(() => {
    const detail = drillSessions()
    if (!detail) return []
    return detail.sessions.map((session) => ({
      key: `session:${session.id}`,
      label: truncateHead(session.title, 72),
      detail: sessionDetail(session, now(), context.ui.format.path(session.directory)),
      sessionID: session.id,
      tone: bucketTone(session.bucket),
    }))
  })

  const rows = createMemo<readonly StatsRow[]>(() => (drill() ? drillRows() : overviewRows()))

  const selectedIndex = createMemo(() => {
    const list = rows()
    const current = selection()
    if (current.key !== undefined) {
      const index = list.findIndex((row) => row.key === current.key)
      if (index >= 0) return index
    }
    return Math.min(current.index, Math.max(0, list.length - 1))
  })

  const selectedRow = createMemo(() => rows()[selectedIndex()])

  const select = (index: number) => {
    const list = rows()
    if (list.length === 0) {
      setSelection({ index: 0 })
      return
    }
    const next = Math.min(Math.max(0, index), list.length - 1)
    setSelection({ key: list[next]?.key, index: next })
  }

  const move = (delta: number) => select(selectedIndex() + delta)

  const openSession = (sessionID: string) => {
    context.ui.router.navigate({ type: "session", sessionID })
  }

  const activate = () => {
    const row = selectedRow()
    if (!row) return
    if (row.sessionID) {
      openSession(row.sessionID)
      return
    }
    if (row.filter) {
      setOverviewKey(row.key)
      setDrill(row.filter)
      setSelection({ index: 0 })
    }
  }

  const back = () => {
    if (drill()) {
      setDrill(undefined)
      const key = overviewKey()
      setSelection(key === undefined ? { index: 0 } : { key, index: 0 })
      return
    }
    props.close()
  }

  const switchScope = (next: StatsScope) => {
    if (scope() === next) return
    setScope(next)
    setDrill(undefined)
    setSelection({ index: 0 })
  }

  onMount(() => {
    const ticker = setInterval(() => setNow(props.now()), REFRESH_MS)
    onCleanup(() => clearInterval(ticker))
  })

  context.keymap.layer(() => ({
    commands: [
      {
        bind: "return",
        title: drill() ? "Open session" : "Open rows",
        run: activate,
      },
      {
        bind: "up,k",
        title: "Previous row",
        run: () => move(-1),
      },
      {
        bind: "down,j",
        title: "Next row",
        run: () => move(1),
      },
      {
        bind: "a",
        title: "Scope: all directories",
        run: () => switchScope("all"),
      },
      {
        bind: "c",
        title: "Scope: current directory",
        run: () => switchScope("current"),
      },
      ...(props.onRefresh === undefined
        ? []
        : [
            {
              bind: "r",
              title: "Refresh sessions",
              run: () => props.onRefresh?.(),
            },
          ]),
    ],
  }))

  // Escape returns one level: drilldown -> overview, overview -> the caller.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    enabled: () => context.keymap.mode.current() !== "modal",
    commands: [{ bind: "escape", title: drill() ? "Back to stats" : "Back", run: back }],
  }))

  const liveStrip = createMemo(() => {
    const snap = snapshot()
    return [
      `${snap.total} total`,
      ...snap.buckets.map((row) => `${LIVE_BUCKET_LABELS[row.bucket]} ${row.count}`),
    ].join(" · ")
  })

  const scopeTitle = createMemo(() => {
    if (scope() === "all") return "all directories"
    return `current · ${truncatePath(context.ui.format.path(directory()), 40)}`
  })

  const renderRow = (row: StatsRow) => {
    const active = () => selectedRow()?.key === row.key
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
          <text fg={toneColor(row.tone)}>{active() ? "›" : "·"}</text>
        </box>
        <box flexGrow={1} minWidth={0} flexShrink={1}>
          <text fg={toneColor(row.tone)}>{row.label}</text>
        </box>
        <box flexShrink={0}>
          <text fg={theme.text.muted}>{row.detail}</text>
        </box>
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
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base}>
            <b>Gangway stats</b>
          </text>
          <text fg={theme.text.muted}>{`· ${scopeTitle()}`}</text>
        </box>
        <box flexDirection="row" gap={2}>          <text fg={scope() === "all" ? theme.text.base : theme.text.muted}>
            {scope() === "all" ? <b>a all</b> : "a all"}
          </text>
          <text fg={scope() === "current" ? theme.text.base : theme.text.muted}>
            {scope() === "current" ? <b>c current</b> : "c current"}
          </text>
        </box>
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2}>
        <text fg={theme.text.muted}>{liveStrip()}</text>
      </box>
      <Show when={drillSessions()}>
        {(detail) => (
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={theme.text.base}>
              <b>{detail().title}</b>
            </text>
            <text fg={theme.text.muted}>
              {`${detail().count} ${detail().count === 1 ? "session" : "sessions"} · ${detail().scopeLabel}`}
            </text>
          </box>
        )}
      </Show>
      <scrollbox flexGrow={1} minHeight={0}>
        <Show
          when={rows().length > 0}
          fallback={
            <box paddingLeft={2} paddingRight={2} paddingTop={1}>
              <text fg={theme.text.muted}>
                {drill() ? "No matching Gangway sessions in this view." : "No Gangway sessions loaded yet."}
              </text>
            </box>
          }
        >
          <Show
            when={drill()}
            fallback={
              <For each={overviewSections()}>
                {(section) => (
                  <box flexShrink={0} flexDirection="column" paddingTop={1}>
                    <box paddingLeft={2} paddingRight={2}>
                      <text fg={theme.text.muted}>{section.title}</text>
                    </box>
                    <Show when={section.note}>
                      {(note) => (
                        <box paddingLeft={2} paddingRight={2}>
                          <text fg={theme.text.muted}>{note()}</text>
                        </box>
                      )}
                    </Show>
                    <For each={section.rows}>{renderRow}</For>
                  </box>
                )}
              </For>
            }
          >
            <box flexDirection="column" paddingTop={1}>
              <For each={drillRows()}>{renderRow}</For>
            </box>
          </Show>
        </Show>
      </scrollbox>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column">
        <Show when={snapshot().unsynced > 0}>
          <text fg={theme.text.feedback.warning.base}>
            {`${snapshot().unsynced} session${snapshot().unsynced === 1 ? "" : "s"} with unsynced attention data; waits may be incomplete.`}
          </text>
        </Show>
        <text fg={theme.text.muted}>{`${snapshot().historyNote} · recent outcomes: past 24h · ages update live`}</text>
        <text fg={theme.text.muted}>
          {`${drill() ? "enter open session · esc back to stats" : "enter drill down · esc back"} · j/k move · a/c scope${props.onRefresh ? " · r refresh" : ""}`}
        </text>
      </box>
    </box>
  )
}

export function createGangwayStats(
  context: Plugin.Context,
  options: GangwayStatsOptions = {},
): GangwayStatsFeature {
  const [permissionAskedAt, setPermissionAskedAt] = createSignal<Readonly<Record<string, number>>>(emptyRecord())
  const [formCreatedAt, setFormCreatedAt] = createSignal<Readonly<Record<string, number>>>(emptyRecord())
  const [executionStartedAt, setExecutionStartedAt] = createSignal<Readonly<Record<string, number>>>(emptyRecord())

  const firstSeen = new Map<string, number>()
  const [firstSeenVersion, setFirstSeenVersion] = createSignal(0)

  const observations: StatsObservations = {
    permissionAskedAt,
    formCreatedAt,
    executionStartedAt,
    firstSeen(key) {
      firstSeenVersion()
      return firstSeen.get(key)
    },
    noteFirstSeen(key, at) {
      if (firstSeen.has(key)) return
      firstSeen.set(key, at)
      setFirstSeenVersion((version) => version + 1)
    },
    clearFirstSeen(key) {
      if (!firstSeen.delete(key)) return
      setFirstSeenVersion((version) => version + 1)
    },
  }

  let closeHandler: (() => void) | undefined
  let lastReturn: StatsReturnRoute | undefined

  const close = () => {
    const handler = closeHandler
    closeHandler = undefined
    if (handler) {
      handler()
      return
    }
    if (lastReturn) {
      context.ui.router.navigate(
        lastReturn as Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0],
      )
      return
    }
    context.ui.router.navigate({ type: "home" })
  }

  const open = (openOptions: StatsOpenOptions = {}) => {
    const current = context.ui.router.current()
    if (current.type === "plugin" && current.name === STATS_PAGE) return
    const directory =
      openOptions.directory ??
      context.location?.directory ??
      context.data.location.default().directory
    const returnTo =
      openOptions.returnTo ??
      (current.type === "plugin"
        ? { type: "plugin" as const, id: current.id, name: current.name, data: current.data }
        : current)
    closeHandler = openOptions.onClose
    lastReturn = returnTo
    context.ui.dialog.clear()
    context.ui.router.navigate({
      type: "plugin",
      name: STATS_PAGE,
      data: { directory, returnTo } satisfies StatsRouteData,
    })
  }

  const unregister = context.ui.router.register({
    name: STATS_PAGE,
    render: (input) => (
      <StatsPage
        context={context}
        open={(input.data as StatsRouteData | undefined) ?? {}}
        close={close}
        observations={observations}
        historyLimit={options.historyLimit}
        onRefresh={options.onRefresh}
        now={options.now ?? Date.now}
      />
    ),
  })

  const stops = [
    context.data.on("permission.asked", (event) => {
      setPermissionAskedAt((record) => withEntry(record, event.data.id, event.created))
    }),
    context.data.on("permission.replied", (event) => {
      setPermissionAskedAt((record) => withoutEntry(record, event.data.requestID))
    }),
    context.data.on("form.created", (event) => {
      setFormCreatedAt((record) => withEntry(record, event.data.form.id, event.created))
    }),
    context.data.on("form.replied", (event) => {
      setFormCreatedAt((record) => withoutEntry(record, event.data.id))
    }),
    context.data.on("form.cancelled", (event) => {
      setFormCreatedAt((record) => withoutEntry(record, event.data.id))
    }),
    context.data.on("session.execution.started", (event) => {
      setExecutionStartedAt((record) => withEntry(record, event.data.sessionID, event.created))
    }),
    context.data.on("session.execution.succeeded", (event) => {
      setExecutionStartedAt((record) => withoutEntry(record, event.data.sessionID))
    }),
    context.data.on("session.execution.failed", (event) => {
      setExecutionStartedAt((record) => withoutEntry(record, event.data.sessionID))
    }),
    context.data.on("session.execution.interrupted", (event) => {
      setExecutionStartedAt((record) => withoutEntry(record, event.data.sessionID))
    }),
  ]

  return {
    page: STATS_PAGE,
    open,
    dispose() {
      unregister()
      for (const stop of stops) stop()
      closeHandler = undefined
    },
  }
}
