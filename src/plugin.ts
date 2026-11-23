import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_PORT } from "./mcp"
import { acquireEndpoint } from "./lifecycle"
import { registerDispatchRpc, type DispatchRpcRegistrar } from "./dispatch-rpc"
import type { DispatchStorage } from "./dispatch-records"
import { codexDeliveryEnabled, type Ctx } from "./tools"
import { startExecutionMonitor, type ExecutionMonitor } from "./execution-events"
import {
  deliverRecordedAttention,
  deliverRecordedOperation,
  preflightDeliveryTarget,
} from "./codex-delivery"
import {
  clearCodexReadiness,
  setCodexReadiness,
  updateCodexReadiness,
} from "./codex-readiness"
import { createWakeProbe } from "./codex-wake-probe"

const LOG = "[gangway]"
const checkout = dirname(dirname(fileURLToPath(import.meta.url)))

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
    const readinessDirectory = ctx.location?.directory ?? null
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

    // Subscribe before the endpoint can serve a dispatch so a fast run cannot
    // finish before its first event is observed. Reconnects reconcile recorded
    // operations that finished while the stream was down; those terminal
    // outcomes are delivered through the same durable, deduped path.
    const deliveryEnabled = codexDeliveryEnabled(ctx.options as Record<string, unknown> | undefined)
    let monitor: ExecutionMonitor
    let disposed = false
    let readinessOwner: object | undefined
    const publishReadiness = (monitorError: string | null = null) => {
      if (disposed) return
      const readiness = {
        deliveryEnabled,
        monitorAvailable: monitor.available,
        monitorError,
        verifyTarget: async (threadId) => {
          await preflightDeliveryTarget(threadId, { timeoutMs: 4_000 })
        },
      }
      if (!readinessOwner) readinessOwner = setCodexReadiness(readinessDirectory, readiness)
      else updateCodexReadiness(readinessDirectory, readiness, readinessOwner)
    }
    const deliver = (requestID: string, attentionKey?: string) => {
      if (!deliveryEnabled) return
      const pending = attentionKey
        ? deliverRecordedAttention(ctx as unknown as Ctx, requestID, attentionKey)
        : deliverRecordedOperation(ctx as unknown as Ctx, requestID)
      void pending.then(
        (delivery) => {
          if (delivery.status === "accepted" || delivery.status === "skipped") return
          console.error(
            `${LOG} Codex outcome delivery ${delivery.status} for ${requestID}: ${delivery.error ?? delivery.reason ?? "unknown"}`,
          )
        },
        (error) => {
          console.error(`${LOG} Codex outcome delivery failed:`, error)
        },
      )
    }
    monitor = startExecutionMonitor(ctx as unknown as Ctx, {
      onError(error) {
        console.error(`${LOG} execution event stream:`, error)
        updateCodexReadiness(readinessDirectory, {
          monitorAvailable: monitor.available,
          monitorError: error instanceof Error ? error.message : String(error),
        }, readinessOwner)
      },
      onSubscribed() {
        updateCodexReadiness(readinessDirectory, {
          monitorAvailable: true,
          monitorError: null,
        }, readinessOwner)
      },
      onUnsubscribed() {
        updateCodexReadiness(readinessDirectory, {
          monitorAvailable: false,
          monitorError: "execution event subscription is disconnected",
        }, readinessOwner)
      },
      onDeliveryReconciled(candidates) {
        for (const candidate of candidates) {
          if (candidate.result) deliver(candidate.requestID)
          for (const attentionKey of candidate.attentionKeys) {
            deliver(candidate.requestID, attentionKey)
          }
        }
      },
      onEvent(_event, result) {
        if (!result.handled || !result.requestID) return
        if (result.terminal) {
          deliver(result.requestID)
        } else if (result.attentionKey) {
          deliver(result.requestID, result.attentionKey)
        }
      },
    })
    publishReadiness()
    void monitor.ready.then(
      () => publishReadiness(null),
      (error) => {
        console.error(`${LOG} execution event subscription failed:`, error)
        publishReadiness(error instanceof Error ? error.message : String(error))
      },
    )

    let release: () => void
    try {
      release = acquireEndpoint({
        port,
        ctx: ctx as unknown as Ctx,
        pluginOptions: (ctx.options ?? {}) as Record<string, unknown>,
        rendezvous: join(stateDir(), "endpoint.json"),
      })
    } catch (error) {
      disposed = true
      monitor.stop()
      clearCodexReadiness(readinessDirectory, readinessOwner)
      void registration.then((rpc) => rpc?.dispose()).catch(() => {})
      console.error(`${LOG} bind on ${port} failed:`, error)
      // Report a failed plugin instead of claiming an absent endpoint is active.
      throw error
    }

    const wakeProbe = createWakeProbe()
    const command = directory === checkout
      ? ctx.command.transform((editor) => {
          editor.add({
            name: "gangway-wake-probe",
            description: "Send one synthetic verdict to an idle Codex worker after 90 seconds",
            execute: ({ prompt }) => wakeProbe(prompt.text ?? ""),
          })
        }).catch((error) => {
          console.error(`${LOG} wake probe command registration failed:`, error)
          return undefined
        })
      : undefined

    return () => {
      disposed = true
      monitor.stop()
      clearCodexReadiness(readinessDirectory, readinessOwner)
      release()
      void command?.then((registration) => registration?.dispose()).catch(() => {})
      void registration.then((rpc) => rpc?.dispose()).catch(() => {})
    }
  },
})
