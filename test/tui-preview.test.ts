import { expect, test } from "bun:test"
import {
  activeTool,
  activityAge,
  assistantExcerpt,
  clipExcerpt,
  latestAction,
  latestActivityAt,
  sanitizeTerminalText,
} from "../src/tui-preview"
import type { SessionMessageInfo } from "@opencode/client"

function user(id: string, created: number, text = "prompt"): SessionMessageInfo {
  return { id, type: "user", time: { created }, text }
}

function assistant(
  id: string,
  created: number,
  content: SessionMessageInfo extends { type: "assistant"; content: infer C } ? C : never,
  time: { created: number; streamed?: number; completed?: number } = { created },
): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    time,
    agent: "build",
    model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" },
    content,
  } as SessionMessageInfo
}

function tool(
  name: string,
  status: "streaming" | "running" | "completed" | "error",
  time: { created?: number; ran?: number; completed?: number } = {},
  messageCreated = 0,
): Extract<Extract<SessionMessageInfo, { type: "assistant" }>["content"][number], { type: "tool" }> {
  const state =
    status === "streaming"
      ? { status: "streaming", input: "" }
      : status === "running"
        ? { status: "running", input: {}, metadata: {} }
        : status === "completed"
          ? { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] }
          : {
              status: "error",
              input: {},
              error: { type: "test", message: "failed", time: { created: messageCreated } },
            }
  return {
    type: "tool",
    id: `tool_${name}`,
    name,
    state,
    time: {
      created: time.created ?? messageCreated,
      ...(time.ran === undefined ? {} : { ran: time.ran }),
      ...(time.completed === undefined ? {} : { completed: time.completed }),
    },
  } as Extract<Extract<SessionMessageInfo, { type: "assistant" }>["content"][number], { type: "tool" }>
}

function text(value: string): Extract<Extract<SessionMessageInfo, { type: "assistant" }>["content"][number], { type: "text" }> {
  return { type: "text", text: value }
}

test("activeTool only reports streaming/running tools for the current turn", () => {
  const running = assistant("a1", 100, [tool("bash", "running", { ran: 150 }, 100)])
  const streaming = assistant("a2", 200, [tool("edit", "streaming", { created: 200 }, 200)])
  const messages = [user("u1", 50), running, streaming]

  expect(activeTool(messages, true)?.name).toBe("edit")
  expect(activeTool(messages, false)).toBeUndefined()

  const completed = assistant("a3", 300, [tool("read", "completed", { created: 300 }), tool("bash", "completed", { created: 300 })])
  expect(activeTool([...messages, completed], true)?.name).toBe("edit")
  expect(latestAction([...messages, completed])?.name).toBe("bash")
})

test("a stale streaming tool before a newer prompt is not active", () => {
  const stale = assistant("a1", 100, [tool("bash", "streaming", { created: 100 }, 100)])
  const messages = [user("u1", 50), stale, user("u2", 200)]

  expect(activeTool(messages, true)).toBeUndefined()
  expect(latestAction(messages)?.name).toBe("bash")
})

test("error tool states are observed but never active", () => {
  const failed = assistant("a1", 100, [tool("bash", "error", { ran: 110 }, 100)])
  const messages = [user("u1", 50), failed]

  expect(activeTool(messages, true)).toBeUndefined()
  expect(latestAction(messages)).toMatchObject({ name: "bash", status: "error", timestamp: 100, timestampSource: "message" })
})

test("tool timestamps fall back completed -> ran -> created -> message time", () => {
  const noTime = tool("grep", "completed", {}, 400)
  delete (noTime.time as { created?: number }).created
  const messages = [
    user("u1", 1),
    assistant("a1", 100, [tool("bash", "completed", { completed: 140, ran: 120, created: 110 }, 100)]),
    assistant("a2", 200, [tool("edit", "completed", { ran: 220, created: 210 }, 200)]),
    assistant("a3", 300, [tool("read", "completed", { created: 310 }, 300)]),
    assistant("a4", 400, [noTime]),
  ]

  expect(latestAction(messages)?.timestampSource).toBe("message")
  expect(latestAction(messages)?.timestamp).toBe(400)

  const withoutLast = messages.slice(0, 4)
  const read = latestAction(withoutLast)
  expect(read).toMatchObject({ name: "read", timestamp: 310, timestampSource: "created" })

  const almost = messages.slice(0, 3)
  expect(latestAction(almost)).toMatchObject({ name: "edit", timestamp: 220, timestampSource: "ran" })

  expect(latestAction(messages.slice(0, 2))).toMatchObject({ name: "bash", timestamp: 140, timestampSource: "completed" })
})

test("assistantExcerpt marks output that predates a newer prompt as earlier", () => {
  const messages = [
    user("u1", 10),
    assistant("a1", 20, [text("old answer")], { created: 20, completed: 25 }),
    user("u2", 30),
    assistant("a2", 40, [text("new answer")], { created: 40, completed: 45 }),
  ]

  expect(assistantExcerpt(messages)).toMatchObject({ text: "new answer", earlier: false, timestamp: 45 })

  const beforeNewPrompt = [user("u1", 10), assistant("a1", 20, [text("answer")], { created: 20, completed: 25 }), user("u2", 30)]
  expect(assistantExcerpt(beforeNewPrompt)).toMatchObject({ text: "answer", earlier: true, timestamp: 25 })
})

test("assistantExcerpt ignores reasoning and tool parts and bounds the text", () => {
  const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n")
  const messages = [
    user("u1", 10),
    assistant("a1", 20, [
      { type: "reasoning", text: "secret reasoning" },
      tool("bash", "completed", { created: 20 }),
      text(`\u001b[31m${long}\u001b[0m`),
    ]),
  ]

  const excerpt = assistantExcerpt(messages, { maxChars: 80, maxLines: 3 })
  expect(excerpt?.text.startsWith("…")).toBe(true)
  expect(excerpt?.text).not.toContain("\u001b")
  expect(excerpt?.text).not.toContain("secret reasoning")
  expect(excerpt?.text.length).toBeLessThanOrEqual(80)
  expect(excerpt?.text.split("\n").length).toBeLessThanOrEqual(3)
  expect(excerpt?.truncated).toBe(true)
})

test("clipExcerpt keeps terminal-safe text within both bounds", () => {
  const clipped = clipExcerpt("a\tb\u0007\r\nc", { maxChars: 100, maxLines: 10 })
  expect(clipped).toEqual({ text: "a  b\nc", truncated: false })

  const lines = clipExcerpt("one\ntwo\nthree\nfour", { maxLines: 2 })
  expect(lines.text).toBe("…three\nfour")

  const chars = clipExcerpt("0123456789", { maxChars: 5 })
  expect(chars.text).toBe("…6789")
  expect(chars.text.length).toBe(5)
})

test("sanitizeTerminalText strips ANSI and control sequences", () => {
  expect(sanitizeTerminalText("\u001b]0;title\u0007hello\u001b[1m world\u001b[0m")).toBe("hello world")
  expect(sanitizeTerminalText("a\r\nb\tc\u0000d")).toBe("a\nb  cd")
})

test("latestActivityAt falls back to session metadata and takes the newest message activity", () => {
  const messages = [
    user("u1", 100),
    assistant("a1", 200, [tool("bash", "completed", { completed: 500 })], { created: 200, streamed: 300 }),
  ]

  expect(latestActivityAt(messages, 50)).toBe(500)
  expect(latestActivityAt([], 900)).toBe(900)
  expect(latestActivityAt([user("u1", 100)], 0)).toBe(100)
  expect(latestActivityAt([assistant("a1", 200, [text("x")], { created: 200, completed: 250 })], 0)).toBe(250)
})

test("shell messages contribute to the latest action", () => {
  const shell: SessionMessageInfo = {
    id: "s1",
    type: "shell",
    time: { created: 100, completed: 150 },
    shellID: "sh1",
    command: "bun test",
    status: "exited",
    exit: 0,
  }
  const messages = [user("u1", 10), shell]
  expect(latestAction(messages)).toMatchObject({
    kind: "shell",
    name: "bun test",
    status: "completed",
    timestamp: 150,
    timestampSource: "completed",
  })
})

test("activityAge labels recent and missing timestamps", () => {
  const now = 1_000_000_000
  expect(activityAge(now, now)).toBe("just now")
  expect(activityAge(now - 120_000, now)).toBe("2m ago")
  expect(activityAge(undefined, now)).toBe("unknown")
})
