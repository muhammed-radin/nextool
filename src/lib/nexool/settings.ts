/**
 * NexTool Settings — DB-backed global settings with in-memory cache (10s).
 *
 * v1.0.8 (§7/§8/§10.1): every numeric clamp is resolved from the CENTRAL
 * configuration limits (config/configuration-limits.json → task.* metadata) —
 * no hard-coded min/max remain here. Backend validation (schemas.ts) and the
 * Settings UI use the same resolved limits, so frontend, backend and runtime
 * agree (spec §8.5).
 */
import { db } from '@/lib/db';
import type { NexToolSettings } from './types';
import { clampToLimit, getResolvedLimits } from './config-limits';

/** Shipped defaults — resolved from the central limits file at module load.
 *  A self-hosted administrator edits config/configuration-limits.json to
 *  change any of these defaults (no source modification, spec §7.9). */
export const DEFAULT_SETTINGS: NexToolSettings = {
  defaultMode: 'goal',
  defaultReasoningLevel: 4,
  maxSubtoolCalls: limitsDefault('task', 'maxSubtoolCalls', 20),
  safetyLimit: limitsDefault('task', 'safetyLimit', 100),
  maxIterations: limitsDefault('task', 'maxIterations', 30),
  taskTimeoutMs: limitsDefault('task', 'taskTimeoutMs', 120_000),
  // v1.0.7 §1 — default tool execution timeout is 10 seconds (10000 ms);
  // configurable up to the configured maximum (shipped 1 hour).
  toolTimeoutMs: limitsDefault('task', 'toolTimeoutMs', 10_000),
  // v1.0.9 §14 — Global Network Policy request timeout (default 60 s).
  // Bounds resolve from the central network.timeoutMs metadata (1 s … 1 h).
  // Deliberately separate from toolTimeoutMs — one never overwrites the other.
  networkRequestTimeoutMs: limitsDefault('network', 'timeoutMs', 60_000),
  liveIntervalMs: limitsDefault('task', 'liveIntervalMs', 60_000),
  useMemory: true,
  parallelToolCalls: true,
  maxParallelToolCalls: limitsDefault('task', 'maxParallelToolCalls', 4),
  // v1.0.6 — approval + multi-event defaults (spec §9.3/§10.1: false)
  autoExecuteTools: false,
  allowMultipleEvents: false,
  // v1.0.10 §12.1/§16 — global default planner strategy (pre-plan preserves
  // existing behavior for existing installations, no migration needed) and
  // the global default pre-plan step limit (default 10, hard max 122).
  defaultPlannerType: 'pre-plan',
  prePlanMaxSteps: limitsDefault('task', 'prePlanMaxSteps', 10),
  logLevel: 'info',
  realTimeTransport: 'sse',
};

/** Read one default from the central limits; fall back to the shipped value
 *  only when the limits file cannot be read at module-load time (the loader
 *  itself fails clearly on invalid files). */
function limitsDefault(section: string, key: string, fallback: number): number {
  try {
    const prop = getResolvedLimits();
    const value = (prop as unknown as Record<string, Record<string, { default?: number }>>)[section]?.[key]?.default;
    return typeof value === 'number' ? value : fallback;
  } catch {
    return fallback;
  }
}

const g = globalThis as unknown as { __nextoolSettings?: { value: NexToolSettings; fetchedAt: number } };

const CACHE_MS = 10_000;

export async function getSettings(force = false): Promise<NexToolSettings> {
  const cached = g.__nextoolSettings;
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.value;
  }
  try {
    const row = await db.setting.findUnique({ where: { key: 'nextool' } });
    let value: NexToolSettings = { ...DEFAULT_SETTINGS };
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<NexToolSettings>;
      value = { ...DEFAULT_SETTINGS, ...parsed };
    }
    g.__nextoolSettings = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    console.error('[settings] load failed, using defaults:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateSettings(partial: Partial<NexToolSettings>): Promise<NexToolSettings> {
  const current = await getSettings(true);
  const next: NexToolSettings = { ...current, ...partial };
  // v1.0.8 — every clamp is the central limits' [min, max] for the property.
  next.maxSubtoolCalls = clampToLimit('task', 'maxSubtoolCalls', next.maxSubtoolCalls);
  next.safetyLimit = clampToLimit('task', 'safetyLimit', next.safetyLimit);
  next.maxIterations = clampToLimit('task', 'maxIterations', next.maxIterations);
  next.taskTimeoutMs = clampToLimit('task', 'taskTimeoutMs', next.taskTimeoutMs);
  // v1.0.7 §1 — tool timeout: default 10 s, ceiling = execution.timeoutMs.max.
  next.toolTimeoutMs = clampToLimit('task', 'toolTimeoutMs', next.toolTimeoutMs);
  // v1.0.9 §14 — Network Policy request timeout: bounds = network.timeoutMs
  // [min, max] from the central limits (backend validation agrees with the
  // frontend schema and the runtime clamp — spec §14.8).
  next.networkRequestTimeoutMs = clampToLimit('network', 'timeoutMs', next.networkRequestTimeoutMs);
  next.liveIntervalMs = clampToLimit('task', 'liveIntervalMs', next.liveIntervalMs);
  next.parallelToolCalls = next.parallelToolCalls !== false;
  next.maxParallelToolCalls = clampToLimit('task', 'maxParallelToolCalls', next.maxParallelToolCalls);
  // v1.0.6 — booleans default false when absent/garbage
  next.autoExecuteTools = next.autoExecuteTools === true;
  next.allowMultipleEvents = next.allowMultipleEvents === true;
  // v1.0.10 §12.1/§16 — planner defaults: invalid planner type falls back to
  // 'pre-plan'; the pre-plan step limit clamps into the central bounds
  // [task.prePlanMaxSteps.min, task.prePlanMaxSteps.max] (1..122).
  if (next.defaultPlannerType !== 'pre-plan' && next.defaultPlannerType !== 'one-by-one') {
    next.defaultPlannerType = 'pre-plan';
  }
  next.prePlanMaxSteps = clampToLimit('task', 'prePlanMaxSteps', next.prePlanMaxSteps);
  if (next.defaultMode !== 'goal' && next.defaultMode !== 'live') next.defaultMode = 'goal';
  next.defaultReasoningLevel = clampNum(next.defaultReasoningLevel, 1, 6) as NexToolSettings['defaultReasoningLevel'];
  if (next.logLevel !== 'info' && next.logLevel !== 'debug' && next.logLevel !== 'error') next.logLevel = 'info';

  await db.setting.upsert({
    where: { key: 'nextool' },
    update: { value: JSON.stringify(next) },
    create: { key: 'nextool', value: JSON.stringify(next) },
  });
  g.__nextoolSettings = { value: next, fetchedAt: Date.now() };
  return next;
}

function clampNum(v: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.round(n), min), max);
}
