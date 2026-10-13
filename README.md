# gangway

MCP bridge that lets Codex start and drive OpenCode implementation sessions running
`opencode-go/deepseek-v4.1-flash`. Local machine only: the endpoint binds `127.0.0.1`.

Global loading and a live model session verified on OpenCode 2.0.15.

## Tools

| Tool | Notes |
|---|---|
| `opencode_start_session` | `prompt`, `title?`, `directory?`, `agent?`, `model?`, `wait?`, `timeoutMs?` |
| `opencode_prompt` | follow-up prompt; `wait?` optional |
| `opencode_wait` | block until idle (default cap 10 min) |
| `opencode_status` | session info + output tail |
| `opencode_result` | latest assistant output |
| `opencode_interrupt` | stop current run |
| `opencode_list` | sessions started via the bridge |

Sessions get a `[codex]` title prefix and a session-scoped permission ruleset: edit and
shell allowed, destructive/mirror-denied commands (`git push`, `rm -rf`, `perl*`, …) denied
so unattended runs cannot stall on approval prompts. `inheritPermissions` plugin option
restores default behavior.

## Dev

```sh
bun install

# private OpenCode server; the project-local plugin loads from .opencode/plugins/
opencode serve --port 4111 --print-logs

# tests (static suite needs the endpoint; live suite starts real sessions)
bun test
RUN_LIVE=1 bun test
```

## Codex setup

```sh
codex mcp add gangway --url http://127.0.0.1:4787/mcp
```

Add to `~/.codex/config.toml` under `[mcp_servers.gangway]`:

```toml
default_tools_approval_mode = "approve"
```

MCP clients time out long tool calls (SDK default 60s), so prefer
`opencode_start_session` without `wait`, then `opencode_wait` / `opencode_status`.

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
- `test/server.test.ts` — port collision / lifecycle.
- `test/plugin.test.ts` — package directory resolution and import.
