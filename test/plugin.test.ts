import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"
import gangwayPlugin from "../src/plugin"
import { clearCodexReadiness, codexReadinessFor } from "../src/codex-readiness"

test("OpenCode resolves and loads the configured package directory", async () => {
  const directory = fileURLToPath(new URL("../", import.meta.url))
  const entrypoints = Host.resolve({ directory })
  expect(entrypoints.server).toBe(new URL("../index.ts", import.meta.url).href)
  const module = await Host.load(entrypoints.server!) as { default: { id: string; setup: unknown } }
  expect(module.default.id).toBe("gangway")
  expect(typeof module.default.setup).toBe("function")
})

test("OpenCode resolves the TUI entrypoint", () => {
  const directory = fileURLToPath(new URL("../", import.meta.url))
  const entrypoints = Host.resolve({ directory })
  expect(entrypoints.tui).toBe(new URL("../tui.ts", import.meta.url).href)
})

test("plugin glue publishes a live monitor lease and stale teardown preserves the replacement", async () => {
  const directory = `${process.cwd()}/src/..`
  const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") })
  const port = portProbe.port
  portProbe.stop()
  const waitForMonitor = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (codexReadinessFor(directory)?.monitorAvailable) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error("plugin monitor did not become ready")
  }
  const makeContext = () => ({
    options: { port, codexDelivery: true },
    location: { directory },
    storage: {
      async set() {},
      async get() { return null },
      async scan() { return { entries: [], next: undefined } },
    },
    session: {
      async create() { return { id: "ses_plugin_test" } },
      async get() { return {} },
      async context() { return [] },
      async prompt() { return {} },
      async interrupt() { return {} },
      async wait() { return {} },
    },
    event: {
      subscribe({ signal }: { signal?: AbortSignal } = {}) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve()
              signal?.addEventListener("abort", () => resolve(), { once: true })
            })
          },
        }
      },
    },
  })

  clearCodexReadiness(directory)
  const firstDispose = (gangwayPlugin as any).setup(makeContext()) as () => void
  await waitForMonitor()
  expect(codexReadinessFor(process.cwd())?.deliveryEnabled).toBe(true)

  const secondDispose = (gangwayPlugin as any).setup(makeContext()) as () => void
  await waitForMonitor()
  firstDispose()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(codexReadinessFor(directory)?.monitorAvailable).toBe(true)

  secondDispose()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(codexReadinessFor(directory)).toBeNull()
})
