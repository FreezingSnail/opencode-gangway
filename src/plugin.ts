import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_PORT } from "./mcp"
import { acquireEndpoint } from "./lifecycle"
import type { Ctx } from "./tools"

const LOG = "[gangway]"

function stateDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "gangway")
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

    try {
      return acquireEndpoint({
        port,
        ctx: ctx as unknown as Ctx,
        pluginOptions: (ctx.options ?? {}) as Record<string, unknown>,
        rendezvous: join(stateDir(), "endpoint.json"),
      })
    } catch (error) {
      console.error(`${LOG} bind on ${port} failed:`, error)
      // Report a failed plugin instead of claiming an absent endpoint is active.
      throw error
    }
  },
})
