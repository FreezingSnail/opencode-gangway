# gangway — plan

Goal: let Codex (MCP client) start and drive OpenCode implementation sessions that run on
`opencode-go/deepseek-v4.1-flash`, from any project directory.

## Architecture

```
Codex  --(streamable HTTP MCP, loopback)-->  plugin inside OpenCode service  --(ctx)-->  sessions
```

- Plugin hosts an MCP server in-process (Bun.serve + `@modelcontextprotocol/sdk`
  `WebStandardStreamableHTTPServerTransport`, stateless mode).
- Codex registers it with: `codex mcp add opencode-impl --url http://127.0.0.1:4787/mcp`
  (verified supported: codex-cli 0.162; optional `--bearer-token-env-var`).
- No extra daemon: the plugin lives inside the OpenCode service and talks to sessions
  through `ctx` (same contract as the client/SDK).
- Fallback if the MCP HTTP client handshake misbehaves: stdio shim process spawned by
  Codex that proxies to the same HTTP endpoint.

## Layout

```
~/dev/gangway                        own git repo, loaded via global config `plugins` path
  .opencode/plugins/gangway/        project-local load path (spike/dev)
  src/plugin.ts                     Plugin.define → setup: bind server, rendezvous file, cleanup
  src/mcp.ts                        MCP server + tool registration; Bun.serve fetch handler
  src/tools.ts                      ctx calls: session create/switchModel/prompt/wait/interrupt,
                                    storage registry, idle tracking
  test/                             bun test; integration test connects a real MCP client
  PLAN.md, README.md
```

Global (production) load: add to `~/.config/opencode/opencode.jsonc`:
`"plugins": [{ "package": "/path/to/gangway", "options": { "port": 4787 } }]`

⚠ Config note: current global config uses the legacy `"plugin"` singular key and a
V1-style plugin export (slugineer). V2 loading (`plugins`, `@opencode/plugin`,
`Plugin.define`) is verified for both the project-local path and the global
directory path on OpenCode 2.0.15.

## Model

Default `opencode-go/deepseek-v4.1-flash` (verified available), per-call override,
validated against `ctx.model.list()`.

## MCP tools

| Tool | Args | Behavior |
|---|---|---|
| `opencode_start_session` | `prompt`, `title?`, `directory?`, `agent?`, `model?`, `wait?`, `sessionID?` | create session (location=directory), switch model, prompt; returns `{sessionID}`; `sessionID` attaches to existing |
| `opencode_prompt` | `sessionID`, `text`, `wait?` | follow-up prompt (attach to any session) |
| `opencode_wait` | `sessionID`, `timeoutMs?` | block until idle; return last assistant text + usage |
| `opencode_status` | `sessionID` | busy/idle, last text tail, error info |
| `opencode_result` | `sessionID` | final assistant text, model, usage |
| `opencode_interrupt` | `sessionID`, `continue?` | stop current run |
| `opencode_list` | — | sessions started via this MCP (registry in `ctx.storage`) |

Defaults: async preferred (start → poll/wait) to avoid Codex MCP call timeouts.
Idle detection: `ctx.session.wait` primary; event subscription / polling fallback.

## Permissions (unattended runs stall on permission prompts)

Decide in M1: dedicated agent via `ctx.agent.transform` vs session-scoped
`ctx.permission.rules`. Policy mirrors the user's global config: allow edit/bash in
project; never auto-allow `git push`, `git clone`, `rm -rf`, `curl -o`, `DROP`.

## Security / ops

- Bind `127.0.0.1` only. Optional static token (plugin option → Codex
  `--bearer-token-env-var`).
- Port default `4787`, plugin option. EADDRINUSE → health-probe; skip quietly if ours.
- Rendezvous file `~/.config/opencode/gangway.json` `{url, port, pid}` written on
  start, removed on stop.
- Logs: `console.error` prefixed `[gangway]`, visible with `--print-logs`.

## M0 spike results (done)

- Plugin loads from `.opencode/plugins/gangway/index.ts` (dir + index.ts, no
  package.json needed) — state `active` per `GET /api/plugin`.
- Locations build lazily: on a fresh server the plugin activates once the location is
  built (`POST /api/location/reload` forces it). In production the global `plugins`
  config means every location loads it, so the endpoint is up whenever the service runs.
- `Bun.serve` + `WebStandardStreamableHTTPServerTransport` (stateless,
  `enableJsonResponse`) works; SDK client test (`bun test`) passes: initialize,
  tools/list, tools/call.
- `codex mcp add opencode-impl --url http://127.0.0.1:4787/mcp` + `codex mcp list`
  (Status enabled) verified.
- E2E: `codex exec` discovered `opencode-impl/opencode_ping` and called it. First
  attempt blocked: "MCP tool call requires approval, but approval policy is never";
  fixed with `default_tools_approval_mode = "approve"` on the server entry in
  `~/.codex/config.toml`. Needed for the real workflow.
- Side-finding: the global slugineer plugin fails to load under opencode 2.0.15
  (config `plugin` entry is treated as an npm package target). Pre-existing; separate fix.

Global install path: `"plugins": [{ "package":
"/path/to/gangway", "options": { "port": 4787 } }]`
in `~/.config/opencode/opencode.jsonc`. Configured paths must be directories:
the installed OpenCode 2.0.15 rejects a `src/plugin.ts` target before setup runs.
The root `index.ts` provides the directory entry point; `test/plugin.test.ts`
verifies resolution and import using OpenCode's plugin host.
Reload the project location or restart the service after installing.
Verified on 2026-10-13: the existing shared service loaded the corrected directory
target without a restart, served MCP ping and all session tools, and completed an
`opencode-go/deepseek-v4.1-flash` session replying `OK`. Endpoint and loader tests pass.

## Watchability (TUI)

Codex-created sessions are ordinary OpenCode sessions in the same service → visible
live in the TUI session list for their project directory, streamable, interruptible.

- Sessions get titles prefixed `[codex]` so they are identifiable in lists.
- `opencode_start_session` / `opencode_prompt` accept optional `sessionID` to attach
  to an existing session instead of creating one (watch-first workflow: user opens a
  session, Codex drives it).
- Sessions are created at the location matching their `directory`, so the TUI shows
  them under that project.
- Spike caveat: while only the private dev server hosts the endpoint, TUI (shared
  service) does not see those sessions. Production install fixes this.

## Milestones

0. **Spike** — done, see above.
1. **Core tools** — done: start/prompt/wait/status/result/interrupt/list verified live on
   deepseek-v4.1-flash; storage registry, `[codex]` titles, directory targeting,
   attach-to-existing-session.
2. **Permissions / multi-instance** — done: session-scoped ruleset (runtime action is
   `shell`, not `bash`; deny mirror of the global policy, ask→deny so runs never stall);
   port-collision guard unit-tested. Default agent = OpenCode's configured default.
3. **Install + polish** — global directory config and a live MCP session verified on the
   shared service; a real `codex exec` implementation task remains to be verified.

## Risks

- Codex MCP (rmcp) vs stateless transport quirks → SDK + M0 kill-gate before tool work.
- Plugin npm dependency resolution from a global config dir → fallback: hand-rolled
  JSON-RPC (~150 LOC).
- `ctx.session.wait` / status semantics on 2.0.15 → event sub + poll fallback.
- Legacy vs V2 plugin config shape on the installed opencode → verified per load path.
