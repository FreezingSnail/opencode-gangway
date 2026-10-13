import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_PORT, startMcpServer, type McpServerHandle } from "./mcp"
import type { Ctx } from "./tools"

const LOG = "[gangway]"

function configDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
}

export default Plugin.define({
  id: "gangway",
  setup(ctx) {
    const port =
      typeof ctx.options?.port === "number" && Number.isInteger(ctx.options.port)
        ? (ctx.options.port as number)
        : DEFAULT_PORT
    const directory = ctx.location?.directory ?? "?"
    console.error(`${LOG} setup in ${directory}`)

    let server: McpServerHandle
    try {
      server = startMcpServer({
        port,
        ctx: ctx as unknown as Ctx,
        pluginOptions: (ctx.options ?? {}) as Record<string, unknown>,
      })
    } catch (error) {
      console.error(`${LOG} bind on ${port} failed (another instance?):`, error)
      return
    }

    const rendezvous = join(configDir(), "gangway.json")
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
