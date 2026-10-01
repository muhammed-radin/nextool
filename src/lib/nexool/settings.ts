/**
 * NexTool Settings — DB-backed global settings with in-memory cache (10s).
 */
import { db } from '@/lib/db';
import type { NexToolSettings } from './types';

export const DEFAULT_SETTINGS: NexToolSettings = {
  defaultMode: 'goal',
  defaultReasoningLevel: 4,
  maxSubtoolCalls: 20,
  safetyLimit: 100,
  maxIterations: 30,
  taskTimeoutMs: 120000,
  toolTimeoutMs: 30000,
  liveIntervalMs: 60000,
  useMemory: true,
  logLevel: 'info',
  realTimeTransport: 'sse',
};

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
  // sanitize
  next.maxSubtoolCalls = clampNum(next.maxSubtoolCalls, 1, 200);
  next.safetyLimit = clampNum(next.safetyLimit, 1, 500);
  next.maxIterations = clampNum(next.maxIterations, 1, 200);
  next.taskTimeoutMs = clampNum(next.taskTimeoutMs, 5_000, 3_600_000);
  next.toolTimeoutMs = clampNum(next.toolTimeoutMs, 1_000, 300_000);
  next.liveIntervalMs = clampNum(next.liveIntervalMs, 1_000, 3_600_000);
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
