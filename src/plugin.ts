import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_PORT, startMcpServer, type McpServerHandle } from "./mcp"

const LOG = "[codex-mcp]"

function configDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
}

export default Plugin.define({
  id: "codex-mcp",
  setup(ctx) {
    const port = DEFAULT_PORT
    const directory = ctx.location?.directory ?? "?"
    console.error(`${LOG} setup in ${directory}`)

    let server: McpServerHandle
    try {
      server = startMcpServer({ port })
    } catch (error) {
      console.error(`${LOG} bind on ${port} failed (another instance?):`, error)
      return
    }

    const rendezvous = join(configDir(), "codex-mcp.json")
    try {
      mkdirSync(dirname(rendezvous), { recursive: true })
      writeFileSync(
        rendezvous,
        JSON.stringify(
          { url: `http://127.0.0.1:${server.port}/mcp`, port: server.port, pid: process.pid },
          null,
          2,
        ),
      )
    } catch (error) {
      console.error(`${LOG} rendezvous write failed:`, error)
    }

    console.error(`${LOG} listening on http://127.0.0.1:${server.port}/mcp`)

    return () => {
      console.error(`${LOG} stopping`)
      try {
        server.stop()
      } catch {}
      try {
        rmSync(rendezvous, { force: true })
      } catch {}
    }
  },
})
