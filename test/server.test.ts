import { describe, expect, test } from "bun:test"
import { startMcpServer } from "../src/mcp"

// Multi-instance safety: OpenCode loads the plugin once per location, but only one
// instance can own the port; the others must fail fast so the plugin can skip.
describe("mcp server lifecycle", () => {
  test("bind collision throws and stop releases the port", () => {
    const first = startMcpServer({ port: 0 })
    try {
      expect(() => startMcpServer({ port: first.port })).toThrow()
    } finally {
      first.stop()
    }
  })
})
