// Shared Codex App Server socket transport.
//
// The synthetic wake probe and the opt-in outcome delivery layer both need the
// same local Unix-socket JSON-RPC handshake. This module keeps that handshake in
// one place and makes send/response failure phases explicit so callers can tell
// a safe preflight failure from an ambiguous effectful request.

import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_RPC_TIMEOUT_MS = 5_000

export type AppServerErrorKind = "connect" | "disconnect" | "timeout" | "rpc" | "invalid" | "send"

export class AppServerError extends Error {
  readonly kind: AppServerErrorKind
  // True when the JSON-RPC request bytes were handed to the socket. A timeout,
  // disconnect or invalid reply after this point is ambiguous for an effectful
  // method such as turn/start.
  readonly sent: boolean
  readonly code: number | undefined
  // True for non-effectful handshake/initialization failures. Even though the
  // bytes were written, no turn can have started, so the caller may retry.
  readonly preflight: boolean

  constructor(
    message: string,
    kind: AppServerErrorKind,
    sent: boolean,
    code?: number,
    preflight = false,
  ) {
    super(message)
    this.name = "AppServerError"
    this.kind = kind
    this.sent = sent
    this.code = code
    this.preflight = preflight
  }
}

export interface RpcOptions {
  timeoutMs?: number
  onSent?: () => void
}

export type Rpc = (
  method: string,
  params: Record<string, unknown>,
  options?: RpcOptions,
) => Promise<unknown>

export interface AppServerOptions {
  socketPath?: string
  timeoutMs?: number
  clientInfo?: { name: string; title: string; version: string }
}

export function defaultAppServerSocketPath(): string {
  return join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "app-server-control",
    "app-server-control.sock",
  )
}

type Pending = {
  reject(error: AppServerError): void
  sent(): boolean
}

export async function withAppServer<T>(
  run: (rpc: Rpc) => Promise<T>,
  connect: (url: string) => WebSocket = (url) => new WebSocket(url),
  options: AppServerOptions = {},
): Promise<T> {
  const socketPath = options.socketPath ?? defaultAppServerSocketPath()
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
  const socket = connect(`ws+unix://${socketPath}`)
  const pending = new Set<Pending>()
  const opened = Promise.withResolvers<void>()
  let closed = false
  let openSettled = false

  const openTimer = setTimeout(() => {
    if (openSettled) return
    openSettled = true
    opened.reject(new AppServerError("Codex App Server connection timed out", "timeout", false))
  }, timeoutMs)

  const fail = (kind: AppServerErrorKind, message: string) => {
    if (closed) return
    closed = true
    if (!openSettled) {
      openSettled = true
      opened.reject(new AppServerError(message, kind, false))
    }
    for (const entry of pending) {
      entry.reject(new AppServerError(message, kind, entry.sent()))
    }
    pending.clear()
  }

  const disconnected = () =>
    fail("disconnect", "Cannot reach the shared Codex App Server socket from OpenCode")

  socket.addEventListener("open", () => {
    if (openSettled) return
    openSettled = true
    opened.resolve()
  }, { once: true })
  socket.addEventListener("close", disconnected, { once: true })
  socket.addEventListener("error", disconnected, { once: true })

  const send = (message: object) => {
    if (closed) {
      throw new AppServerError("Codex App Server socket is closed", "disconnect", false)
    }
    socket.send(JSON.stringify(message))
  }

  let sequence = 0
  const rpc: Rpc = async (method, params, call = {}) => {
    if (closed) {
      throw new AppServerError("Codex App Server socket is closed", "disconnect", false)
    }
    const id = ++sequence
    const reply = Promise.withResolvers<unknown>()
    let sent = false
    const entry: Pending = {
      reject: (error) => reply.reject(error),
      sent: () => sent,
    }
    pending.add(entry)

    const receive = (event: MessageEvent<string>) => {
      try {
        const response = JSON.parse(event.data) as {
          id?: number
          result?: unknown
          error?: { code?: number; message?: string }
        }
        if (response.id !== id) return
        if (response.error) {
          reply.reject(new AppServerError(
            `Codex ${method}: ${response.error.message ?? response.error.code}`,
            "rpc",
            sent,
            response.error.code,
          ))
        } else {
          reply.resolve(response.result)
        }
      } catch {
        reply.reject(new AppServerError(
          "Codex App Server returned an invalid JSON-RPC message",
          "invalid",
          sent,
        ))
      }
    }

    const timer = setTimeout(() => {
      reply.reject(new AppServerError("Codex App Server request timed out", "timeout", sent))
    }, Math.max(1, call.timeoutMs ?? timeoutMs))

    socket.addEventListener("message", receive)
    try {
      try {
        send({ id, method, params })
        sent = true
        call.onSent?.()
      } catch (error) {
        reply.reject(error instanceof AppServerError
          ? error
          : new AppServerError("Cannot reach the shared Codex App Server socket from OpenCode", "send", false))
      }
      return await reply.promise
    } finally {
      clearTimeout(timer)
      pending.delete(entry)
      socket.removeEventListener("message", receive)
    }
  }

  try {
    await opened.promise
    // `initialize` and `initialized` are handshake traffic, never effectful
    // turn/start traffic. Rejecting them as `preflight` keeps an App Server that
    // refuses or times out the handshake safe to retry instead of terminal.
    try {
      await rpc("initialize", {
        clientInfo: options.clientInfo ?? {
          name: "gangway-codex-app-server",
          title: "Gangway Codex App Server",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      })
      send({ method: "initialized" })
    } catch (error) {
      if (error instanceof AppServerError) {
        throw new AppServerError(
          `Codex App Server initialize failed: ${error.message}`,
          error.kind,
          false,
          error.code,
          true,
        )
      }
      throw new AppServerError(
        `Codex App Server initialize failed: ${error instanceof Error ? error.message : String(error)}`,
        "connect",
        false,
        undefined,
        true,
      )
    }
    return await run(rpc)
  } finally {
    clearTimeout(openTimer)
    socket.close()
  }
}
