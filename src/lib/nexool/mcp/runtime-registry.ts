/**
 * NexTool v1.0.12 — MCP runtime client map (in-process session registry).
 *
 * Holds the LIVE MCP client per connector for this server process. Deliberately
 * tiny and dependency-light (client.ts + types only) so both the connector
 * manager AND the tool runner (tools/mcp-runner.ts) can import it without
 * circular imports.
 *
 * The map is the source of truth for "is this connector REALLY connected":
 * a DB row can say anything, but without an entry here the session does not
 * exist (spec §1.8 — never fake connection status). The manager reconciles
 * DB rows against this map on every read.
 */

import type { McpClientLike } from './client';

interface RuntimeState {
  clients: Map<string, McpClientLike>;
  /** In-flight connect/reconnect promises (dedupe + reconcile). */
  pending: Map<string, Promise<unknown>>;
}

const g = globalThis as unknown as { __nextoolMcpRuntime?: RuntimeState };

function state(): RuntimeState {
  if (!g.__nextoolMcpRuntime) {
    g.__nextoolMcpRuntime = { clients: new Map(), pending: new Map() };
  }
  return g.__nextoolMcpRuntime;
}

/** A live client exists for this connector in THIS process. */
export function hasLiveClient(connectorId: string): boolean {
  return state().clients.has(connectorId);
}

export function getLiveClient(connectorId: string): McpClientLike | undefined {
  return state().clients.get(connectorId);
}

export function setLiveClient(connectorId: string, client: McpClientLike): void {
  state().clients.set(connectorId, client);
}

/** Close + forget the client (idempotent — never throws). */
export async function dropLiveClient(connectorId: string): Promise<void> {
  const client = state().clients.get(connectorId);
  state().clients.delete(connectorId);
  if (client) {
    try {
      await client.close();
    } catch {
      /* already gone */
    }
  }
}

export function isConnecting(connectorId: string): boolean {
  return state().pending.has(connectorId);
}

export function trackPending<T>(connectorId: string, promise: Promise<T>): Promise<T> {
  state().pending.set(connectorId, promise);
  promise.finally(() => state().pending.delete(connectorId)).catch(() => undefined);
  return promise;
}
