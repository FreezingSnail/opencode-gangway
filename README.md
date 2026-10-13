# opencode-codex-mcp

MCP bridge that lets Codex start and drive OpenCode implementation sessions running
`opencode-go/deepseek-v4.1-flash`. Local machine only: the endpoint binds `127.0.0.1`.

Status: **M1** — session tools verified end-to-end; global install pending.

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
codex mcp add opencode-impl --url http://127.0.0.1:4787/mcp
```

Add to `~/.codex/config.toml` under `[mcp_servers.opencode-impl]`:

```toml
default_tools_approval_mode = "approve"
```

MCP clients time out long tool calls (SDK default 60s), so prefer
`opencode_start_session` without `wait`, then `opencode_wait` / `opencode_status`.

## Global install (pending)

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "/Users/connorfranc/dev/opencode-codex-mcp/src/plugin.ts", "options": { "port": 4787 } }
  ]
}
```

Then restart the OpenCode service (this ends any open TUI session). Multiple locations
load the plugin; the first instance owns `127.0.0.1:4787`, the rest skip (port-collision
guard covered by `test/server.test.ts`). A rendezvous file is written to
`~/.config/opencode/codex-mcp.json` while the endpoint is live.

## Layout

- `src/plugin.ts` — plugin entry (`Plugin.define`), binds the MCP server, rendezvous file.
- `src/mcp.ts` — MCP server (streamable HTTP, stateless) + tool registration.
- `src/tools.ts` — session tools, permission ruleset, wait/result logic.
- `test/mcp.test.ts` — endpoint suite + `RUN_LIVE` session suite.
- `test/server.test.ts` — port collision / lifecycle.
