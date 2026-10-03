/**
 * NexTool v1.0.8 — centralized tool execution timeout configuration.
 *
 * ONE source of truth for every timeout decision around tool execution:
 *
 *   Global/default timeout  (Settings.toolTimeoutMs ← task.toolTimeoutMs default)
 *         ↓ overridden by
 *   Tool-specific timeout   (ToolDefinition.timeoutMs, optional)
 *         ↓ bounded by
 *   Runtime-enforced max    (execution.timeoutMs.max — from the CENTRAL
 *                            configuration-limits.json; shipped 1 hour,
 *                            raiseable by a self-hosted administrator by
 *                            editing that single file — never bypassable
 *                            by tools)
 *
 * v1.0.8: the hard ceiling is no longer a hard-coded TypeScript constant —
 * it is resolved from config/configuration-limits.json (execution.timeoutMs).
 * The shipped file contains max = 3600000ms (1 hour), preserving the
 * documented v1.0.7 behavior; a self-hosted administrator may raise it there
 * (spec §7.9) and every layer (Settings UI, API validation, runtime) follows
 * the same resolved value (spec §8.5).
 *
 * Separate concerns that are intentionally NOT touched by this module:
 *   - Tool approval timeout  (5 minutes, v1.0.6 §9 — user approval, unchanged)
 *   - Prompt timeout         (120 s, v1.0.6 — interactive prompts, unchanged)
 *   - Confirmation timeout   (120 s, v1.0.8 §1.4 — resolves false, unchanged)
 *   - Task timeout           (task.taskTimeoutMs — the whole task, unchanged)
 *   - Network request timeout(network.timeoutMs — one request, §14 documents
 *                              which timeout governs which operation)
 */

import { getLimitProperty, getResolvedLimits } from '../config-limits';

/** Documented shipped default — 10 seconds (execution.timeoutMs.default). */
export const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/** Shipped hard runtime ceiling — 1 hour. The LIVE ceiling is resolved from
 *  the central limits file (execution.timeoutMs.max) via maxToolTimeoutMs();
 *  this constant remains the documented shipped value used as the last-resort
 *  fallback if the limits file cannot be read at that instant. */
export const MAX_TOOL_TIMEOUT_MS = 3_600_000;

/** Smallest shipped configurable value (1 s) — protects against zero/negative values. */
export const MIN_TOOL_TIMEOUT_MS = 1_000;

/** Internal floor for computed effective values (executor watchdog safety). */
export const EFFECTIVE_TIMEOUT_FLOOR_MS = 250;

/** LIVE runtime ceiling (execution.timeoutMs.max from the central limits). */
export function maxToolTimeoutMs(): number {
  try {
    const prop = getLimitProperty('execution', 'timeoutMs');
    if (typeof prop.max === 'number') return prop.max;
  } catch {
    /* fall through to the shipped constant */
  }
  return MAX_TOOL_TIMEOUT_MS;
}

/** LIVE global default (task.toolTimeoutMs default — shipped 10 s). */
export function defaultToolTimeoutMs(): number {
  try {
    return getResolvedLimits().task.toolTimeoutMs;
  } catch {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }
}

export type ToolTimeoutSource = 'tool' | 'task' | 'global' | 'default';

export interface EffectiveToolTimeout {
  /** The timeout actually enforced (already capped at the live maximum). */
  effective: number;
  /** Which configuration layer provided the value. */
  source: ToolTimeoutSource;
  /** True when a configured value exceeded the ceiling and was capped. */
  capped: boolean;
}

function finiteNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Sanitize a user/tool supplied timeout value (tool-level or global config).
 * Returns undefined when the value is absent/not a number. Values are clamped
 * into [MIN_TOOL_TIMEOUT_MS, live maximum].
 */
export function sanitizeConfiguredToolTimeoutMs(v: unknown, fallback = DEFAULT_TOOL_TIMEOUT_MS): number {
  const n = finiteNumber(v);
  if (n === undefined) return fallback;
  return Math.min(Math.max(Math.round(n), MIN_TOOL_TIMEOUT_MS), maxToolTimeoutMs());
}

/**
 * Resolve the effective tool execution timeout (v1.0.7 §1 precedence):
 *   tool-specific → task/global default (caller-supplied) → module default,
 * then cap at the runtime maximum (live execution.timeoutMs.max). The
 * returned `capped` flag reports when a configuration above the ceiling was
 * rejected by the runtime.
 */
export function resolveEffectiveToolTimeout(opts: {
  /** Tool-level configuration (ToolDefinition.timeoutMs). */
  toolTimeoutMs?: unknown;
  /** Task/global default passed down the Task → Main → CoreModule chain. */
  fallbackTimeoutMs?: unknown;
  /** Extra fallback when neither layer configured anything (defaults to the central default). */
  defaultTimeoutMs?: number;
} = {}): EffectiveToolTimeout {
  const tool = finiteNumber(opts.toolTimeoutMs);
  const fallback = finiteNumber(opts.fallbackTimeoutMs);
  const base = opts.defaultTimeoutMs ?? defaultToolTimeoutMs();
  const max = maxToolTimeoutMs();

  if (tool !== undefined) {
    const effective = Math.min(Math.max(Math.round(tool), EFFECTIVE_TIMEOUT_FLOOR_MS), max);
    return { effective, source: 'tool', capped: tool > max };
  }
  if (fallback !== undefined) {
    const effective = Math.min(Math.max(Math.round(fallback), EFFECTIVE_TIMEOUT_FLOOR_MS), max);
    return { effective, source: 'task', capped: fallback > max };
  }
  const sanitized = sanitizeConfiguredToolTimeoutMs(base);
  return { effective: Math.max(sanitized, EFFECTIVE_TIMEOUT_FLOOR_MS), source: 'default', capped: false };
}

/**
 * Human-facing hint used by the Settings UI, Tool IDE and documentation —
 * derived from the live limits: "Default: 10 seconds · Maximum: 1 hour".
 */
export function toolTimeoutHint(): string {
  const max = maxToolTimeoutMs();
  const maxLabel = max === 3_600_000 ? '1 hour (3600000 ms)' : `${max} ms`;
  return `Default: ${Math.round(defaultToolTimeoutMs() / 1000)} seconds (${defaultToolTimeoutMs()} ms) · Maximum: ${maxLabel}`;
}

/** Backwards-compatible static hint (shipped values). */
export const TOOL_TIMEOUT_HINT = 'Default: 10 seconds (10000 ms) · Maximum: 1 hour (3600000 ms)';
