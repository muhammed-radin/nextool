/**
 * NexTool v1.0.9 — authoritative execution-record reconciliation (spec §15).
 *
 * The execution record is the single source of truth for every Task Preview
 * tool-call card. Two reconciliation surfaces exist:
 *
 *  1. API-side (mergeExecutionRecords): HistoryEntry rows (terminal, written
 *     once an execution finalizes) are merged with TaskEvent `tool.*`
 *     payloads (live execution records emitted by the executor). For each
 *     executionId the most authoritative record wins — a terminal record
 *     always beats a running/pending one regardless of arrival order.
 *
 *  2. Client-side (reconcileExecutions): Task Preview receives state through
 *     SSE-triggered refreshes + polling. A stale snapshot that still reports
 *     `running` can NEVER overwrite a newer terminal state (running →
 *     completed must never regress to completed → running, §15.9).
 *
 * Pure functions — unit-testable without I/O.
 */

import type { ExecutionStatus, ToolExecution } from './types';

/** Terminal statuses — once reached, never regressed. */
export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  'completed', 'failed', 'timeout', 'cancelled', 'stopped',
]);

export function isTerminalExecutionStatus(status: ExecutionStatus | string | undefined | null): boolean {
  return !!status && TERMINAL_EXECUTION_STATUSES.has(status as ExecutionStatus);
}

/** Monotonic authority rank — higher wins during reconciliation. */
export function executionStatusRank(status: ExecutionStatus | string | undefined | null): number {
  switch (status) {
    case 'running': return 2;
    case 'pending': return 1;
    case 'cancelled': return 4;
    case 'stopped': return 4;
    case 'timeout': return 5;
    case 'failed': return 5;
    case 'completed': return 6;
    default: return 0;
  }
}

function byStartedAt(a: ToolExecution, b: ToolExecution): number {
  const ta = Date.parse(a.startedAt ?? '') || 0;
  const tb = Date.parse(b.startedAt ?? '') || 0;
  if (ta !== tb) return ta - tb;
  return a.executionId.localeCompare(b.executionId);
}

/**
 * Pick the authoritative record for ONE executionId (§15.9):
 *  - terminal beats non-terminal, ALWAYS;
 *  - both terminal or both non-terminal → the record with the newer
 *    completion (terminal) / start (non-terminal) timestamp wins;
 *    completion data (result/error/duration) merges from whichever record
 *    carries it.
 */
export function pickAuthoritativeExecution(
  a: ToolExecution | undefined,
  b: ToolExecution | undefined,
): ToolExecution | undefined {
  if (!a) return b;
  if (!b) return a;
  const rankA = executionStatusRank(a.status);
  const rankB = executionStatusRank(b.status);
  const terminalA = isTerminalExecutionStatus(a.status);
  const terminalB = isTerminalExecutionStatus(b.status);

  if (terminalA !== terminalB) return terminalA ? a : b;
  if (rankA !== rankB) return rankA > rankB ? a : b;

  const timeA = Date.parse((terminalA ? a.completedAt : a.startedAt) ?? '') || 0;
  const timeB = Date.parse((terminalB ? b.completedAt : b.startedAt) ?? '') || 0;
  const newer = timeA >= timeB ? a : b;
  // Merge richer fields — result/error from whichever record has them.
  return {
    ...newer,
    result: newer.result !== undefined && newer.result !== null ? newer.result : (newer === a ? b.result : a.result),
    error: newer.error ?? (newer === a ? b.error : a.error),
  };
}

/**
 * Client-side reconciliation (§15.9): fold a freshly fetched snapshot into
 * the existing state without ever regressing a terminal status back to
 * running/pending. Returns records sorted by start time.
 */
export function reconcileExecutions(prev: ToolExecution[], next: ToolExecution[]): ToolExecution[] {
  const byId = new Map<string, ToolExecution>();
  for (const ex of prev) byId.set(ex.executionId, ex);
  for (const ex of next) {
    byId.set(ex.executionId, pickAuthoritativeExecution(byId.get(ex.executionId), ex) ?? ex);
  }
  return [...byId.values()].sort(byStartedAt);
}

/** Normalize a stored history status into the canonical ExecutionStatus set. */
export function normalizeExecutionStatus(raw: string | null | undefined): ExecutionStatus {
  const known: ExecutionStatus[] = ['pending', 'running', 'completed', 'failed', 'timeout', 'cancelled', 'stopped'];
  if (raw && known.includes(raw as ExecutionStatus)) return raw as ExecutionStatus;
  // 'stopped' persisted under legacy 'cancelled' stays cancelled; anything
  // else unrecognized is honestly reported as failed (never left running).
  return 'failed';
}

/** A `tool.*` TaskEvent row (data = the serialized execution record). */
export interface ToolEventRow {
  type: string;
  data: string | null;
  createdAt: Date | string;
}

/** Terminal tool event types → the status they certify. */
const TERMINAL_TOOL_EVENT_STATUS: Record<string, ExecutionStatus> = {
  'tool.completed': 'completed',
  'tool.failed': 'failed',
  'tool.timeout': 'timeout',
  'tool.cancelled': 'cancelled',
  'tool.stopped': 'stopped',
};

function parseExecutionData(raw: string | null): ToolExecution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ToolExecution>;
    if (!parsed || typeof parsed.executionId !== 'string' || typeof parsed.tool !== 'string') return null;
    if (typeof parsed.status !== 'string') return null;
    return { ...parsed, status: normalizeExecutionStatus(parsed.status) } as ToolExecution;
  } catch {
    return null;
  }
}

/**
 * API-side merge (§15.1/§15.7/§15.8): HistoryEntry rows (terminal truth with
 * result/error) + `tool.*` TaskEvent payloads (live execution records). Each
 * tool call keeps its OWN status — parallel batch members never inherit the
 * parent task's status. Output is sorted by start time.
 */
export function mergeExecutionRecords(
  history: {
    id: string | number; action: string; params: string | null; result: string | null;
    status: string | null; timestamp: Date | string;
    batchId?: string | null; parallelGroup?: number | null;
  }[],
  events: ToolEventRow[],
): ToolExecution[] {
  const byId = new Map<string, ToolExecution>();

  // 1) Live execution records from tool.* events (started + terminal).
  for (const ev of events) {
    const rec = parseExecutionData(ev.data);
    if (!rec) continue;
    const terminalStatus = TERMINAL_TOOL_EVENT_STATUS[ev.type];
    const candidate: ToolExecution = terminalStatus
      ? { ...rec, status: terminalStatus, completedAt: rec.completedAt ?? new Date(ev.createdAt).toISOString() }
      : rec;
    byId.set(rec.executionId, pickAuthoritativeExecution(byId.get(rec.executionId), candidate) ?? candidate);
  }

  // 2) History rows are the finalized truth — they win over events. A row is
  // paired with an event record of the SAME tool whose terminal completion is
  // timestamped at the row write (±10 s, both are written by finalize); the
  // pair enriches the live record with the persisted params/result. Rows with
  // no matching event record stand alone (legacy rows).
  for (const row of history) {
    let params: Record<string, unknown> = {};
    try { params = row.params ? (JSON.parse(row.params) as Record<string, unknown>) : {}; } catch { /* keep empty */ }
    let result: unknown = null;
    try { result = row.result ? JSON.parse(row.result) : null; } catch { /* keep null */ }
    const ts = new Date(row.timestamp).toISOString();
    const rowMs = Date.parse(ts) || 0;
    const status = normalizeExecutionStatus(row.status);

    const paired = [...byId.values()]
      .filter((ex) => ex.tool === row.action
        && isTerminalExecutionStatus(ex.status)
        && Math.abs((Date.parse(ex.completedAt ?? '') || 0) - rowMs) < 10_000)
      .sort((a, b) => Math.abs((Date.parse(a.completedAt ?? '') || 0) - rowMs) - Math.abs((Date.parse(b.completedAt ?? '') || 0) - rowMs))[0];

    if (paired) {
      byId.set(paired.executionId, {
        ...paired,
        params: Object.keys(params).length > 0 ? params : paired.params,
        result: paired.result !== undefined && paired.result !== null ? paired.result : result,
      });
      continue;
    }

    const record: ToolExecution = {
      executionId: `hist_${row.id}`,
      tool: row.action,
      status,
      params,
      result,
      error: status === 'failed' || status === 'timeout'
        ? { code: status.toUpperCase(), message: 'See task events for details.' }
        : null,
      startedAt: ts,
      completedAt: ts,
      durationMs: 0,
      ...(row.batchId ? { batchId: row.batchId, parallelGroup: row.parallelGroup ?? undefined } : {}),
    };
    byId.set(record.executionId, pickAuthoritativeExecution(byId.get(record.executionId), record) ?? record);
  }

  return [...byId.values()].sort(byStartedAt);
}
