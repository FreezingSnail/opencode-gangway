# opencode-codex-mcp

MCP bridge that lets Codex start and drive OpenCode implementation sessions running
`opencode-go/deepseek-v4.1-flash`.

Status: **M0 spike** — plugin loads, MCP server binds, `opencode_ping` handshake verified.
Session tools land in M1; see `PLAN.md`.

## Dev

```sh
bun install

# run a private OpenCode server that auto-loads the project-local plugin
.opencode/plugins/codex-mcp/  (loaded automatically)
opencode serve --port 4111 --print-logs

# verify the MCP endpoint
MCP_URL=http://127.0.0.1:4787/mcp bun test

# register with Codex
codex mcp add opencode-impl --url http://127.0.0.1:4787/mcp
codex mcp list
```

Codex blocks MCP tool calls under restrictive approval policies; add this to the
`[mcp_servers.opencode-impl]` section in `~/.codex/config.toml`:

```toml
default_tools_approval_mode = "approve"
```

## M0 status

Verified end-to-end: plugin loads, MCP endpoint binds, SDK client handshake test
passes, Codex discovers and calls `opencode_ping`. Local machine only (loopback
bind, no token). Session tools land in M1.

## Layout

- `src/plugin.ts` — OpenCode plugin entry (`Plugin.define`), binds the MCP server.
- `src/mcp.ts` — MCP server (streamable HTTP, stateless) + tool registration.
- `test/mcp.test.ts` — integration test using a real MCP client.
