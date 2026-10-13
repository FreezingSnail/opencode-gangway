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

## Layout

- `src/plugin.ts` — OpenCode plugin entry (`Plugin.define`), binds the MCP server.
- `src/mcp.ts` — MCP server (streamable HTTP, stateless) + tool registration.
- `test/mcp.test.ts` — integration test using a real MCP client.
