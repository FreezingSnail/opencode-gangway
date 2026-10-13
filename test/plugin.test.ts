import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

test("OpenCode resolves and loads the configured package directory", async () => {
  const directory = fileURLToPath(new URL("../", import.meta.url))
  const entrypoints = Host.resolve({ directory })
  expect(entrypoints.server).toBe(new URL("../index.ts", import.meta.url).href)
  const module = await Host.load(entrypoints.server!) as { default: { id: string; setup: unknown } }
  expect(module.default.id).toBe("gangway")
  expect(typeof module.default.setup).toBe("function")
})
