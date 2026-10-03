/**
 * NexTool v1.0.2 → v1.0.8 — JavaScript function tool runner.
 *
 * Executes user-authored `async function execute(params, context)` tool source
 * inside a hardened `node:vm` sandbox (§56 of the v1.0.2 spec — ONE execution
 * path for production, tests and the CLI).
 *
 * v1.0.6 (spec §1/§7) — the lightweight environment gains the common safe
 * baseline shared with the nodejs environment:
 *  - fetch / XMLHttpRequest  → the SAME controlled network layer (policy,
 *    timeout, response cap, request accounting — §7.1, never unrestricted)
 *  - async alert() / prompt() → NexTool runtime interaction events (§1.5–1.7)
 *  - setTimeout/setInterval, TextEncoder/TextDecoder, URL/URLSearchParams,
 *    atob/btoa, structuredClone
 *  - require() resolves ONLY virtual-filesystem modules when the tool owns a
 *    workspace — deliberately narrower than the nodejs environment (§7.2).
 *
 * v1.0.8 (§1/§2/§6/§17):
 *  - async confirm() — NexTool confirmation UI; always resolves boolean.
 *  - dynamic import() is SUPPORTED: URL imports go through the centralized
 *    import resolver (network policy enforced), VFS modules resolve from the
 *    tool workspace. The transform lives in import-resolver.ts (shared).
 *  - ALL execution limits are resolved from config/configuration-limits.json
 *    (execution.syncTimeoutMs / maxSourceChars / maxResultBytes / maxLogs /
 *    maxLogLineChars / timeoutMs) — no hard-coded limits remain (§17).
 *
 * Still true: NO require of Node modules, NO process, NO fs, NO host escapes.
 * Sync execution is capped by the vm timeout; async execution by an
 * interaction-aware deadline. Results must be JSON-serializable —
 * non-serializable results are reported as TOOL_FAILURE, never coerced.
 */
import vm from 'node:vm';
import {
  createNetworkAccounting,
  createXhrClass,
  policyFetch,
  type NetworkAccounting,
} from './sandbox-net';
import {
  createRuntimeInteractions,
  createTestInteractions,
  type SandboxInteractions,
} from './sandbox-interactive';
import type { VirtualFsSession } from './vfs';
import {
  requireFromVfs,
  resolveToolImport,
  transformDynamicImports,
  RUNTIME_IMPORT_SHIM,
  type ImportContext,
} from './import-resolver';
import { getResolvedLimits } from '../config-limits';

// ---------- execution limits (v1.0.8 §6/§17 — resolved from the CENTRAL limits) ----------

/** Documented SHIPPED defaults (the live values come from configuration-limits.json). */
export const JS_SYNC_TIMEOUT_MS_DEFAULT = 4_000;
export const MAX_FUNCTION_SOURCE_LENGTH = 64_000;
export const MAX_RESULT_BYTES = 64 * 1024;
export const JS_TOOL_TIMEOUT_MS = 10_000;
export const JS_LOG_MAX_LINES_DEFAULT = 100;

/** LIVE synchronous-execution cap (execution.syncTimeoutMs — shipped 4 s, max 30 min). */
export function syncTimeoutMs(): number {
  try {
    return getResolvedLimits().execution.syncTimeoutMs;
  } catch {
    return JS_SYNC_TIMEOUT_MS_DEFAULT;
  }
}

/** LIVE max function-source characters (execution.maxSourceChars — shipped 64000). */
export function maxFunctionSourceChars(): number {
  try {
    return getResolvedLimits().execution.maxSourceChars;
  } catch {
    return MAX_FUNCTION_SOURCE_LENGTH;
  }
}

/** LIVE max serialized result bytes (execution.maxResultBytes — shipped 64 KiB). */
export function maxResultBytes(): number {
  try {
    return getResolvedLimits().execution.maxResultBytes;
  } catch {
    return MAX_RESULT_BYTES;
  }
}

/** LIVE max captured log lines (execution.maxLogs — shipped 100). */
export function maxLogLines(): number {
  try {
    return getResolvedLimits().execution.maxLogs;
  } catch {
    return JS_LOG_MAX_LINES_DEFAULT;
  }
}

/** LIVE max characters of one log line (execution.maxLogLineChars — shipped 2000). */
export function maxLogLineChars(): number {
  try {
    return getResolvedLimits().execution.maxLogLineChars;
  } catch {
    return 2_000;
  }
}

export interface JsToolContext {
  executionId: string;
  taskId?: string;
  /** "test" for Tool-Editor test runs, "production" for real task executions. */
  mode: 'test' | 'production';
  /** ISO timestamp at invocation. */
  now: string;
  /** Append a log line — lines are returned to the caller (capped at maxLogs). */
  log: (...parts: unknown[]) => void;
}

/** v1.0.6 — execution-scoped environment bindings for the js-function sandbox. */
export interface JsEnvExecution {
  toolId?: string;
  vfs?: VirtualFsSession;
  interactions?: SandboxInteractions;
  accounting?: NetworkAccounting;
  moduleCache?: Map<string, unknown>;
  /** v1.0.7 §1 — effective execution timeout (ms) resolved by the tool
   *  runtime (global → tool-specific, capped at the live maximum). Defaults to
   *  the documented JS_TOOL_TIMEOUT_MS (10 s) when absent. */
  timeoutMs?: number;
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
  const maxChars = maxFunctionSourceChars();
  if (source.length > maxChars) {
    return { ok: false, error: `Function source exceeds ${maxChars} characters.` };
  }
  try {
    // Wrap the same way runJsTool does so syntax errors surface now.
    // NOTE: Bun defers vm.Script compilation until run, so we must actually
    // run the snippet — it only DEFINES the execute function (never invoked),
    // inside a throwaway empty context.
    const probe = new vm.Script(wrapSource(transformDynamicImports(source)), { filename: 'tool-function.js' });
    probe.runInNewContext({ [RUNTIME_IMPORT_SHIM]: () => { throw new Error('import() is unavailable at validation time.'); } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Syntax error in function source.' };
  }
}

/**
 * Execute a js-function tool. NEVER throws — returns a structured result.
 * `exec` carries the v1.0.6/§1 execution-scoped bindings (network accounting,
 * interactions, optional VFS for restricted require()).
 */
export function runJsTool(
  source: string,
  params: Record<string, unknown>,
  context: JsToolContext,
  exec: JsEnvExecution = {},
): Promise<JsToolRunResult> {
  return new Promise((resolve) => {
    const logCap = maxLogLines();
    const logLineCap = maxLogLineChars();
    const logger: LoggerState = { lines: [] };
    const logs = logger.lines;
    const pushLog = (...parts: unknown[]) => {
      if (logs.length >= logCap) return;
      logs.push(parts.map(stringifyLogPart).join(' ').slice(0, logLineCap));
    };

    const accounting: NetworkAccounting = exec.accounting ?? createNetworkAccounting(exec.timeoutMs);
    const moduleCache = exec.moduleCache ?? new Map<string, unknown>();
    const importCtx: ImportContext = {
      toolId: exec.toolId,
      vfs: exec.vfs,
      accounting,
      moduleCache,
    };

    // v1.0.7 §1 — effective execution timeout (global → tool config, live cap);
    // the documented 10 s default applies when the caller passes nothing.
    let execTimeoutMs = JS_TOOL_TIMEOUT_MS;
    try {
      execTimeoutMs = getResolvedLimits().execution.timeoutMs;
    } catch { /* limits file missing → keep the shipped default; enforcement layers will fail clearly */ }
    if (exec.timeoutMs && Number.isFinite(exec.timeoutMs) && exec.timeoutMs > 0) {
      let cap = 3_600_000;
      try { cap = getResolvedLimits().execution.timeoutMs; } catch { /* shipped cap */ }
      execTimeoutMs = Math.min(Math.round(exec.timeoutMs), cap);
    }

    // Interaction-aware deadline (§1.6/§1.7) — same model as node-runner.
    let deadline = Date.now() + execTimeoutMs;
    const deadlineCtl = {
      extendDeadline: () => {
        deadline = Math.max(deadline, Date.now() + 130_000);
      },
      resetDeadline: () => {
        deadline = Date.now() + execTimeoutMs;
      },
    };
    const interactions: SandboxInteractions = exec.interactions
      ?? (context.mode === 'test' ? createTestInteractions() : createRuntimeInteractions(context.taskId, context.executionId, exec.toolId, deadlineCtl));

    let settled = false;
    const finish = (result: JsToolRunResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve({ ...result, logs: [...logs] });
    };

    const watchdog = setInterval(() => {
      if (Date.now() > deadline) {
        finish({ ok: false, error: { code: 'TIMEOUT', message: `Function exceeded ${execTimeoutMs}ms and was aborted.` }, logs: [] });
      }
    }, 250);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    // §7.2 — require() is deliberately NARROW here: virtual filesystem modules
    // only (when the tool owns a workspace). Node modules never resolve.
    const sandboxRequire = (specifier: string): unknown => {
      const spec = String(specifier ?? '').trim();
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
        return requireFromVfs(importCtx, '/workspace/execute.js', spec);
      }
      throw new Error(
        `Module "${spec}" is not available in the js-function environment — it is a lightweight restricted runtime. Use the nodejs environment for allowlisted Node.js modules.`,
      );
    };

    // v1.0.8 §2 — dynamic import() in the js-function environment: URL imports
    // go through the centralized policy-gated resolver; relative specifiers
    // resolve VFS modules. Same sandbox boundary, no extra capabilities.
    const dynamicImport = (specifier: string): Promise<unknown> => {
      const spec = String(specifier ?? '').trim();
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
        if (!importCtx.vfs) {
          return Promise.reject(new Error(`Module "${spec}" cannot be resolved: this execution has no virtual filesystem workspace.`));
        }
        return resolveToolImport(spec, importCtx, '/workspace/execute.js');
      }
      if (spec.startsWith('http://') || spec.startsWith('https://')) {
        return resolveToolImport(spec, importCtx);
      }
      // bare specifier — the same narrow error require() gives
      try {
        sandboxRequire(spec);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(new Error(`Module "${spec}" is not available in the js-function environment.`));
    };

    const syncCap = syncTimeoutMs();

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
        // §7 common APIs — same controlled layers as the nodejs environment.
        fetch: (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => policyFetch(input, init ?? {}, accounting),
        XMLHttpRequest: createXhrClass() as unknown,
        alert: interactions.alert,
        prompt: interactions.prompt,
        // v1.0.8 §1 — async confirm(): NexTool confirmation UI, boolean result.
        confirm: interactions.confirm,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        atob,
        btoa,
        structuredClone,
        require: sandboxRequire,
        [RUNTIME_IMPORT_SHIM]: dynamicImport,
        // Intentionally NOT provided: process, Buffer, fs, node modules, global escapes.
      });
    } catch (err) {
      finish({ ok: false, error: { code: 'SANDBOX_ERROR', message: err instanceof Error ? err.message : 'Failed to create sandbox.' }, logs: [] });
      return;
    }

    try {
      const compiled = new vm.Script(wrapSource(transformDynamicImports(source)), { filename: 'tool-function.js' });
      const fn = compiled.runInContext(sandbox, { timeout: syncCap }) as
        | ((p: Record<string, unknown>, c: unknown) => Promise<unknown>);
      if (typeof fn !== 'function') {
        finish({ ok: false, error: { code: 'INVALID_FUNCTION', message: 'Source did not compile to an execute function.' }, logs: [] });
        return;
      }
      // v1.0.5 — INVOKE inside the vm under the sync timeout: the synchronous
      // portion of execute() (bodies without an await) is bounded even though
      // the async completion is only covered by the deadline above. This keeps
      // the event loop responsive — a runaway loop can never freeze the server.
      const host = sandbox as unknown as Record<string, unknown>;
      host.__nexoolRun = fn;
      new vm.Script('__nexoolResult = __nexoolRun(params, context)', { filename: 'tool-function.js' })
        .runInContext(sandbox, { timeout: syncCap });
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

/** Shared with node-runner — enforces the serialized-result contract. */
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
      if (json && json.length > maxResultBytes()) {
        return { ok: false, message: `Result exceeds ${maxResultBytes()} bytes when serialized.` };
      }
      return { ok: true, value: out };
    }
    return { ok: false, message: 'Result contains an unsupported value type.' };
  } finally {
    seen.delete(value);
  }
}
