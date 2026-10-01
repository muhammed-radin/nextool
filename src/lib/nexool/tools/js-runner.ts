/**
 * NexTool v1.0.2 — JavaScript function tool runner.
 *
 * Executes user-authored `async function execute(params, context)` tool source
 * inside a hardened `node:vm` sandbox:
 *  - NO require / process / fetch / globalThis escape hatch: the sandbox only
 *    exposes the documented runtime context (§21 of the v1.0.2 spec — every
 *    reference below actually exists and is passed in).
 *  - Sync execution is capped by `vm` timeout; async execution is capped by
 *    the caller (executor Promise.race) — document both in tool-development.md.
 *  - The compiled function must return a JSON-serializable value; non-serializable
 *    results are reported as TOOL_FAILURE instead of silently coerced.
 *
 * The SAME runner is used for production executions, tool tests and the CLI —
 * there is exactly one execution path (v1.0.2 §56).
 */
import vm from 'node:vm';

/** Sandbox hard limit for synchronous execution (async awaits are bounded by the executor). */
const SYNC_TIMEOUT_MS = 4000;

/** Maximum chars of user function source accepted. */
export const MAX_FUNCTION_SOURCE_LENGTH = 64_000;

/** Maximum serialized result size accepted (64 KiB). */
export const MAX_RESULT_BYTES = 64 * 1024;

/** Execution timeout for tool tests / js tools (ms). */
export const JS_TOOL_TIMEOUT_MS = 10_000;

export interface JsToolContext {
  executionId: string;
  taskId?: string;
  /** "test" for Tool-Editor test runs, "production" for real task executions. */
  mode: 'test' | 'production';
  /** ISO timestamp at invocation. */
  now: string;
  /** Append a log line — lines are returned to the caller (capped at 100 entries). */
  log: (...parts: unknown[]) => void;
}

export interface JsToolRunResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  logs: string[];
}

interface LoggerState {
  lines: string[];
}

function stringifyLogPart(part: unknown): string {
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

/**
 * Detect whether the user source already declares `execute` itself
 * (the documented signature: `async function execute(params, context) {...}`).
 * Declared sources are compiled AS-IS; bare statement bodies are wrapped.
 */
export function declaresExecute(source: string): boolean {
  return /(?:async\s+)?function\s+execute\s*\(/.test(source)
    || /(?:const|let|var)\s+execute\s*=/.test(source);
}

function wrapSource(source: string): string {
  return declaresExecute(source)
    ? `${source}\nexecute`
    : `(async function execute(params, context) {\n${source}\n})`;
}

/**
 * Compile-time validation. Throws Error with a readable message when the
 * source is obviously invalid. Used by the Tool IDE (save-time) and tests.
 */
export function validateFunctionSource(source: string): { ok: true } | { ok: false; error: string } {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, error: 'Function source is empty.' };
  }
  if (source.length > MAX_FUNCTION_SOURCE_LENGTH) {
    return { ok: false, error: `Function source exceeds ${MAX_FUNCTION_SOURCE_LENGTH} characters.` };
  }
  try {
    // Wrap the same way runJsTool does so syntax errors surface now.
    // NOTE: Bun defers vm.Script compilation until run, so we must actually
    // run the snippet — it only DEFINES the execute function (never invoked),
    // inside a throwaway empty context.
    const probe = new vm.Script(wrapSource(source), { filename: 'tool-function.js' });
    probe.runInNewContext({});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Syntax error in function source.' };
  }
}

/**
 * Execute a js-function tool. NEVER throws — returns a structured result.
 * The sandbox global contains ONLY: params, context, console (capped), plus
 * the ECMAScript builtins. Timers/promises beyond what ES provides are absent.
 */
export function runJsTool(
  source: string,
  params: Record<string, unknown>,
  context: JsToolContext,
): Promise<JsToolRunResult> {
  return new Promise((resolve) => {
    const logger: LoggerState = { lines: [] };
    const logs = logger.lines;
    const pushLog = (...parts: unknown[]) => {
      if (logs.length >= 100) return;
      logs.push(parts.map(stringifyLogPart).join(' ').slice(0, 2000));
    };

    let settled = false;
    const finish = (result: JsToolRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, logs: [...logs] });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'TIMEOUT', message: `Function exceeded ${JS_TOOL_TIMEOUT_MS}ms and was aborted.` }, logs: [] });
    }, JS_TOOL_TIMEOUT_MS);

    let sandbox: vm.Context | undefined;
    try {
      sandbox = vm.createContext({
        params: structuredCloneSafe(params),
        context: {
          executionId: context.executionId,
          taskId: context.taskId ?? null,
          mode: context.mode,
          now: context.now,
          log: pushLog,
        },
        console: { log: pushLog, warn: pushLog, error: pushLog, info: pushLog },
        // Intentionally NOT provided: require, process, fetch, setTimeout/setInterval,
        // Buffer, global, globalThis escapes. Documented in tool-development.md.
      });
    } catch (err) {
      finish({ ok: false, error: { code: 'SANDBOX_ERROR', message: err instanceof Error ? err.message : 'Failed to create sandbox.' }, logs: [] });
      return;
    }

    try {
      const compiled = new vm.Script(wrapSource(source), { filename: 'tool-function.js' });
      const fn = compiled.runInContext(sandbox, { timeout: SYNC_TIMEOUT_MS }) as
        | ((p: Record<string, unknown>, c: unknown) => Promise<unknown>);
      if (typeof fn !== 'function') {
        finish({ ok: false, error: { code: 'INVALID_FUNCTION', message: 'Source did not compile to an execute function.' }, logs: [] });
        return;
      }
      // v1.0.5 — INVOKE inside the vm under the sync timeout: the synchronous
      // portion of execute() (bodies without an await) is bounded even though
      // the async completion is only covered by the watchdog above. This keeps
      // the event loop responsive — a runaway loop can never freeze the server.
      const host = sandbox as unknown as Record<string, unknown>;
      host.__nexoolRun = fn;
      new vm.Script('__nexoolResult = __nexoolRun(params, context)', { filename: 'tool-function.js' })
        .runInContext(sandbox, { timeout: SYNC_TIMEOUT_MS });
      Promise.resolve(host.__nexoolResult)
        .then((value) => {
          const check = ensureSerializable(value);
          if (!check.ok) {
            finish({ ok: false, error: { code: 'NOT_SERIALIZABLE', message: check.message }, logs: [] });
            return;
          }
          finish({ ok: true, result: check.value, logs: [] });
        })
        .catch((err: unknown) => {
          finish({
            ok: false,
            error: { code: 'TOOL_FAILURE', message: err instanceof Error ? err.message : String(err) },
            logs: [],
          });
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        ok: false,
        error: {
          code: err instanceof SyntaxError && !message.includes('timed out') ? 'SYNTAX_ERROR' : message.includes('timed out') ? 'TIMEOUT' : 'TOOL_FAILURE',
          message,
        },
        logs: [],
      });
    }
  });
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return value;
  }
}

/** v1.0.5: shared with node-runner — enforces the serialized-result contract. */
export function ensureSerializable(value: unknown, depth = 0, seen = new Set<unknown>()): { ok: true; value: unknown } | { ok: false; message: string } {
  if (depth > 12) return { ok: false, message: 'Result is nested too deeply (max depth 12).' };
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return { ok: true, value: value === undefined ? null : value };
  }
  if (typeof value === 'bigint') return { ok: false, message: 'Result contains a BigInt — return a number or string instead.' };
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { ok: false, message: 'Result contains a non-serializable value (function/symbol).' };
  }
  if (seen.has(value)) return { ok: false, message: 'Result contains a circular reference.' };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) {
        const r = ensureSerializable(item, depth + 1, seen);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const r = ensureSerializable(v, depth + 1, seen);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      const json = JSON.stringify(out);
      if (json && json.length > MAX_RESULT_BYTES) {
        return { ok: false, message: `Result exceeds ${MAX_RESULT_BYTES} bytes when serialized.` };
      }
      return { ok: true, value: out };
    }
    return { ok: false, message: 'Result contains an unsupported value type.' };
  } finally {
    seen.delete(value);
  }
}
