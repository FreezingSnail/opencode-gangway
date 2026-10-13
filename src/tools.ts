import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

export const TAG = "[codex]"
export const DEFAULT_MODEL = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
export const DEFAULT_WAIT_MS = 10 * 60 * 1000
export const DEFAULT_MAX_CHARS = 20_000

// Unattended sessions cannot answer permission prompts, so the bridge installs a
// session-scoped ruleset at create time. It mirrors the user's global policy, but
// turns "ask" decisions into "deny" so the agent gets an error instead of stalling.
export const UNATTENDED_DENY: Array<{ action: string; resource: string }> = [
  { action: "shell", resource: "perl*" },
  { action: "shell", resource: "ruby*" },
  { action: "shell", resource: "lua*" },
  { action: "shell", resource: "php*" },
  { action: "shell", resource: "Rscript*" },
  { action: "shell", resource: "gem*" },
  { action: "shell", resource: "cpan*" },
  { action: "shell", resource: "rm -rf *" },
  { action: "shell", resource: "git push*" },
  { action: "shell", resource: "git clone*" },
  { action: "shell", resource: "git submodule*" },
  { action: "shell", resource: "wget*" },
  { action: "shell", resource: "curl*-o*" },
  { action: "shell", resource: "curl*--output*" },
  { action: "shell", resource: "DROP *" },
]

function unattendedRuleset(): Array<{ action: string; resource: string; effect: string }> {
  return [
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    ...UNATTENDED_DENY.map((rule) => ({ ...rule, effect: "deny" })),
  ]
}


// Minimal structural view of the OpenCode plugin context. Intentionally loose:
// the runtime shape is the contract (see the server OpenAPI document), and the
// published types may lag the installed service version.
export interface Ctx {
  location?: { directory?: string }
  options?: Record<string, unknown>
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
    get(input: { sessionID: string }): Promise<Record<string, any>>
    context(input: { sessionID: string }): Promise<unknown>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    interrupt(input: { sessionID: string; continue: boolean }): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
  }
  storage: {
    set(key: string, value: unknown): Promise<void>
    scan(input: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: Array<{ key: string; value: unknown }>
      next?: string
    }>
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = "TimeoutError"
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function parseModel(input?: string): { providerID: string; id: string } {
  if (!input) return { ...DEFAULT_MODEL }
  const slash = input.indexOf("/")
  if (slash <= 0 || slash === input.length - 1) {
    throw new Error(`invalid model "${input}", expected "provider/modelID"`)
  }
  return { providerID: input.slice(0, slash), id: input.slice(slash + 1) }
}

function short(text: string, length = 60): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

async function transcript(ctx: Ctx, sessionID: string): Promise<any[]> {
  const result: any = await ctx.session.context({ sessionID })
  if (Array.isArray(result)) return result
  return Array.isArray(result?.data) ? result.data : []
}

async function lastAssistant(ctx: Ctx, sessionID: string) {
  const all = await transcript(ctx, sessionID)
  const assistants = all.filter((message) => message?.type === "assistant")
  const last = assistants.at(-1)
  const tail = all.at(-1)
  const content: any[] = Array.isArray(last?.content) ? last.content : []
  return {
    text: content
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim(),
    model: last?.model ?? null,
    cost: last?.cost ?? null,
    tokens: last?.tokens ?? null,
    finish: last?.finish ?? null,
    error: last?.error ?? null,
    lastMessageType: tail?.type ?? null,
    idle: tail?.type === "idle",
    outcome: tail?.type === "idle" ? (tail.outcome ?? null) : null,
  }
}

async function waitForIdle(ctx: Ctx, sessionID: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  try {
    await withTimeout(Promise.resolve(ctx.session.wait({ sessionID })), timeoutMs)
    return true
  } catch (error) {
    if (error instanceof TimeoutError) return false
    // ctx.session.wait may be unavailable on older services; fall back to
    // polling the transcript for a trailing idle message.
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const latest = await lastAssistant(ctx, sessionID)
      if (latest.idle) return true
    }
    return false
  }
}

function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] }
}

export function registerCodexTools(
  server: McpServer,
  ctx: Ctx,
  options: { defaultWaitMs?: number; inheritPermissions?: boolean } = {},
) {
  const defaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS
  const permissions = options.inheritPermissions ? undefined : unattendedRuleset()

  server.registerTool(
    "opencode_start_session",
    {
      description:
        "Start an OpenCode implementation session (defaults to model opencode-go/deepseek-v4.1-flash) and send it an initial prompt. Returns the session ID; pass wait=true to block until the run finishes.",
      inputSchema: {
        prompt: z.string().describe("Implementation task for the OpenCode session"),
        sessionID: z.string().optional().describe("Attach to an existing session instead of creating one"),
        title: z.string().optional().describe("Session title; gets a [codex] prefix"),
        directory: z.string().optional().describe("Project directory; defaults to the plugin instance location"),
        agent: z.string().optional().describe("OpenCode agent ID"),
        model: z.string().optional().describe('"provider/modelID"; defaults to opencode-go/deepseek-v4.1-flash'),
        wait: z.boolean().optional().describe("Block until the session goes idle"),
        timeoutMs: z.number().int().positive().optional().describe("Max wait time"),
      },
    },
    async (args) => {
      if (args.sessionID) {
        await ctx.session.get({ sessionID: args.sessionID })
        await ctx.session.prompt({ sessionID: args.sessionID, text: args.prompt })
        if (!args.wait) return reply({ sessionID: args.sessionID, status: "queued" })
        const idle = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
        const latest = await lastAssistant(ctx, args.sessionID)
        return reply({ sessionID: args.sessionID, status: idle ? "idle" : "busy", ...latest })
      }

      const model = parseModel(args.model)
      const title = `${TAG} ${args.title ?? short(args.prompt)}`
      const created = await ctx.session.create({
        title,
        model,
        ...(args.directory ? { location: { directory: args.directory } } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
        ...(permissions ? { permissions } : {}),
        metadata: { codexMcp: true },
      })
      await ctx.session.prompt({ sessionID: created.id, text: args.prompt })
      await ctx.storage.set(`sessions/${created.id}`, {
        sessionID: created.id,
        title,
        model,
        directory: args.directory ?? ctx.location?.directory ?? null,
        createdAt: Date.now(),
      })
      if (!args.wait) return reply({ sessionID: created.id, status: "started" })
      const idle = await waitForIdle(ctx, created.id, args.timeoutMs ?? defaultWaitMs)
      const latest = await lastAssistant(ctx, created.id)
      return reply({ sessionID: created.id, status: idle ? "idle" : "busy", ...latest })
    },
  )

  server.registerTool(
    "opencode_prompt",
    {
      description: "Send a follow-up prompt to an existing OpenCode session.",
      inputSchema: {
        sessionID: z.string().describe("Session ID (ses_...)"),
        text: z.string(),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      await ctx.session.get({ sessionID: args.sessionID })
      await ctx.session.prompt({ sessionID: args.sessionID, text: args.text })
      if (!args.wait) return reply({ sessionID: args.sessionID, status: "queued" })
      const idle = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
      const latest = await lastAssistant(ctx, args.sessionID)
      return reply({ sessionID: args.sessionID, status: idle ? "idle" : "busy", ...latest })
    },
  )

  server.registerTool(
    "opencode_wait",
    {
      description: "Block until an OpenCode session finishes its current run, then return the latest assistant output.",
      inputSchema: {
        sessionID: z.string(),
        timeoutMs: z.number().int().positive().optional().describe("Defaults to 10 minutes"),
      },
    },
    async (args) => {
      const idle = await waitForIdle(ctx, args.sessionID, args.timeoutMs ?? defaultWaitMs)
      const latest = await lastAssistant(ctx, args.sessionID)
      return reply({ sessionID: args.sessionID, status: idle ? "idle" : "busy", ...latest })
    },
  )

  server.registerTool(
    "opencode_status",
    {
      description: "Report an OpenCode session's state plus a tail of its latest assistant output.",
      inputSchema: { sessionID: z.string() },
    },
    async (args) => {
      const info: any = await ctx.session.get({ sessionID: args.sessionID })
      const latest = await lastAssistant(ctx, args.sessionID)
      return reply({
        sessionID: args.sessionID,
        title: info.title ?? null,
        agent: info.agent ?? null,
        model: info.model ?? null,
        outcome: info.outcome ?? null,
        time: info.time ?? null,
        tokens: info.tokens ?? null,
        cost: info.cost ?? null,
        lastMessageType: latest.lastMessageType,
        idle: latest.idle,
        tail: short(latest.text, 500),
      })
    },
  )

  server.registerTool(
    "opencode_result",
    {
      description: "Return the latest assistant output of an OpenCode session (truncated at maxChars).",
      inputSchema: {
        sessionID: z.string(),
        maxChars: z.number().int().positive().optional().describe("Defaults to 20000"),
      },
    },
    async (args) => {
      const latest = await lastAssistant(ctx, args.sessionID)
      const cap = args.maxChars ?? DEFAULT_MAX_CHARS
      const truncated = latest.text.length > cap
      return reply({
        sessionID: args.sessionID,
        text: truncated ? latest.text.slice(0, cap) : latest.text,
        truncated,
        model: latest.model,
        finish: latest.finish,
        outcome: latest.outcome,
        tokens: latest.tokens,
        cost: latest.cost,
        error: latest.error,
      })
    },
  )

  server.registerTool(
    "opencode_interrupt",
    {
      description: "Interrupt the current run of an OpenCode session.",
      inputSchema: { sessionID: z.string() },
    },
    async (args) => {
      await ctx.session.interrupt({ sessionID: args.sessionID, continue: false })
      return reply({ sessionID: args.sessionID, status: "interrupted" })
    },
  )

  server.registerTool(
    "opencode_list",
    {
      description: "List OpenCode sessions started through this MCP bridge.",
      inputSchema: { limit: z.number().int().positive().optional().describe("Defaults to 20") },
    },
    async (args) => {
      const entries: Array<Record<string, any>> = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({
          prefix: "sessions/",
          ...(after ? { after } : {}),
          limit: 100,
        })
        for (const entry of page.entries) {
          if (entry.value && typeof entry.value === "object") {
            entries.push(entry.value as Record<string, any>)
          }
        }
        after = page.next
      } while (after)

      entries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      const limit = args.limit ?? 20
      const sessions = await Promise.all(
        entries.slice(0, limit).map(async (entry) => {
          try {
            const info: any = await ctx.session.get({ sessionID: entry.sessionID })
            return { ...entry, outcome: info.outcome ?? null, updated: info.time?.updated ?? null }
          } catch {
            return { ...entry, outcome: "missing" }
          }
        }),
      )
      return reply({ sessions, total: entries.length })
    },
  )
}
