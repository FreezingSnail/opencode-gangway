# gangway

MCP bridge that lets Codex start and drive OpenCode implementation sessions running
`opencode-go/deepseek-v4.1-flash`. Local machine only: the endpoint binds `127.0.0.1`.

Global loading and a live model session verified on OpenCode 2.0.15.

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

Sessions get a `[codex]` title prefix and a session-scoped permission ruleset: edit and
shell allowed, destructive/mirror-denied commands (`git push`, `rm -rf`, `perl*`, …) denied
so unattended runs cannot stall on approval prompts. `inheritPermissions` plugin option
restores default behavior.

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

## Dev

```sh
bun install

# private OpenCode server; the project-local plugin loads from .opencode/plugins/
opencode serve --port 4111 --print-logs
```

### Test commands and outcomes

```sh
# Focused offline fake-context suite for requestID dispatch/resume (no network/provider):
bun test test/dispatch.test.ts     # 15 pass, 0 fail

# Endpoint suite (static cases; live cases skip unless RUN_LIVE=1):
bun test test/mcp.test.ts          # 3 pass, 3 skip, 0 fail

# Everything:
bun test                           # 22 pass, 3 skip, 0 fail

# Type check (pre-existing environment-type errors only, unchanged by this change):
bunx tsc --noEmit                  # exit 2: missing @types/node and @types/bun
```

`bunx tsc --noEmit` reports `.ts` errors for `node:*`/`process`/`Bun`/`bun:test` in every source
and test file because the dev dependencies omit `@types/node` and `@types/bun` (`types: []` in
`tsconfig.json`). The count and content are identical to the pre-change baseline; `src/tools.ts`
itself reports no type errors. Run the live suite with `RUN_LIVE=1 bun test`.

## Codex setup

```sh
codex mcp add gangway --url http://127.0.0.1:4787/mcp
```

Add to `~/.codex/config.toml` under `[mcp_servers.gangway]`:

```toml
default_tools_approval_mode = "approve"
```

MCP clients time out long tool calls (SDK default 60s), so bridge waits default to 45s and
return a resumable handle instead of blocking past the client window. Prefer
`opencode_start_session` without `wait`, then `opencode_wait` / `opencode_status` — pass a
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
request handling; the final unload closes the endpoint. An external port collision
is reported as a plugin failure.

The rendezvous file lives at `~/.local/state/gangway/endpoint.json`
(`$XDG_STATE_HOME/gangway/endpoint.json` when configured). It must stay outside
OpenCode's watched configuration directories: writing it there can trigger repeated
configuration reloads and block prompt admission.

## Layout

- `src/plugin.ts` — plugin entry (`Plugin.define`), binds the MCP server, rendezvous file.
- `index.ts` — package directory entry point for the global OpenCode loader.
- `src/mcp.ts` — MCP server (streamable HTTP, stateless) + tool registration.
- `src/lifecycle.ts` — shared endpoint leases and ownership transfer.
- `src/tools.ts` — session tools, permission ruleset, wait/result logic.
- `test/mcp.test.ts` — endpoint suite + `RUN_LIVE` session suite.
- `test/dispatch.test.ts` — offline fake-context dispatch/resume suite (requestID).
- `test/server.test.ts` — port collision / lifecycle.
- `test/plugin.test.ts` — package directory resolution and import.
