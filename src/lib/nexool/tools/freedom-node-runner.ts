/**
 * NexTool v1.0.11 — FREEDOM-NODE tool environment (`environment: "freedom-node"`).
 *
 * An INTENTIONALLY UNRESTRICTED execution environment (spec §20–§33). Unlike
 * the hardened js-function/nodejs sandboxes, a freedom-node tool receives
 * normal Node.js capabilities where available to the host runtime:
 *
 *   - require()/import() resolve REAL modules: Node built-ins (fs, path, os,
 *     child_process, process, streams …) AND installed npm packages
 *   - the REAL host filesystem (fs writes/reads are never redirected into
 *     the restricted tool VFS — §23)
 *   - the REAL global fetch/network — the Network Policy request limits
 *     (request count, response size, redirect count, per-request timeout,
 *     URL import restriction) deliberately DO NOT apply (§24)
 *   - the real `process` object (including process.env) and Buffer (§21)
 *
 * STILL PRESERVED (higher-level task lifecycle, §32):
 *   - the tool execution deadline (interaction-aware watchdog) and the vm
 *     sync cap — the task runtime must be able to track/stop/cancel a tool
 *     and keep the event loop responsive
 *   - the JSON-serializable result contract of the execution result/event
 *     architecture (bounded by the RESULT_TRANSPORT_CAP — the runtime
 *     transport bound, NOT a sandbox restriction)
 *   - the capped console capture (logging architecture) — the runtime never
 *     automatically dumps process.env or host credentials into logs (§33)
 *
 * CONFIGURATION-ONLY GATE (§27/§28 — fail closed): the whole freedom escape
 * is authorized by the central `fs` section of config/configuration-limits.json
 * (fs.enabled=true, fs.restricted=false). The Settings UI deliberately has NO
 * control for it and no API can flip it — editing the configuration FILE on
 * the host is the only way. When the gate is closed (or the file is
 * unreadable) every freedom-node execution is REJECTED with FREEDOM_DISABLED.
 *
 * This file is a DEDICATED runtime path: the restricted js-runner and
 * node-runner are untouched (§31).
 */

import vm from 'node:vm';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  declaresExecute,
  syncTimeoutMs,
  maxFunctionSourceChars,
  maxLogLines,
  maxLogLineChars,
} from './js-runner';
import { defaultToolTimeoutMs, maxToolTimeoutMs } from './timeout';
import { transformDynamicImports, RUNTIME_IMPORT_SHIM } from './import-resolver';
import {
  createRuntimeInteractions,
  createTestInteractions,
  type SandboxInteractions,
} from './sandbox-interactive';
import { getFreedomFsConfig, getResolvedLimits } from '../config-limits';

/** Host-realm require rooted at the project — REAL npm packages + builtins. */
const freedomRequire = createRequire(path.join(process.cwd(), 'package.json'));

/** Host-realm dynamic import (real ESM: node: builtins + npm packages). */
const freedomDynamicImport = async (specifier: string): Promise<unknown> => {
  const dynamicImport = new Function('s', 'return import(s);') as (s: string) => Promise<unknown>;
  return dynamicImport(specifier);
};

export interface FreedomNodeContext {
  executionId: string;
  taskId?: string;
  /** "test" for Tool-Editor test runs, "production" for real task executions. */
  mode: 'test' | 'production';
  now: string;
  log: (...parts: unknown[]) => void;
}

export interface FreedomNodeExecution {
  toolId?: string;
  /** Intentionally NOT part of freedom-node: no VFS session, no network
   *  accounting — real fs/network instead. Kept for the deadline wiring. */
  interactions?: SandboxInteractions;
  timeoutMs?: number;
}

export interface FreedomNodeRunResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  logs: string[];
}

/** The serialized-result transport bound for freedom-node results (5 MiB —
 *  the execution/event architecture bound, not a sandbox restriction). */
const FREEDOM_RESULT_TRANSPORT_CAP = 5 * 1024 * 1024;

/**
 * §28 — THE configuration-only gate. Reads the authoritative `fs` section
 * server-side on EVERY execution. Fail closed: any error → not authorized.
 */
export function isFreedomNodeAuthorized(): boolean {
  const fs = getFreedomFsConfig();
  return fs.enabled === true && fs.restricted === false;
}

export function freedomDisabledError(): { code: string; message: string } {
  return {
    code: 'FREEDOM_DISABLED',
    message: 'freedom-node is not authorized by the central configuration (fs.enabled/fs.restricted in config/configuration-limits.json). The Settings UI cannot grant this escape — edit the configuration file on the host.',
  };
}

function liveExecutionCaps() {
  try {
    const e = getResolvedLimits().execution;
    return { maxLogs: e.maxLogs, maxLogLineChars: e.maxLogLineChars, sourceChars: e.maxSourceChars };
  } catch {
    return { maxLogs: maxLogLines(), maxLogLineChars: maxLogLineChars(), sourceChars: maxFunctionSourceChars() };
  }
}

/** Mirrors js-runner serialization with the freedom transport cap. */
function ensureSerializableCapped(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): { ok: true; value: unknown } | { ok: false; message: string } {
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
        const r = ensureSerializableCapped(item, depth + 1, seen);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const r = ensureSerializableCapped(v, depth + 1, seen);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      const json = JSON.stringify(out);
      if (json && json.length > FREEDOM_RESULT_TRANSPORT_CAP) {
        return { ok: false, message: `Result exceeds the ${FREEDOM_RESULT_TRANSPORT_CAP}-byte runtime transport cap when serialized.` };
      }
      return { ok: true, value: out };
    }
    return { ok: false, message: 'Result contains an unsupported value type.' };
  } finally {
    seen.delete(value);
  }
}

function stringifyLogPart(part: unknown): string {
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function wrapFreedomSource(source: string): string {
  return declaresExecute(source)
    ? `${source}\nexecute`
    : `(async function execute(params, context) {\n${source}\n})`;
}

/** Compile-time validation — same authoring contract as js-function/nodejs. */
export function validateFreedomNodeSource(source: string): { ok: true } | { ok: false; error: string } {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, error: 'Function source is empty.' };
  }
  const { sourceChars } = liveExecutionCaps();
  if (source.length > sourceChars) {
    return { ok: false, error: `Function source exceeds ${sourceChars} characters.` };
  }
  try {
    // Same probe approach as js-runner: Bun defers vm.Script compilation, so
    // actually run the definition (never invoked) in a throwaway context.
    const probe = new vm.Script(wrapFreedomSource(transformDynamicImports(source)), { filename: 'freedom-tool.js' });
    probe.runInNewContext({ [RUNTIME_IMPORT_SHIM]: () => { throw new Error('import() is unavailable at validation time.'); } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Syntax error in function source.' };
  }
}

/**
 * Execute a freedom-node tool. NEVER throws — returns a structured result.
 * The unrestricted escape is gated by the central `fs` configuration (§28).
 */
export function runFreedomNodeTool(
  source: string,
  params: Record<string, unknown>,
  context: FreedomNodeContext,
  exec: FreedomNodeExecution = {},
): Promise<FreedomNodeRunResult> {
  return new Promise((resolve) => {
    // §27/§28 — fail closed before ANY unrestricted capability is created.
    if (!isFreedomNodeAuthorized()) {
      resolve({ ok: false, error: freedomDisabledError(), logs: [] });
      return;
    }

    const caps = liveExecutionCaps();
    const logs: string[] = [];
    const pushLog = (...parts: unknown[]) => {
      if (logs.length >= caps.maxLogs) return;
      logs.push(parts.map(stringifyLogPart).join(' ').slice(0, caps.maxLogLineChars));
    };

    // §32 — the tool execution deadline (task lifecycle) is preserved; only
    // the SANDBOX restrictions (VFS/network policy/request caps) are absent.
    let execTimeoutMs = defaultToolTimeoutMs();
    if (exec.timeoutMs && Number.isFinite(exec.timeoutMs) && exec.timeoutMs > 0) {
      execTimeoutMs = Math.min(Math.round(exec.timeoutMs), maxToolTimeoutMs());
    }
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
    const finish = (result: FreedomNodeRunResult) => {
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
        // §21 — REAL Node.js capabilities:
        require: freedomRequire,
        process, // real process (incl. process.env — intentional freedom, §21/§33)
        Buffer,
        // §24 — REAL network: the host global fetch, NOT the Network Policy
        // wrapper. No request-count/response-size/redirect/timeout caps.
        fetch: (input: string | URL, init?: RequestInit) => fetch(input, init),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        setImmediate,
        clearImmediate,
        queueMicrotask,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        atob,
        btoa,
        structuredClone,
        alert: interactions.alert,
        prompt: interactions.prompt,
        confirm: interactions.confirm,
        [RUNTIME_IMPORT_SHIM]: freedomDynamicImport,
      });
    } catch (err) {
      finish({ ok: false, error: { code: 'SANDBOX_ERROR', message: err instanceof Error ? err.message : 'Failed to create the freedom-node context.' }, logs: [] });
      return;
    }

    try {
      const compiled = new vm.Script(wrapFreedomSource(transformDynamicImports(source)), { filename: 'freedom-tool.js' });
      const fn = compiled.runInContext(sandbox, { timeout: syncCap }) as
        | ((p: Record<string, unknown>, c: unknown) => Promise<unknown>);
      if (typeof fn !== 'function') {
        finish({ ok: false, error: { code: 'INVALID_FUNCTION', message: 'Source did not compile to an execute function.' }, logs: [] });
        return;
      }
      // Sync portion runs under the vm timeout (event-loop protection, §32).
      const host = sandbox as unknown as Record<string, unknown>;
      host.__nexoolRun = fn;
      new vm.Script('__nexoolResult = __nexoolRun(params, context)', { filename: 'freedom-tool.js' })
        .runInContext(sandbox, { timeout: syncCap });
      Promise.resolve(host.__nexoolResult)
        .then((value) => {
          const check = ensureSerializableCapped(value);
          if (!check.ok) {
            finish({ ok: false, error: { code: 'NOT_SERIALIZABLE', message: check.message }, logs: [] });
            return;
          }
          finish({ ok: true, result: check.value, logs: [] });
        })
        .catch((err: unknown) => {
          const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : undefined;
          finish({
            ok: false,
            error: { code: code && code !== 'TOOL_FAILURE' ? code : 'TOOL_FAILURE', message: err instanceof Error ? err.message : String(err) },
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
