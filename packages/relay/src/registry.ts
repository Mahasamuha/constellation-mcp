import { WebSocket } from "ws";
import { ExecutorTokenType } from "./generated/prisma/client.js";
import type { RpcResponse } from "@constellation/shared";

// ---------------------------------------------------------------------------
// Connection registry
//
// Single point of access to in-memory connection state. Isolated here so a
// future move to a shared backing store (see TODO_DEFERRED — Horizontal
// Scaling) only requires changes in this module, not at every call site.
// ---------------------------------------------------------------------------

export interface ConnectedExecutor {
  ws: WebSocket;
  executorId: string;
  userId: string | null;
  tokenType: ExecutorTokenType;
  host: string;
  tokenId: string;
  lastPongAt: number;
  missedPings: number;
  disconnectReason?: "clean" | "timeout" | "error";
}

const connections = new Map<string, ConnectedExecutor>();

/** Registers a connection for the executor, returning any prior connection that occupied the slot
 * (the caller is responsible for terminating it — replacing a stale connection is normal on reconnect). */
export function registerConnection(conn: ConnectedExecutor): ConnectedExecutor | undefined {
  const existing = connections.get(conn.executorId);
  connections.set(conn.executorId, conn);
  return existing;
}

/** Removes the entry only if it currently equals `conn`. Returns true if removed.
 * Guards against clobbering a newer connection that replaced this one before this call ran
 * (e.g. heartbeat timeout racing a reconnect, or a delayed close event after a replacement). */
export function unregisterConnection(conn: ConnectedExecutor): boolean {
  if (connections.get(conn.executorId) !== conn) return false;
  connections.delete(conn.executorId);
  return true;
}

export function getConnection(executorId: string): ConnectedExecutor | undefined {
  return connections.get(executorId);
}

export function allConnections(): IterableIterator<[string, ConnectedExecutor]> {
  return connections.entries();
}

// ---------------------------------------------------------------------------
// RPC registry
//
// Tracks in-flight requests awaiting a response from an executor. Isolated for
// the same reason as the connection registry — see TODO_DEFERRED, which notes
// pendingRpcs would need to move to Redis streams (or similar) alongside the
// connection map in a multi-instance deployment.
// ---------------------------------------------------------------------------

interface PendingRpc {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  executorId: string;
}

const pendingRpcs = new Map<string, PendingRpc>();

/** Registers a pending RPC and returns a promise that settles when a matching response arrives
 * via `resolvePendingRpc`, or rejects after `timeoutMs` with a "timeout" error. */
export function dispatchPendingRpc(requestId: string, executorId: string, timeoutMs: number): Promise<RpcResponse> {
  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpcs.delete(requestId);
      reject(new Error("timeout"));
    }, timeoutMs);

    pendingRpcs.set(requestId, { resolve, reject, timer, executorId });
  });
}

/** Resolves a pending RPC by request id. No-op if there is no matching entry (e.g. it already
 * timed out, or the response is for a request this relay no longer tracks). */
export function resolvePendingRpc(requestId: string, response: RpcResponse): void {
  const pending = pendingRpcs.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRpcs.delete(requestId);
  pending.resolve(response);
}

/** Rejects and removes every pending RPC belonging to the given executor — called on disconnect. */
export function rejectPendingRpcsForExecutor(executorId: string, error: Error): void {
  for (const [requestId, pending] of pendingRpcs) {
    if (pending.executorId === executorId) {
      clearTimeout(pending.timer);
      pendingRpcs.delete(requestId);
      pending.reject(error);
    }
  }
}
