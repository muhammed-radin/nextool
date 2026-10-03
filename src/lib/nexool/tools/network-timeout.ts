/**
 * NexTool v1.0.9 — Network Policy request-timeout resolution (spec §14).
 *
 * ONE authoritative resolver for the timeout applied to EACH individual
 * network request made inside a tool (fetch / XHR / virtual http(s) / URL
 * imports / npm registry access — every path funnels through policyFetch).
 *
 * The Network Request Timeout is a SEPARATE limit from the Tool Execution
 * Timeout (spec §14.3):
 *
 *   Tool execution timeout = 300000ms  → the tool may live for 5 minutes.
 *   Network request timeout = 120000ms → one network request may live 2 min.
 *
 * Neither setting silently overwrites the other. Resolution precedence
 * (first present wins, every value clamped into the central limits):
 *
 *   1. Request-specific override  (fetch(url, { timeoutMs }) on ONE request)
 *   2. Tool-specific Network Policy (ToolDefinition.networkTimeoutMs)
 *   3. Task-level Network Policy    (task/run config → HandlerContext)
 *   4. Global Network Policy        (Settings.networkRequestTimeoutMs —
 *                                    the Settings-page "Network Request
 *                                    Request Timeout" value)
 *   5. Shipped default              (network.timeoutMs default in
 *                                    config/configuration-limits.json)
 *
 * Hard bounds: [network.timeoutMs.min, network.timeoutMs.max] from the
 * central limits file (shipped 1 s … 1 h). A resolved request timeout is
 * additionally capped by the owning tool's EFFECTIVE execution timeout when
 * one is known — a request can never outlive its tool (documented rule,
 * unchanged from v1.0.8).
 *
 * v1.0.9 fixes the v1.0.8 conflation where the TOOL EXECUTION timeout was
 * passed as the per-request timeout — the 10-second tool DEFAULT therefore
 * killed legitimate slow requests (llm.chat) even when the tool itself had
 * a 5-minute execution timeout.
 */

import { getLimitProperty, getResolvedLimits } from '../config-limits';

export type NetworkTimeoutSource = 'request' | 'tool' | 'task' | 'global' | 'default';

export interface NetworkTimeoutResolution {
  /** The timeout actually enforced for ONE network request (ms). */
  effective: number;
  /** Which configuration layer provided the value. */
  source: NetworkTimeoutSource;
  /** True when the value was clamped/capped by the limits or the tool ceiling. */
  capped: boolean;
}

export interface NetworkTimeoutInput {
  /** (1) Per-request override — fetch(url, { timeoutMs }). */
  requestOverrideMs?: unknown;
  /** (2) Tool-specific Network Policy — ToolDefinition.networkTimeoutMs. */
  toolNetworkTimeoutMs?: unknown;
  /** (3) Task-level Network Policy — run/task config. */
  taskNetworkTimeoutMs?: unknown;
  /** (4) Global Network Policy — Settings.networkRequestTimeoutMs. */
  globalSettingMs?: unknown;
  /** The owning tool's EFFECTIVE execution timeout (ms) — optional ceiling. */
  toolExecutionTimeoutMs?: unknown;
}

function finiteNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** LIVE hard bounds for the network request timeout (central limits). */
export function networkTimeoutBounds(): { min: number; max: number; default: number } {
  try {
    const prop = getLimitProperty('network', 'timeoutMs');
    return {
      min: typeof prop.min === 'number' ? prop.min : 1_000,
      max: typeof prop.max === 'number' ? prop.max : 3_600_000,
      default: typeof prop.default === 'number' ? prop.default : 60_000,
    };
  } catch {
    return { min: 1_000, max: 3_600_000, default: 60_000 };
  }
}

/** Clamp any candidate into the central limits' [min, max]. */
export function clampNetworkTimeoutMs(v: unknown): number {
  const { min, max, default: def } = networkTimeoutBounds();
  const n = finiteNumber(v);
  if (n === undefined) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * Resolve the effective per-request Network Policy timeout (pure — no I/O).
 * Callers that want the LIVE global value from Settings pass it explicitly
 * (see resolveNetworkRequestTimeoutForExecution below).
 */
export function resolveNetworkRequestTimeoutMs(input: NetworkTimeoutInput = {}): NetworkTimeoutResolution {
  const { min, max, default: def } = networkTimeoutBounds();

  const candidates: { source: NetworkTimeoutSource; value: number | undefined }[] = [
    { source: 'request', value: finiteNumber(input.requestOverrideMs) },
    { source: 'tool', value: finiteNumber(input.toolNetworkTimeoutMs) },
    { source: 'task', value: finiteNumber(input.taskNetworkTimeoutMs) },
    { source: 'global', value: finiteNumber(input.globalSettingMs) },
  ];

  const first = candidates.find((c) => c.value !== undefined && c.value > 0);
  const base = first && first.value !== undefined ? first.value : def;
  const source: NetworkTimeoutSource = first ? first.source : 'default';

  // Clamp into the central limits bounds, then cap by the owning tool's
  // effective execution timeout (a request never outlives its tool).
  const toolCeiling = finiteNumber(input.toolExecutionTimeoutMs);
  const hardMax = toolCeiling !== undefined && toolCeiling > 0 ? Math.min(max, Math.round(toolCeiling)) : max;
  const effective = Math.min(Math.max(Math.round(base), min), hardMax);
  return { effective, source, capped: effective !== base };
}

/** The LIVE shipped default (network.timeoutMs.default) — no Settings read. */
export function defaultNetworkRequestTimeoutMs(): number {
  try {
    return getResolvedLimits().network.timeoutMs;
  } catch {
    return networkTimeoutBounds().default;
  }
}

export interface ExecutionNetworkTimeoutInput {
  /** (1) Per-request override — highest precedence (v1.0.9 §14). */
  requestOverrideMs?: unknown;
  /** (2) Tool-specific Network Policy — ToolDefinition.networkTimeoutMs. */
  toolNetworkTimeoutMs?: unknown;
  /** (3) Task-level Network Policy — run/task config. */
  taskNetworkTimeoutMs?: unknown;
  /** The owning tool's EFFECTIVE execution timeout (ms) — optional ceiling. */
  toolExecutionTimeoutMs?: unknown;
}

/**
 * Async convenience used by the tool handlers: resolves the GLOBAL layer
 * from the persisted Settings (Settings UI → API → this resolver) and then
 * applies the same precedence + clamps. Never throws — a Settings failure
 * falls back to the shipped default.
 */
export async function resolveNetworkRequestTimeoutForExecution(
  input: ExecutionNetworkTimeoutInput = {},
): Promise<NetworkTimeoutResolution> {
  let globalSettingMs: number | undefined;
  try {
    // Late import keeps this module usable from pure/unit contexts.
    const { getSettings } = await import('../settings');
    const settings = await getSettings();
    globalSettingMs = settings.networkRequestTimeoutMs;
  } catch {
    globalSettingMs = undefined; // shipped default applies
  }
  return resolveNetworkRequestTimeoutMs({ ...input, globalSettingMs });
}
