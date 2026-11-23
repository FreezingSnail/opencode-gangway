# gangway

MCP bridge that lets an MCP-capable client (Codex, Claude Code, Goose, Zed, …) start and
drive OpenCode implementation sessions running `opencode-go/deepseek-v4.1-flash`. Local
machine only: the endpoint binds `127.0.0.1`.

Global plugin loading is exercised against the installed OpenCode 2.0.28 package; the live
model session was last verified on OpenCode 2.0.15.

## Tools

| Tool | Notes |
|---|---|
| `opencode_start_session` | `prompt`, `sessionID?`, `title?`, `directory?`, `agent?`, `model?`, `wait?`, `timeoutMs?`, `requestID?`, `notify?` (Codex push, requires `requestID`) |
| `opencode_prompt` | follow-up `sessionID`, `text`, `wait?`, `timeoutMs?`, `requestID?`, `notify?` (Codex push, requires `requestID`) |
| `opencode_wait` | block until idle, or bind to an operation's turn with `requestID?` (default cap 45 s) |
| `opencode_status` | session info + output tail; with `requestID` returns compact operation state (`reconcile?`); optional `directory?` selects/reacquires the session's project location |
| `opencode_result` | latest/bound output; with `requestID` reports unchanged output and never resends it (`force?`, `maxChars?`) |
| `opencode_delivery` | `inspect`, `deliver` a missing first terminal result, `retry` known preflight failures, or `recover` stale sending reservations; accepts `directory?` |
| `opencode_interrupt` | stop current run |
| `opencode_list` | sessions started via the bridge |

Sessions get a `[gangway]` title prefix (override with the `titlePrefix` plugin option) and a
session-scoped permission ruleset: edit and shell allowed, destructive/mirror-denied commands
(`git push`, `rm -rf`, `perl*`, …) denied so unattended runs cannot stall on approval prompts.
`inheritPermissions` plugin option restores default behavior. New sessions also carry
`metadata.gangway: true` and, with `requestID`, `metadata.gangwayRequestID`.

## Reliable dispatch and resume

`opencode_start_session` and `opencode_prompt` accept an optional `requestID`. Dispatch is
**dispatch once, wait, resume, inspect, repair** — not fire-and-many-times:

1. **Dispatch once** with a stable `requestID` (e.g. one per bead). The operation identity is
   pinned to the effective `directory`, `model`, `agent`, `sessionID` and `prompt`. An identical
   retry resolves to the same recorded operation and never creates a second session or submits a
   second prompt. Changed input under the same `requestID` returns a conflict error — use a new
   `requestID` for changed input.
2. **Wait bounded.** `wait: true` / `opencode_wait` block for at most `timeoutMs`, defaulting to
   45 s, below the MCP SDK client request limit of 60 s. On expiry the call returns the stable
   `sessionID`/`requestID` handle with `status: running` or `unknown` and never cancels the run.
   Resume by calling `opencode_wait`/`opencode_status` again.
3. **Inspect.** `opencode_status` with `requestID` returns compact structured state (no transcript
   fetch unless `reconcile: true`). `opencode_result` with `requestID` returns the operation's own
   bounded output and reports `unchanged: true` instead of resending identical output; pass
   `force: true` to resend.
4. **Repair.** Re-drive the same recorded operation through the same implementer session. Session
   idle/`succeeded` means the turn finished, not that a task is accepted or reviewed.

Ordering and state:

- Intent is persisted (`operations/<hash>` in the plugin storage namespace, owned by the OpenCode
  service, not by the per-request MCP server) **before** any effectful upstream call. Once
  `session.create` returns, the session mapping is persisted **before** the prompt is submitted.
- Operation states: `intent` → `created` → `submitting` → `submitted` → `completed`|`failed`, with
  `unknown` for ambiguous delivery. `delivery` is `pending` | `recorded` | `unknown`.
- Concurrent duplicate requests (same `requestID`) are serialized by a process-global lock and
  deduplicated against the durable record; two callers cannot independently create or submit.
- Completion is bound to the submitted turn: the transcript length captured immediately before
  submission is a boundary, and only an assistant message at/after that boundary followed by a
  trailing idle message completes the operation. A previous assistant answer or a pre-submission
  idle state cannot satisfy a new operation.
- Plugin reload / endpoint-owner transfer retain the operation and request mappings because they
  live in plugin storage, which outlives a single plugin instance.

Unknown outcomes never trigger automatic resend or recreation: if `session.create` or
`prompt` delivery is ambiguous, the operation stays `unknown` and reconciliation only *observes*
(transcript probe) — it never recreates the session or re-submits the prompt.

### Stalls waiting on the user (`needsInput`)

A session can be alive but unable to make progress because it is waiting for a
permission approval or an answer to a question form. `opencode_status`,
`opencode_result` (while nonterminal) and every wait path
(`opencode_start_session`/`opencode_prompt` with `wait: true`, `opencode_wait`)
report that stall as `needsInput`. The field is client-agnostic: any MCP harness
reads the same JSON.

`needsInput` is either `null` or:

```json
{
  "kind": "permission",
  "requests": [{ "id": "per_...", "action": "shell", "resources": ["..."], "message": "..." }],
  "forms": []
}
```

- `kind: "permission"` — a pending permission request the agent needs approved
  (for example a shell or edit action).
- `kind: "question"` — a pending question form, or a permission request whose
  `action` is `question`. Default agents auto-allow the `question` permission, so
  question stalls usually surface as forms; the form probe is the primary signal.
- `null` — the bridge could not positively observe a stall: either no pending
  queue was visible or a probe was unavailable. It is **not** a claim that the
  session needs nothing.

Detection is best-effort. The bridge consults its own plugin queues when the
session shares this instance's directory, and otherwise calls the local OpenCode
service (`GET /api/session/:id/permission` and `/form`) with the `service.json`
credentials. Unreadable credentials, a pid mismatch, a timeout or any failed
request yields `null`, never a false "none".

When a wait detects attention it returns immediately (well before `timeoutMs`)
with the operation's current `status` (`running`/`busy`), `needsInput`,
`waitResult: "needs-input"` and `timedOut: false`. It does not interrupt the run
or advance the recorded operation state. Have the user answer in the TUI, then
call the same wait again: the operation resumes normally. The bridge never
answers permissions or forms on the user's behalf.

### Recovery limitations and unresolved decisions

Recorded honestly; no upstream capability is assumed that was not observed:

- **No pinned turn identity.** `ctx.session.prompt` was not observed to return a stable message/turn
  id that can later be matched, so completion uses the transcript-length boundary plus a trailing
  `idle` heuristic. An unrelated concurrent turn admitted on the same session between boundary and
  probe could be mistaken for this operation's turn; run one outstanding operation per session.
- **Create outcome is not discoverable.** No OpenCode API was found to look up a session created by
  a prior (possibly lost) `requestID`. If a create response is lost, the session is not recoverable
  by handle through the bridge — the operation is reported `unknown` and never recreated.
- **Storage durability is assumed, not proven.** The design reuses `ctx.storage` (the plugin store)
  across reload and assumes it is shared and durable; cross-process serialization relies on a single
  endpoint owner. Two processes sharing the same storage but different owners were not verified to
  serialize safely.
- **`requestID` scope.** Records are keyed by a hash of the `requestID` alone; the repository
  context is part of the pinned identity, so the same `requestID` in a different directory is a
  conflict rather than a separate operation.
- **No paid/live provider run** was performed for this change; live session tests remain gated
  behind `RUN_LIVE=1`.

## Push completion to Codex

Codex workers can dispatch an OpenCode run, end their turn, and receive the
structured result later without polling. This is an explicit per-dispatch opt-in
on top of a deployment switch; existing calls are unchanged and push nothing.

### Enable it

Codex and OpenCode must share the local Codex App Server (the same Unix socket,
`$CODEX_HOME/app-server-control/app-server-control.sock` by default). Attach the
Codex TUI with `codex --remote unix://` so its thread is loaded there.

Enable delivery for the Gangway plugin instance, then reload OpenCode:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/gangway",
      "options": { "port": 4787, "codexDelivery": true }
    }
  ]
}
```

`codexDelivery: { "enabled": true }` is equivalent. For installs that cannot pass
plugin options, `GANGWAY_CODEX_DELIVERY=1` in the OpenCode host environment is
the fallback. This switch only enables the event monitor and sender; a call must
still opt in with `notify: true`.

When running OpenCode from this Gangway checkout, use the global plugin entry
above. Do not add a second local `.opencode/plugins/gangway` shim: OpenCode
keeps the first plugin with a duplicate ID, which can shadow the configured
global instance and its options.

### Dispatch once, then end the turn

Pass a stable `requestID` and `notify: true` to `opencode_start_session` or
`opencode_prompt`. Do not pass `wait: true` on the push path.

```json
{
  "prompt": "Implement the task and report the files changed",
  "requestID": "gangway-34r.3-worker",
  "notify": true
}
```

The call returns its normal dispatch receipt immediately. With push armed it
also contains:

```json
{
  "requestID": "gangway-34r.3-worker",
  "sessionID": "ses_...",
  "state": "submitted",
  "notify": {
    "requested": true,
    "state": "armed",
    "mechanism": "codex-push",
    "threadId": "<calling Codex thread>",
    "monitor": { "available": true, "error": null },
    "target": { "state": "available", "checkedAt": 0, "error": null },
    "hint": "End this turn after the receipt. ..."
  }
}
```

`notify.state` is actionable:

- `armed` — the live monitor for this location is subscribed, the deployment
  switch is on, the calling Codex `_meta.threadId` was captured, and that target
  (or its deliverable parent) is loaded on the shared App Server. End the turn.
  One result will be pushed when the run finishes; do not resubmit, poll, or call
  `opencode_wait`/`opencode_result` on the successful path.
- `plugin-disabled` — dispatch still succeeds, but no push will occur. Set the
  `codexDelivery` option (or `GANGWAY_CODEX_DELIVERY=1`) and reload before
  dispatching; otherwise use `opencode_wait`/`opencode_result` yourself.
- `thread-missing` — dispatch still succeeds, but the caller did not supply an
  MCP `_meta.threadId`. Codex supplies this automatically; another MCP client
  cannot receive the push.
- `session-unavailable` — OpenCode did not confirm a session id, so Gangway
  cannot monitor a terminal outcome.
- `monitor-unavailable` — push is enabled, but the execution monitor for this
  location is not subscribed, so no terminal event can be observed. Use
  `opencode_wait`/`opencode_result`, or restore the event stream and reload.
- `target-unavailable` — the calling Codex thread (or required parent) is not
  loaded on the shared App Server. The run still executes and the recorded result
  remains available; load the thread before relying on a later push.
- `target-unverified` — the dispatch has a caller thread but Gangway has not
  verified it on the shared App Server. Keep the turn open or reconnect the App
  Server before relying on push.

Receipts read the plugin instance's live readiness, not a stale per-location
option snapshot, and include `notify.monitor` and
`notify.target: { state, checkedAt, error }` for diagnosis. Target verification
is a read-only `thread/read`; the cached result expires after 30 seconds and
status/result checks refresh it. An initialize or lookup failure is safe
preflight and never starts a turn.

`notify: true` requires a `requestID`: without a stable key there is nothing to
bind the eventual result to. An operation that already finished cannot be armed
after the fact — inspect its recorded result instead, or dispatch a new
`requestID`.

### What gets pushed

The terminal result is delivered once as a structured
`gangway_operation_result` tool output to the owning Codex thread. Its payload is:

```json
{
  "kind": "gangway.operation.result",
  "requestID": "...",
  "sessionID": "ses_...",
  "source": {
    "requestID": "...",
    "kind": "start",
    "sessionID": "ses_...",
    "workerThreadId": "<calling Codex worker thread>",
    "directory": "/repo",
    "agent": null,
    "model": "opencode-go/deepseek-v4.1-flash"
  },
  "state": "completed",
  "outcome": "succeeded",
  "outputId": "msg_...@...@succeeded",
  "text": "<bounded assistant output>",
  "truncated": false,
  "error": null,
  "model": { "providerID": "...", "id": "..." },
  "finish": "stop",
  "tokens": { "input": 1, "output": 1 },
  "cost": 0.001,
  "completedAt": 1700000000000
}
```

`source` identifies the recorded worker and OpenCode session, so a parent that
receives a child's result can still tell which dispatch produced it.

Text is capped at 12,000 characters and `truncated` reports the cap; errors are
capped at 2,000. The OpenCode run result is separate from the push: delivery
never changes the recorded completion or resubmits the prompt.

### Native worker parent/resume behavior

For a Codex native MultiAgent V2 child that cannot accept direct input, Gangway
first verifies the child's `parentThreadId` and sends the result to that parent.
Both idle and active loaded parents are eligible. The parent then resumes the
same child through Codex's native subagent follow-up — the child does not need to
poll and can stay idle until woken. A worker that accepts direct input receives
the result itself. This is the intended Luna handoff: worker dispatches once,
ends its turn, and the parent receives the structured result and resumes it.

### Attention and `needsInput`

An attention push also fires when a new permission or form request appears.
Event and live-queue observations are merged so one request keeps one identity.
A known-empty queue clears stale queue-only attention; an unreadable queue is
unknown and preserves the last observed state. The payload has
`kind: "gangway.operation.attention"`, the same `source` identity and
the current `needsInput` object. The dedupe key uses the upstream request/form
id; if it is absent, Gangway uses the event id or a stable queue timestamp or
sequence when available, then a stable shape only when the host exposes no
identity. Replayed events and repeated queue observations retain the same key;
distinct same-shape requests remain distinct when the host supplies an identity.
If it supplies none, a later same-shape request can share the earlier key, so
the event stream with event ids is the robust path. After reconnect, Gangway refreshes the live
permission/form queues and pushes any attention items whose delivery was not
recorded. Answer in the TUI, then the run continues and its eventual terminal
result is pushed normally. Gangway never answers prompts on the user's behalf.

Polling paths (`opencode_status`/`opencode_result` with `requestID`, and waits)
still report the same `needsInput`. If a push is unavailable, use those tools.

### Inspection and recovery by `requestID`

The same `requestID` remains the recovery handle. `opencode_status`,
`opencode_result` and `opencode_delivery` include the `notify` contract and
durable `notify.deliveries`/`codexDeliveries` entries keyed by `outputId` or the
attention dedupe key:

- `sending` — a reservation was durably recorded before the effectful call. If
  it stays `sending` past the stale threshold (60 s), a later delivery/recovery
  marks it `ambiguous`; it is never resent automatically.
- `accepted` — the App Server accepted one `turn/start`; includes recipient
  thread and turn id.
- `preflight-failed` — no effectful `turn/start` was sent. This now includes
  connection/open failures, App Server `initialize` failures, thread lookup
  failures and unloaded/missing targets. It is safe to retry deliberately.
- `rejected` — the App Server answered the `turn/start` with a JSON-RPC error.
  The request was rejected, not ambiguously accepted; it is never retried
  automatically.
- `ambiguous` — bytes for `turn/start` were sent but no definite reply arrived
  (timeout, disconnect, or crash after send). Gangway deliberately never sends a
  blind duplicate wake.

Deliberate recovery uses `opencode_delivery { requestID, action, directory? }`:

- `inspect` (default) returns the same durable state without changing anything.
- `deliver` sends a terminal opted-in result only when that result has no
  delivery record. Accepted, rejected, sending, ambiguous and preflight-failed
  entries are not sent again by this action.
- `retry` re-attempts only `preflight-failed` entries (optionally one
  `outputId`). Accepted, rejected, sending and ambiguous entries are refused.
- `recover` marks stale `sending` reservations `ambiguous` without sending. If a
  reservation is still fresh, it is left alone.

`opencode_status`/`opencode_result` remain read-only with respect to the
OpenCode run: they never resubmit the prompt or recreate the session. If the
result is intact but delivery failed, use the recorded result; dispatch a new
operation only for a new run.

Limitations: push needs the Gangway plugin process alive to observe terminal and
attention events, the Codex thread loaded on the shared App Server, and a
codex-capable caller. While subscribed, the monitor performs a paginated
reconciliation sweep every 15 seconds by default, so a missed terminal event is
recovered even when the event stream stays open. A run that finishes while the
event stream is down is also reconciled on the next subscription; transient
transcript-read failures are retried with bounded backoff while the monitor is
alive. Each transcript and attention probe is bounded to five seconds. Terminal
records without a delivery entry are reconciled, including results recorded by
status/wait tools before a reload. Duplicate sweeps,
reconnects and events are deduped by durable delivery state. A terminal operation
with no delivery attempt can be sent once using `opencode_delivery action=deliver`;
a known preflight failure can be retried with `action=retry`. Accepted, rejected,
sending and ambiguous sends are never resent. One terminal result and at most
one notification per attention item are pushed.

## Endpoint lifetime and reacquisition

OpenCode 2.0.28 has **no service-lifetime plugin hook**. Plugins are location-scoped
(`PluginSupervisor.makeLocationNode` in the installed `packages/core/src/plugin/supervisor.ts`),
and an idle location's plugin graph is disposed after ~60 minutes. Gangway therefore makes the
MCP listener process-lifetime:

- The first location acquires the listener, writes `endpoint.json`, and owns the endpoint for the
  life of the OpenCode host process. Additional locations attach as leases.
- When a location unloads (UI close or idle eviction), only its lease is released. If it was the
  final lease, the listener and rendezvous still stay up.
- Each tool-call MCP request resolves context independently: a live instance whose location
  directory canonicalizes to the requested directory, else the first live instance. If no live
  instance remains, it uses the requested directory (from `opencode_start_session.directory`) or
  the most recently known directory, verifies that it still exists and is a directory, then asks
  the OpenCode service to boot it through `GET /api/location?location%5Bdirectory%5D=...` before
  retrying live-instance selection. Ping, initialize, and `tools/list` stay context-free and do
  not wake an idle location.
- Reacquisition reads `$XDG_STATE_HOME/opencode/service.json` (default
  `~/.local/state/opencode/service.json`) and requires its `pid` to equal the current process. The
  request uses Basic auth (`opencode` / the file's `password`) with a 5 s timeout. The password is
  never logged. If the file is missing or belongs to another process, reacquisition fails with a
  descriptive error instead of guessing a port.
- A deleted or missing directory is never booted, and a live instance whose directory disappeared
  is not reused. Requests targeting a deleted worktree are rejected.
- Intentional process shutdown (`exit`/`beforeExit`) stops every listener, removes its rendezvous
  file, and clears the in-process endpoint state. `shutdownEndpoints()` is exported and idempotent
  for tests/tools. SIGINT/SIGTERM handlers are intentionally not installed; the OpenCode host owns
  those signals. SIGKILL cannot run cleanup, so a stale `endpoint.json` can remain until the next
  startup overwrites it (the file is rewritten on the next acquire).

The rendezvous file lives at `~/.local/state/gangway/endpoint.json`
(`$XDG_STATE_HOME/gangway/endpoint.json` when configured). It must stay outside OpenCode's watched
configuration directories: writing it there can trigger repeated configuration reloads and block
prompt admission.

## TUI panel

Gangway ships a TUI plugin (`./tui` entry, `gangway.tui`) with a live sessions panel:

- **Open with `ctrl+x d`** (`<leader>d`, configurable as `gangway.sessions` in keybinds), the
  command palette ("Gangway sessions"), the `/gangway` slash command, or — on the blank new-chat
  page or any session screen with an empty prompt — `left`/`shift+left`. With text in the prompt
  those keys keep their normal cursor-move/selection behavior, and dialogs, autocomplete and
  form modes are unaffected.
- Lists gangway sessions: `[gangway]`/`metadata.gangway`-marked roots (plus legacy
  `[codex]`/`codexMcp` sessions) only, newest first, with model, age, directory and a live state
  indicator. The glyph is `!` for a pending permission request, `?` for a pending question
  form, `▶` while busy and `○` when idle. Waiting sessions sort ahead of merely-busy ones in
  `here`/`active`, and the header/footer show a waiting count (for example `2 waiting`).
- **Three filters, switched with `1`/`2`/`3` or the header tabs:** `here` — busy or waiting
  sessions in the current directory (default), `active` — busy or waiting sessions in every
  directory, `all` — every gangway session. Completed sessions leave the active views as soon
  as they go idle and stop waiting; `all` keeps the history. The filter persists
  across panel opens (plugin storage). Tab labels show live counts.
- **Updates live** — new sessions, titles, busy/idle state and pending permissions/forms are
  projected from server events through the shared data store, no manual refresh. Historical
  sessions from other directories are hydrated at startup and on a 5 s fallback sweep (which
  also syncs unknown permission/form lists for busy sessions); the page also handles `r`.
- `enter` opens the session, `i` interrupts it, `j`/`k` move selection, `esc` returns.
- Read-only views open from the list: `p` session peek, `s` live stats, `a` cross-directory
  needs-input inbox, `d` latest-turn changes, `o` recorded dispatch details, `t` activity
  timeline, and `u` token/cost usage. Each returns with `esc`; `p`/`d`/`o`/`t` pin the selected
  session ID, and `enter` on an inbox or stats row opens the owning session.
- The home footer shows a `gangway N` counter (plus `· M waiting` when sessions need input), and
  a toast announces each new gangway session, pending permission request and question form
  (one toast per request/form, cleared when answered or cancelled). Toasts are display-only:
  gangway never answers permissions or forms for you.

Sessions are recognized by the neutral `metadata.gangway` marker or `[gangway]` title prefix.
Legacy sessions from earlier bridge versions are still recognized by `metadata.codexMcp` or the
`[codex]` title prefix, so pre-change history stays visible (`src/tui-helpers.ts`).
The TUI entry re-exports from the root `tui.ts` for directory loading and is declared as
`./tui` in `package.json` `exports`.
JSX types (`solid-js`, `@opentui/*`) resolve from the OpenCode host at runtime; they are not
dev dependencies, so `tsc` reports them as missing — install
`solid-js @opentui/core @opentui/solid` as dev dependencies if a green typecheck matters.

## Dev

```sh
bun install

# private OpenCode server; the project-local plugin loads from .opencode/plugins/
opencode serve --port 4111 --print-logs
```

### Test commands and outcomes

```sh
# Deterministic offline lifecycle: eviction, reacquisition, reload, shutdown:
bun test test/lifecycle.test.ts    # 7 pass, 0 fail

# Per-request context resolution (lazy facade + resolver failure + body parsing):
bun test test/server.test.ts       # 4 pass, 0 fail

# Package directory resolution:
bun test test/plugin.test.ts       # 3 pass, 0 fail

# TUI panel helpers (session marker/title/age/filter/truncation):
bun test test/tui-helpers.test.ts  # 20 pass, 0 fail

# Focused offline fake-context suite for requestID dispatch/resume (no network/provider):
bun test test/dispatch.test.ts     # 32 pass, 0 fail

# Offline execution-event recording and Codex delivery (scripted sockets, no live service):
bun test test/execution-events.test.ts  # 28 pass, 0 fail
bun test test/codex-delivery.test.ts    # 24 pass, 0 fail
bun test test/codex-readiness.test.ts   # 3 pass, 0 fail
bun test test/codex-wake-probe.test.ts  # 2 pass, 0 fail

# Endpoint suite (static cases; live cases skip unless RUN_LIVE=1):
bun test test/mcp.test.ts          # 3 pass, 3 skip, 0 fail when a local endpoint answers;
                                   # 6 skip when none does

# Everything:
bun test                           # 240 pass, 3 skip, 0 fail (with a local endpoint answering)

# Type check (pre-existing environment-type errors only):
bunx tsc --noEmit                  # exit 2: missing @types/node and @types/bun
```

`bunx tsc --noEmit` reports errors for `node:*`/`process`/`Buffer`/`Bun`/`bun:test` in every source
and test file because the dev dependencies omit `@types/node` and `@types/bun` (`types: []` in
`tsconfig.json`), and `src/tui.tsx` additionally cannot resolve `solid-js`/`@opentui/*` types
(the OpenCode host supplies those at runtime). Comparing against a pristine `HEAD` archive shows
the same diagnostic classes for the pre-existing code; this change only adds more of them (new
Bun/Node-using code and the TUI panel) and removes an old test-helper `Ctx` mismatch. No
dependencies were added. Run the live suite with `RUN_LIVE=1 bun test`.

## MCP client setup

Any MCP client that supports streamable HTTP can drive the bridge. Register this URL as an MCP
server:

```
http://127.0.0.1:4787/mcp
```

Where the client has an approval policy, allow the gangway tools to run without per-call
approval prompts — an interactive prompt can stall an unattended session. The bridge does not
require client-specific metadata; sessions it creates are labeled `[gangway]` and
`metadata.gangway` regardless of which client called the tools.

Recommended flow for any client:

1. `opencode_start_session` with a stable `requestID`; do not block on the full run.
2. `opencode_wait` (or `opencode_status`) to resume within the client's request timeout.
3. `opencode_result` to read the bounded output once the operation completes.

MCP clients time out long tool calls (SDK default 60s), so bridge waits default to 45s and
return a resumable handle instead of blocking past the client window. A Codex caller that
wants the eventual result pushed back instead of polling can add `notify: true` plus a
`requestID`; see [Push completion to Codex](#push-completion-to-codex).

### Codex example

```sh
codex mcp add gangway --url http://127.0.0.1:4787/mcp
```

Add to `~/.codex/config.toml` under `[mcp_servers.gangway]`:

```toml
default_tools_approval_mode = "approve"
```

Prefer `opencode_start_session` without `wait`, then `opencode_wait` / `opencode_status` — pass a
`requestID` so a timeout can be resumed rather than retried.

### Test a Codex wake-up from OpenCode

Attach a Codex TUI to the shared local App Server with `codex --remote unix://`.
Ask the parent to spawn a Luna test worker, have the worker report its
`CODEX_THREAD_ID`, and let both turns end. Ask the parent to relay the synthetic
verdict to the same worker using native subagent follow-up if it receives a
`gangway_wake_probe` result. The worker should acknowledge the verdict and stop.

From the Gangway checkout, run `opencode reload` and open an OpenCode session.
Enter `/gangway-wake-probe <worker-thread-uuid>` in OpenCode. The command checks
that the worker is idle on the shared server and sends `SYNTHETIC REVIEW APPROVED`
after 90 seconds. A worker that accepts direct input receives it directly.
For MultiAgent V2, the parent receives it and can resume the worker through
Codex's native follow-up tool. Repeating the command for the same worker in the
same OpenCode process schedules one delivery. The probe runs no OpenCode model.

## Global install

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "/path/to/gangway", "options": { "port": 4787 } }
  ]
}
```

The package path must be an absolute **directory**, not `src/plugin.ts`. OpenCode
rejects configured file paths with `configured plugin path must be a directory`.
The root `index.ts` exports the plugin for directory loading.

Reload the project location or restart the OpenCode service to activate it (a restart
ends any open TUI session). Multiple locations share `127.0.0.1:4787` through
process-wide leases. When one location unloads, a remaining location takes over
request handling; the final unload keeps the listener alive for the host process so
a later request can reacquire a location (see “Endpoint lifetime and reacquisition”
above). An external port collision is reported as a plugin failure.

## Layout

- `src/plugin.ts` — plugin entry (`Plugin.define`); registers each location as an endpoint lease.
- `index.ts` — package directory entry point for the global OpenCode loader.
- `tui.ts` — TUI entry re-export; `src/tui.tsx` renders the live gangway sessions panel
  (route + keymap + slots), `src/tui-helpers.ts` holds the pure session filters/labels.
- `src/tui-preview.ts`, `src/tui-stats.tsx`, `src/tui-inbox.tsx`, `src/tui-changes*.ts(x)`,
  `src/tui-dispatch*.ts(x)`, `src/tui-timeline*.ts(x)`, `src/tui-usage*.ts(x)` — feature-local
  projections/routes for peek, stats, inbox, changes, dispatch, timeline and usage.
- `src/mcp.ts` — MCP server (streamable HTTP, stateless), per-request context resolution + tools.
- `src/lifecycle.ts` — process-lifetime endpoint ownership, lease handover, HTTP reacquisition,
  shutdown cleanup and rendezvous file.
- `src/tools.ts` — session tools, permission ruleset, wait/result logic.
- `test/mcp.test.ts` — endpoint suite + `RUN_LIVE` session suite.
- `test/dispatch.test.ts` — offline fake-context dispatch/resume suite (requestID).
- `test/lifecycle.test.ts` — deterministic eviction/reacquisition/reload/shutdown suite.
- `test/server.test.ts` — port collision, per-request resolution/lazy context facade.
- `test/plugin.test.ts` — package directory resolution and import.
