# gangway

MCP bridge that lets an MCP-capable client (Codex, Claude Code, Goose, Zed, …) start and
drive OpenCode implementation sessions running `opencode-go/deepseek-v4.1-flash`. Local
machine only: the endpoint binds `127.0.0.1`.

Global plugin loading is exercised against the installed OpenCode 2.0.28 package; the live
model session was last verified on OpenCode 2.0.15.

## Tools

| Tool | Notes |
|---|---|
| `opencode_start_session` | `prompt`, `sessionID?`, `title?`, `directory?`, `agent?`, `model?`, `wait?`, `timeoutMs?`, `requestID?` |
| `opencode_prompt` | follow-up `sessionID`, `text`, `wait?`, `timeoutMs?`, `requestID?` |
| `opencode_wait` | block until idle, or bind to an operation's turn with `requestID?` (default cap 45 s) |
| `opencode_status` | session info + output tail; with `requestID` returns compact operation state (`reconcile?`) |
| `opencode_result` | latest/bound output; with `requestID` reports unchanged output and never resends it (`force?`, `maxChars?`) |
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
  command palette ("Gangway sessions"), the `/gangway` slash command, or — on a session screen
  with an empty prompt — `left`/`shift+left`. With text in the prompt those keys keep their
  normal cursor-move/selection behavior, and dialogs, autocomplete and form modes are unaffected.
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
bun test test/lifecycle.test.ts    # 6 pass, 0 fail

# Per-request context resolution (lazy facade + resolver failure + body parsing):
bun test test/server.test.ts       # 4 pass, 0 fail

# Package directory resolution:
bun test test/plugin.test.ts       # 2 pass, 0 fail

# TUI panel helpers (session marker/title/age/filter/truncation):
bun test test/tui-helpers.test.ts  # 12 pass, 0 fail

# Focused offline fake-context suite for requestID dispatch/resume (no network/provider):
bun test test/dispatch.test.ts     # 15 pass, 0 fail

# Endpoint suite (static cases; live cases skip unless RUN_LIVE=1):
bun test test/mcp.test.ts          # 3 pass, 3 skip, 0 fail when a local endpoint answers;
                                   # 6 skip when none does

# Everything:
bun test                           # 42 pass, 3 skip, 0 fail (with a local endpoint answering)

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
return a resumable handle instead of blocking past the client window.

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
- `src/mcp.ts` — MCP server (streamable HTTP, stateless), per-request context resolution + tools.
- `src/lifecycle.ts` — process-lifetime endpoint ownership, lease handover, HTTP reacquisition,
  shutdown cleanup and rendezvous file.
- `src/tools.ts` — session tools, permission ruleset, wait/result logic.
- `test/mcp.test.ts` — endpoint suite + `RUN_LIVE` session suite.
- `test/dispatch.test.ts` — offline fake-context dispatch/resume suite (requestID).
- `test/lifecycle.test.ts` — deterministic eviction/reacquisition/reload/shutdown suite.
- `test/server.test.ts` — port collision, per-request resolution/lazy context facade.
- `test/plugin.test.ts` — package directory resolution and import.
