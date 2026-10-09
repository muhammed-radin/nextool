/**
 * NexTool v1.1.0 §9.3 — task-owned child-process registry.
 *
 * Every REAL host process spawned on behalf of a task (today: the `fs.cmd`
 * tool's bash child; the inspector terminal is NOT task-owned — it is
 * controlled through its own session actions and is never killed by a task
 * stop) is registered here with a kill handle.
 *
 * On force-stop the registry terminates each entry SIGTERM-first and
 * escalates to SIGKILL where the platform supports it — so no background
 * child process keeps working after the task stopped merely because the
 * HTTP request returned. Unrelated host processes are never touched.
 */

export interface TaskProcessEntry {
  /** Stable label, e.g. "fs.cmd" or "terminal:<sessionId>". */
  label: string;
  pid?: number;
  /** Detached children run in their own process group — kill the group. */
  group?: boolean;
  /** Terminate this process (SIGTERM → SIGKILL escalation is applied by the registry). */
  kill: (signal?: NodeJS.Signals) => void;
  startedAt: number;
}

interface TaskProcessState {
  byTask: Map<string, Map<string, TaskProcessEntry>>;
}

const g = globalThis as unknown as { __nextoolTaskProcesses?: TaskProcessState };

function state(): TaskProcessState {
  if (!g.__nextoolTaskProcesses) g.__nextoolTaskProcesses = { byTask: new Map() };
  return g.__nextoolTaskProcesses;
}

function esc(signal: NodeJS.Signals | undefined, entry: TaskProcessEntry): void {
  try {
    if (entry.pid && entry.group && process.platform !== 'win32') {
      try {
        process.kill(-entry.pid, signal ?? 'SIGTERM'); // process group
        return;
      } catch {
        /* group gone — fall through to the direct kill */
      }
    }
    entry.kill(signal);
  } catch {
    /* process already gone */
  }
}

/** Register a task-owned child process. Returns the release function. */
export function registerTaskProcess(
  taskId: string,
  key: string,
  entry: Omit<TaskProcessEntry, 'startedAt'>,
): () => void {
  const s = state();
  let map = s.byTask.get(taskId);
  if (!map) {
    map = new Map();
    s.byTask.set(taskId, map);
  }
  map.set(key, { ...entry, startedAt: Date.now() });
  return () => {
    const m = s.byTask.get(taskId);
    if (m) {
      m.delete(key);
      if (m.size === 0) s.byTask.delete(taskId);
    }
  };
}

/** Terminate every process owned by the task (SIGTERM → 1.5 s → SIGKILL). */
export async function terminateTaskProcesses(taskId: string): Promise<number> {
  const s = state();
  const map = s.byTask.get(taskId);
  if (!map || map.size === 0) return 0;
  const entries = [...map.entries()];
  s.byTask.delete(taskId);
  let n = 0;
  for (const [, entry] of entries) {
    esc('SIGTERM', entry);
    n++;
  }
  // escalate where still alive
  await new Promise((r) => setTimeout(r, 1500));
  for (const [, entry] of entries) {
    esc('SIGKILL', entry);
  }
  return n;
}

/** Observe how many processes a task currently owns (diagnostics/UI). */
export function countTaskProcesses(taskId: string): number {
  return state().byTask.get(taskId)?.size ?? 0;
}
