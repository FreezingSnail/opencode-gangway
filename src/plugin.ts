import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_PORT } from "./mcp"
import { acquireEndpoint } from "./lifecycle"
import { registerDispatchRpc, type DispatchRpcRegistrar } from "./dispatch-rpc"
import type { DispatchStorage } from "./dispatch-records"
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

    // Read-only dispatch inspection for the TUI. Registration is additive: an
    // older host without plugin RPC keeps the bridge tools unchanged, while the
    // TUI shows an actionable "records unavailable" state.
    const registration = registerDispatchRpc(
      (ctx as unknown as { rpc?: DispatchRpcRegistrar }).rpc,
      (ctx as unknown as { storage?: DispatchStorage }).storage,
    ).catch((error) => {
      console.error(`${LOG} dispatch RPC registration failed:`, error)
      return undefined
    })

    let release: () => void
    try {
      release = acquireEndpoint({
        port,
        ctx: ctx as unknown as Ctx,
        pluginOptions: (ctx.options ?? {}) as Record<string, unknown>,
        rendezvous: join(stateDir(), "endpoint.json"),
      })
    } catch (error) {
      void registration.then((rpc) => rpc?.dispose()).catch(() => {})
      console.error(`${LOG} bind on ${port} failed:`, error)
      // Report a failed plugin instead of claiming an absent endpoint is active.
      throw error
    }

    return () => {
      release()
      void registration.then((rpc) => rpc?.dispose()).catch(() => {})
    }
  },
})
