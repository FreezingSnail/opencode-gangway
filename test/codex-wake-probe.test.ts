import { expect, test } from "bun:test"
import { createWakeProbe, probeIdleThread, PROBE_VERDICT, withAppServer } from "../src/codex-wake-probe"

test("a repeated wake probe sends one verdict to the parent of a V2 worker", async () => {
  const worker = crypto.randomUUID()
  const parent = crypto.randomUUID()
  const messages: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = []
  const sent = Promise.withResolvers<void>()
  const scheduled: Array<() => void> = []

  class MockSocket extends EventTarget {
    send(data: string) {
      const message = JSON.parse(data) as (typeof messages)[number]
      messages.push(message)
      if (message.id === undefined) return
      const threadId = message.params?.threadId
      const result = message.method === "thread/read" ? {
        thread: {
          id: threadId,
          status: { type: "idle" },
          parentThreadId: threadId === worker ? parent : null,
          canAcceptDirectInput: threadId !== worker,
        },
      } : {}
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method: "thread/status/changed" }) }))
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) }))
    }

    close() {
      this.dispatchEvent(new Event("close"))
    }
  }

  const probe = createWakeProbe(
    (id, deliver) => withAppServer((rpc) => probeIdleThread(rpc, id, deliver), (url) => {
      expect(url).toMatch(/^ws\+unix:\/\/.*\/app-server-control\/app-server-control\.sock$/)
      const socket = new MockSocket()
      queueMicrotask(() => socket.dispatchEvent(new Event("open")))
      return socket as unknown as WebSocket
    }),
    (run, delay) => {
      expect(delay).toBe(90_000)
      scheduled.push(run)
    },
    (report) => {
      if (report.includes("accepted")) sent.resolve()
    },
  )

  await Promise.all([probe(worker), probe(worker)])
  expect(scheduled).toHaveLength(1)
  expect(messages.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/read", "thread/read"])
  scheduled[0]()
  await sent.promise
  await probe(worker)
  expect(scheduled).toHaveLength(1)
  expect(messages.filter((message) => message.method === "turn/start")).toEqual([{
    id: 4,
    method: "turn/start",
    params: {
      threadId: parent,
      input: [],
      toolOutput: {
        name: "gangway_wake_probe",
        namespace: null,
        output: JSON.stringify({ workerThreadId: worker, verdict: PROBE_VERDICT }),
      },
    },
  }])
})

test("an unloaded worker is never sent a verdict", async () => {
  const worker = crypto.randomUUID()
  const methods: string[] = []

  await expect(probeIdleThread(async (method) => {
    methods.push(method)
    return { thread: { id: worker, status: { type: "notLoaded" } } }
  }, worker, true)).rejects.toThrow("must be loaded and idle")
  expect(methods).toEqual(["thread/read"])
})
