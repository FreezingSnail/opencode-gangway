# Gangway

Run OpenCode sessions from a local MCP client.

## Install

Install Bun and OpenCode, then run `bun install` in the Gangway checkout.
Add Gangway to `~/.config/opencode/opencode.jsonc`.

```jsonc
{
  "plugins": [
    { "package": "/absolute/path/to/gangway", "options": { "port": 4787 } }
  ]
}
```

Use the checkout directory as the package path. Run `opencode reload` and open a project.
Register `http://127.0.0.1:4787/mcp` as a Streamable HTTP MCP server.

```sh
# Codex
codex mcp add gangway --url http://127.0.0.1:4787/mcp

# Claude Code
claude mcp add --transport http gangway http://127.0.0.1:4787/mcp
```

Call `opencode_ping` to check the endpoint.

## Use

1. Call `opencode_start_session` with `prompt`, `directory`, and a stable `requestID`. Keep the returned IDs.
2. Use `opencode_wait` or `opencode_status` with `reconcile: true` and the same IDs. The default wait budget is 45 seconds. The run continues after a timeout.
3. If `needsInput` is set, answer in OpenCode and resume waiting. Read the output with `opencode_result`.

Keep one run per session. Use `opencode_prompt` with a new `requestID` for a follow-up.
After a timeout or unknown outcome, inspect the existing request before retrying. If the session ID is missing, use `opencode_delivery` with the request ID alone.
Use `opencode_list` to find sessions and `opencode_interrupt` to stop a run.

In OpenCode, use `/gangway` or `Ctrl+X D` to open the session panel. Press `1` for active runs here, `2` for active runs everywhere, or `3` for history. Press `Enter` to open a session.

### Codex push

Add `"codexDelivery": true` to the Gangway plugin options and run `opencode reload`.
Connect the Codex TUI to the shared local App Server with `codex --remote unix://`.

Dispatch with `requestID`, `notify: true`, and `wait: false`. If a pending run returns `notify.state: "armed"`, end the turn without polling. Otherwise use the wait flow above.

Gangway pushes new input requests and the terminal result. Answer input requests in OpenCode. If a worker's result goes to its parent, the parent resumes the same worker with a native subagent follow-up.

If a push is missing, inspect with `opencode_delivery` and read the result with `opencode_result`. Use `action: "deliver"` for a result with no prior attempt or `action: "retry"` after a preflight failure.
