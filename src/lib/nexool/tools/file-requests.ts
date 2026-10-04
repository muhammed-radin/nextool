/**
 * NexTool v1.0.13 (§10) — pending FILE-REQUEST registry for `fs.upload`.
 *
 * Mirrors the runtime pattern of sandbox-interactive.ts (alert/prompt/confirm):
 * a globalThis registry + Promise resolution + a bounded wait window + runtime
 * events, so a tool can ASK the user for a file and pause until it arrives.
 *
 *   const file = await requestFileFromUser({...});  // pauses THIS tool only
 *   // resolved by the console via POST /api/file-requests
 *
 * Semantics:
 *  - ONLY the requesting tool's Promise pends — the task loop, scheduler and
 *    every other tool keep running (never a runtime freeze).
 *  - The wait window is 120 s (PROMPT-like). On expiry/cancellation the
 *    promise resolves NULL — the caller (fs.upload) reports an honest
 *    FILE_REQUEST_TIMEOUT failure; an unresolved request is never treated as
 *    a file.
 *  - Events: `tool.file_request.requested` / `tool.file_request.responded`
 *    carry taskId, executionId, toolName and the request/response payload so
 *    the console UI can associate them with the task/execution/tool.
 *  - While a request is pending, `hasPendingFileRequestInteraction` lets the
 *    tool-executor watchdog DEFER the deadline of that execution (same model
 *    as prompt()/confirm() — the full budget is restored once the user
 *    answers or the window closes).
 *
 * The registry holds NO file content: `resolvePendingFileRequest` hands the
 * base64 payload to the awaiting tool, which writes it into the shared VFS
 * (where the central vfs limits stay authoritative).
 */

import { emitEvent } from '../eventbus';

/** File-request wait window (PROMPT-like §1.6 semantics). */
export const FILE_REQUEST_TIMEOUT_MS = 120_000;

/** Maximum base64 payload the console API may hand to a request (~6 MiB binary
 *  after decoding). The VFS per-file limit remains the FINAL authority at
 *  write time — this bound only protects the registry from oversized posts. */
export const FILE_REQUEST_MAX_BASE64_CHARS = 8_000_000;

export interface FileRequestResolution {
  fileName: string;
  contentBase64: string;
}

export interface PendingFileRequestInfo {
  requestId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  suggestedName?: string;
  requestedAt: string;
}

interface PendingFileRequestEntry extends PendingFileRequestInfo {
  executionId: string;
  resolve: (value: FileRequestResolution | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as unknown as {
  __nextoolFileRequests?: Map<string, PendingFileRequestEntry>;
  __nextoolFileRequestWatch?: Set<string>;
};

function requestRegistry(): Map<string, PendingFileRequestEntry> {
  if (!g.__nextoolFileRequests) g.__nextoolFileRequests = new Map();
  return g.__nextoolFileRequests;
}

/** Execution ids with an in-flight file request — the executor watchdog defers
 *  THIS execution's deadline while it waits for the user's upload. */
function interactionWatch(): Set<string> {
  if (!g.__nextoolFileRequestWatch) g.__nextoolFileRequestWatch = new Set();
  return g.__nextoolFileRequestWatch;
}

/** True while THIS execution is waiting for a user file upload. */
export function hasPendingFileRequestInteraction(executionId: string): boolean {
  return interactionWatch().has(executionId);
}

/** List pending file requests (optionally scoped to a task) — powers the console UI. */
export function listPendingFileRequests(taskId?: string): PendingFileRequestInfo[] {
  const now = Date.now();
  const out: PendingFileRequestInfo[] = [];
  for (const [id, r] of requestRegistry()) {
    if (now - Date.parse(r.requestedAt) > FILE_REQUEST_TIMEOUT_MS + 1000) {
      clearTimeout(r.timer);
      requestRegistry().delete(id);
      continue;
    }
    if (taskId && r.taskId !== taskId) continue;
    out.push({
      requestId: id,
      taskId: r.taskId,
      toolName: r.toolName,
      message: r.message,
      suggestedName: r.suggestedName,
      requestedAt: r.requestedAt,
    });
  }
  return out;
}

/**
 * Resolve a pending file request from the console UI. Returns false when the
 * request is unknown/expired. `contentBase64 === null` CANCELS the request —
 * the awaiting tool always resolves (never hangs).
 */
export function resolvePendingFileRequest(
  requestId: string,
  fileName: string | null,
  contentBase64: string | null,
): boolean {
  const r = requestRegistry().get(requestId);
  if (!r) return false;
  clearTimeout(r.timer);
  requestRegistry().delete(requestId);
  if (fileName === null || contentBase64 === null) {
    r.resolve(null);
    void emitEvent({
      taskId: r.taskId,
      type: 'tool.file_request.responded',
      source: 'user',
      message: `File request cancelled: ${r.message.slice(0, 120)}`,
      data: { requestId, executionId: r.executionId, toolName: r.toolName ?? null, cancelled: true },
      priority: 4,
    });
    return true;
  }
  r.resolve({ fileName, contentBase64 });
  void emitEvent({
    taskId: r.taskId,
    type: 'tool.file_request.responded',
    source: 'user',
    message: `File provided for request: ${fileName.slice(0, 160)}`,
    data: {
      requestId,
      executionId: r.executionId,
      toolName: r.toolName ?? null,
      cancelled: false,
      fileName: fileName.slice(0, 200),
      base64Chars: contentBase64.length,
    },
    priority: 4,
  });
  return true;
}

/** Cancel + flush every pending file request for a task (used when a task stops). */
export function cancelPendingFileRequestsForTask(taskId: string): void {
  for (const [id, r] of requestRegistry()) {
    if (r.taskId !== taskId) continue;
    clearTimeout(r.timer);
    requestRegistry().delete(id);
    r.resolve(null);
    void emitEvent({
      taskId,
      type: 'tool.file_request.responded',
      source: 'system',
      message: `File request cancelled (task stopped): ${r.message.slice(0, 120)}`,
      data: { requestId: id, executionId: r.executionId, toolName: r.toolName ?? null, cancelled: true, reason: 'task_stopped' },
      priority: 4,
    });
  }
}

/**
 * Create a pending file request and AWAIT the user's upload (or NULL on
 * cancel/timeout). Only the caller's Promise pends — the runtime keeps going.
 */
export function requestFileFromUser(opts: {
  taskId?: string;
  executionId: string;
  toolName?: string;
  message: string;
  suggestedName?: string;
}): Promise<FileRequestResolution | null> {
  const msg = typeof opts.message === 'string' ? opts.message : '';
  const requestId = `frq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  interactionWatch().add(opts.executionId);
  return new Promise<FileRequestResolution | null>((resolve) => {
    const entry: PendingFileRequestEntry = {
      requestId,
      taskId: opts.taskId,
      executionId: opts.executionId,
      toolName: opts.toolName,
      message: msg,
      suggestedName: opts.suggestedName,
      requestedAt: new Date().toISOString(),
      resolve,
      timer: setTimeout(() => {
        requestRegistry().delete(requestId);
        resolve(null);
      }, FILE_REQUEST_TIMEOUT_MS),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    requestRegistry().set(requestId, entry);
    void emitEvent({
      taskId: opts.taskId,
      type: 'tool.file_request.requested',
      source: 'tool',
      message: `Tool requests a file: ${msg.slice(0, 300)}`,
      data: {
        requestId,
        executionId: opts.executionId,
        toolName: opts.toolName ?? null,
        message: msg,
        suggestedName: opts.suggestedName ?? null,
      },
      priority: 2,
    });
  }).finally(() => {
    interactionWatch().delete(opts.executionId);
  });
}
