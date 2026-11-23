import { withAppServer, type Rpc } from "./codex-app-server"

const DELAY_MS = 90_000
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const PROBE_VERDICT = "SYNTHETIC REVIEW APPROVED"

export { withAppServer }
export type { Rpc }

async function readIdleThread(rpc: Rpc, threadId: string) {
  const result = await rpc("thread/read", { threadId, includeTurns: false }) as {
    thread?: { id?: string; status?: { type?: string }; canAcceptDirectInput?: boolean; parentThreadId?: string }
  } | undefined
  if (result?.thread?.id !== threadId || result.thread.status?.type !== "idle") {
    throw new Error(`Codex thread ${threadId} must be loaded and idle on the shared App Server`)
  }
  return result.thread
}

export async function probeIdleThread(rpc: Rpc, threadId: string, deliver: boolean): Promise<void> {
  const worker = await readIdleThread(rpc, threadId)
  let recipient = threadId
  if (worker.canAcceptDirectInput === false) {
    if (!worker.parentThreadId || worker.parentThreadId === threadId) {
      throw new Error("The Codex worker requires parent delivery, but the server did not provide its parent thread")
    }
    const parent = await readIdleThread(rpc, worker.parentThreadId)
    if (parent.canAcceptDirectInput === false) throw new Error("The Codex parent cannot accept direct input")
    recipient = worker.parentThreadId
  }
  if (deliver) {
    await rpc("turn/start", {
      threadId: recipient,
      input: [],
      toolOutput: {
        name: "gangway_wake_probe",
        namespace: null,
        output: JSON.stringify({ workerThreadId: threadId, verdict: PROBE_VERDICT }),
      },
    })
  }
}

// One synthetic delivery per worker thread in this OpenCode process. Reserve
// synchronously so repeating the command while the first one is arming is safe.
const probeKey = Symbol.for("gangway.codex-wake-probes.v1")
const shared = globalThis as typeof globalThis & { [probeKey]?: Set<string> }
const probes = shared[probeKey] ??= new Set<string>()

export function createWakeProbe(
  check: (threadId: string, deliver: boolean) => Promise<void> =
    (threadId, deliver) => withAppServer((rpc) => probeIdleThread(rpc, threadId, deliver)),
  defer: (run: () => void, delayMs: number) => unknown = setTimeout,
  report: (message: string) => void = console.error,
) {
  return async (input: string): Promise<void> => {
    const threadId = input.trim().toLowerCase()
    if (!THREAD_ID.test(threadId)) throw new Error("Usage: /gangway-wake-probe <Codex worker thread UUID>")
    if (probes.has(threadId)) return
    probes.add(threadId)
    try {
      await check(threadId, false)
    } catch (error) {
      probes.delete(threadId)
      throw error
    }
    report(`[gangway] synthetic Codex wake scheduled in ${DELAY_MS / 1000}s`)
    defer(() => {
      void check(threadId, true).then(
        () => report("[gangway] Codex accepted the synthetic wake"),
        (error: unknown) => report(`[gangway] synthetic Codex wake failed: ${error instanceof Error ? error.message : String(error)}`),
      )
    }, DELAY_MS)
  }
}
