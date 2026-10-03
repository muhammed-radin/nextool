/**
 * NexTool v1.0.7 — maintenance operations (spec §3, §4, §5, §4.11).
 *
 * Three operations, one safety philosophy: NEVER a broad wipe.
 *
 *  1. resetApplicationRuntime()      — §3 "Reset Application Data". Clears
 *     RUNTIME data (tasks, events, history, memory, notifications, statistics,
 *     generated images, tool workspaces) while explicitly PROTECTING tools,
 *     models, datasets, training/benchmark records and settings. Implemented
 *     as an explicit ALLOWLIST of deletable stores — there is no code path
 *     that can delete the whole database or a storage directory.
 *
 *  2. analyzeResourceDependencies()  — §4.2 dependency analysis over models
 *     and datasets. A resource is only a cleanup candidate when it has NO
 *     inbound references (training jobs, benchmark runs, active status).
 *     Filename/age/never used heuristics are never used.
 *
 *  3. runResourceCleanup()           — §4.7/§5 deletes ONLY confirmed
 *     orphaned records (discover → classify → resolve → protect → delete) and
 *     is IDEMPOTENT: a second run removes nothing new.
 *
 *  4. validateRuntimeDependencies()  — §4.11 startup/on-demand validation of
 *     the active model, artifacts and dataset/model reference integrity.
 *     Reports clear errors; never silently creates replacements.
 */

import { db } from '@/lib/db';
import { emitEvent, resetBusRuntimeState } from './eventbus';
import { CORE_MODULE_FALLBACK, CORE_MODULE_NAME, CORE_MODULE_VERSION } from './version';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

// =====================================================================
// §3 — Reset Application Data
// =====================================================================

/** The exact confirmation phrase required by §3.3. */
export const RESET_CONFIRMATION_PHRASE = 'RESET';

/** Resources that reset MUST preserve (§3.5) — documentation + tests guard. */
export const RESET_PROTECTED_RESOURCES = [
  'Tools (definitions, handler config, function source)',
  'Models (registrations, manifests, artifacts)',
  'Datasets (records, examples, files)',
  'Training jobs + benchmark runs (model/dataset provenance, training artifacts)',
  'Settings (including the v1.0.7 timeout configuration)',
] as const;

interface ResetReport {
  ok: boolean;
  confirmPhrase: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  /** Rows cleared per runtime store. */
  cleared: Record<string, number>;
  /** Best-effort physical files removed (generated images). */
  filesRemoved: number;
  /** Non-fatal failures — reset still completed for the other stores. */
  failures: string[];
  protectedResources: readonly string[];
}

/**
 * The ONLY stores the reset is allowed to touch (§3.4 runtime data) plus the
 * statistics-zeroing update on ToolRecord (tools themselves are preserved —
 * only their usage counters reset). Everything else is structurally
 * unreachable from this function (no `deleteMany({})` outside this list).
 */
function resetTransactionOps() {
  return [
    // stored events + event history
    db.taskEvent.deleteMany({}),
    // task history + execution history (HistoryEntry rows cascade with tasks,
    // but the explicit delete keeps the operation deterministic)
    db.historyEntry.deleteMany({}),
    // task histories + their persisted live/state/queue runtime state
    db.task.deleteMany({}),
    // persistent memory
    db.memoryEntry.deleteMany({}),
    // notifications (runtime event surface)
    db.notificationRecord.deleteMany({}),
    // runtime cached generated images (rows; files removed best-effort below)
    db.generatedImage.deleteMany({}),
    // tool runtime workspaces (Virtual FS = temporary runtime state; tool
    // DEFINITIONS/SOURCE are preserved — see RESET_PROTECTED_RESOURCES)
    db.virtualFile.deleteMany({}),
    // statistics → reset (usage counters only; the tools stay)
    db.toolRecord.updateMany({
      data: { callCount: 0, successCount: 0, failureCount: 0, timeoutCount: 0, totalMs: 0 },
    }),
  ];
}

/**
 * §3 — perform the runtime data reset. Requires the exact confirmation
 * phrase (defense in depth; the API also enforces it via zod).
 */
export async function resetApplicationRuntime(confirmPhrase: string): Promise<ResetReport> {
  const startedAt = new Date().toISOString();
  const startedEpoch = Date.now();
  const report: ResetReport = {
    ok: false,
    confirmPhrase: confirmPhrase === RESET_CONFIRMATION_PHRASE ? RESET_CONFIRMATION_PHRASE : 'invalid',
    startedAt,
    durationMs: 0,
    cleared: {},
    filesRemoved: 0,
    failures: [],
    protectedResources: RESET_PROTECTED_RESOURCES,
  };

  if (confirmPhrase !== RESET_CONFIRMATION_PHRASE) {
    report.failures.push('Confirmation phrase did not match — nothing was reset.');
    report.durationMs = Date.now() - startedEpoch;
    return report;
  }

  // §3.8 — emit system.reset.started (persisted; it is intentionally cleared
  // again by the reset itself — "do not preserve the old event history").
  void emitEvent({
    type: 'system.reset.started',
    source: 'system',
    message: 'Application runtime data reset started.',
    priority: 2,
  });

  const pathsToRemove: string[] = [];
  try {
    // Collect generated-image file paths inside the transaction for the
    // best-effort filesystem pass afterwards.
    const imageRows = await db.generatedImage.findMany({ select: { path: true } });
    pathsToRemove.push(...imageRows.map((r) => r.path));

    // §3.7 — controlled, all-or-nothing deletion of the runtime allowlist.
    const results = await db.$transaction(resetTransactionOps());
    const names = [
      'taskEvents', 'historyEntries', 'tasks', 'memoryEntries',
      'notifications', 'generatedImages', 'virtualFiles',
    ];
    // The last op is the ToolRecord statistics reset (updateMany → count).
    names.forEach((name, i) => { report.cleared[name] = results[i]?.count ?? 0; });
    report.cleared.toolStatistics = results[results.length - 1]?.count ?? 0;

    report.ok = true;
  } catch (err) {
    // §3.7 — report failure; never claim complete success.
    report.failures.push(err instanceof Error ? err.message : String(err));
    void emitEvent({
      type: 'system.reset.failed',
      source: 'system',
      message: `Application runtime data reset FAILED: ${err instanceof Error ? err.message : String(err)}`,
      priority: 2,
    });
    report.durationMs = Date.now() - startedEpoch;
    return report;
  }

  // In-memory runtime caches + statistics (§3.4 session/runtime state).
  try {
    resetBusRuntimeState();
  } catch (err) {
    report.failures.push(`in-memory runtime reset: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Best-effort physical removal of generated images (runtime cached data).
  for (const p of pathsToRemove) {
    if (typeof p !== 'string' || !p.startsWith('/generated/') || p.includes('..')) continue;
    try {
      await unlink(path.join(process.cwd(), 'public', p));
      report.filesRemoved += 1;
    } catch {
      // file already gone / busy — non-fatal, recorded as a soft count miss
    }
  }

  report.completedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedEpoch;

  // §3.8 — system.reset.completed persists as the minimal audit record.
  void emitEvent({
    type: 'system.reset.completed',
    source: 'system',
    message: `Application runtime data reset completed in ${report.durationMs}ms (tools, models and datasets preserved).`,
    data: { cleared: report.cleared, filesRemoved: report.filesRemoved, failures: report.failures },
    priority: 2,
  });

  return report;
}

// =====================================================================
// §4/§5 — Model/Dataset dependency analysis + idempotent cleanup
// =====================================================================

export interface DependencyRef {
  /** Where the reference comes from (human readable). */
  source: string;
  kind: 'training' | 'benchmark' | 'status';
}

export interface ResourceDependencyEntry {
  id: string;
  name: string;
  version: string;
  status: string;
  references: DependencyRef[];
  protectedResource: boolean;
  reasons: string[];
  /** true when the record has no inbound references (cleanup candidate). */
  orphaned: boolean;
  /** §4.10 — manifest/metadata parse health. */
  healthy: boolean;
}

export interface ResourceDependencyReport {
  models: ResourceDependencyEntry[];
  datasets: ResourceDependencyEntry[];
  /** Broken references discovered during analysis (never auto-deleted). */
  warnings: string[];
  analyzedAt: string;
}

/**
 * §4.2 — build the dependency graph and classify every model and dataset.
 *
 * A MODEL is protected when: a training job references it, a benchmark run
 * references it, or it carries status "active". Everything else is an
 * orphaned candidate — NOT deleted merely for being old/duplicate-named.
 *
 * A DATASET is protected when: a training job references it or a benchmark
 * run references it. The versioned DatasetRecord import system means
 * same-name datasets are NOT automatically duplicates (§4.4).
 */
export async function analyzeResourceDependencies(): Promise<ResourceDependencyReport> {
  const [models, datasets, trainingJobs, benchmarkRuns] = await Promise.all([
    db.modelRecord.findMany({ orderBy: { createdAt: 'asc' } }),
    db.datasetRecord.findMany({ orderBy: { createdAt: 'asc' } }),
    db.trainingJobRecord.findMany({
      select: { id: true, datasetId: true, modelRecordId: true, status: true, datasetName: true, datasetVersion: true },
    }),
    db.benchmarkRunRecord.findMany({
      select: { id: true, datasetId: true, modelKey: true, status: true, label: true },
    }),
  ]);

  const warnings: string[] = [];
  const modelById = new Map(models.map((m) => [m.id, m]));
  const datasetById = new Map(datasets.map((d) => [d.id, d]));

  // ---- model references ----
  const modelRefs = new Map<string, DependencyRef[]>();
  const bumpModel = (id: string, ref: DependencyRef) => {
    const list = modelRefs.get(id) ?? [];
    list.push(ref);
    modelRefs.set(id, list);
  };
  for (const job of trainingJobs) {
    if (!job.modelRecordId) continue;
    if (!modelById.has(job.modelRecordId)) {
      warnings.push(`Training job ${job.id} references missing model ${job.modelRecordId} (broken reference — job preserved, reported for integrity).`);
      continue;
    }
    bumpModel(job.modelRecordId, { source: `training job ${job.id}`, kind: 'training' });
  }
  for (const run of benchmarkRuns) {
    // builtin engine keys are not ModelRecords
    if (run.modelKey === CORE_MODULE_NAME || run.modelKey === CORE_MODULE_FALLBACK) continue;
    if (!modelById.has(run.modelKey)) {
      warnings.push(`Benchmark run ${run.id} references missing model ${run.modelKey} (broken reference — run preserved, reported for integrity).`);
      continue;
    }
    bumpModel(run.modelKey, { source: `benchmark run ${run.id}`, kind: 'benchmark' });
  }

  // ---- dataset references ----
  const datasetRefs = new Map<string, DependencyRef[]>();
  const bumpDataset = (id: string, ref: DependencyRef) => {
    const list = datasetRefs.get(id) ?? [];
    list.push(ref);
    datasetRefs.set(id, list);
  };
  for (const job of trainingJobs) {
    if (!job.datasetId) continue;
    if (!datasetById.has(job.datasetId)) {
      warnings.push(`Training job ${job.id} references missing dataset ${job.datasetId} (broken reference — job preserved, reported for integrity).`);
      continue;
    }
    bumpDataset(job.datasetId, { source: `training job ${job.id}`, kind: 'training' });
  }
  for (const run of benchmarkRuns) {
    if (!run.datasetId) continue;
    if (!datasetById.has(run.datasetId)) {
      warnings.push(`Benchmark run ${run.id} references missing dataset ${run.datasetId} (broken reference — run preserved, reported for integrity).`);
      continue;
    }
    bumpDataset(run.datasetId, { source: `benchmark run ${run.id}`, kind: 'benchmark' });
  }

  const modelEntries: ResourceDependencyEntry[] = models.map((m) => {
    let healthy = true;
    try {
      JSON.parse(m.manifest);
    } catch {
      healthy = false;
    }
    const refs = modelRefs.get(m.id) ?? [];
    const reasons: string[] = [
      ...refs.map((r) => `referenced by ${r.source}`),
    ];
    if (m.status === 'active') reasons.push('status is "active" (current model)');
    if (!healthy) reasons.push('manifest is not parseable (broken/incomplete record)');
    // A model is ONLY a candidate when it has zero inbound references AND is
    // not marked active. A healthy-but-unreferenced model stays protected
    // unless cleanup explicitly runs; here we only CLASSIFY (§4.2).
    const protectedResource = refs.length > 0 || m.status === 'active';
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      status: m.status,
      references: refs,
      protectedResource,
      reasons,
      orphaned: !protectedResource,
      healthy,
    };
  });

  const datasetEntries: ResourceDependencyEntry[] = datasets.map((d) => {
    const refs = datasetRefs.get(d.id) ?? [];
    const reasons = refs.map((r) => `referenced by ${r.source}`);
    const protectedResource = refs.length > 0;
    return {
      id: d.id,
      name: d.name,
      version: d.version,
      status: d.format,
      references: refs,
      protectedResource,
      reasons,
      orphaned: !protectedResource,
      healthy: true,
    };
  });

  return {
    models: modelEntries,
    datasets: datasetEntries,
    warnings,
    analyzedAt: new Date().toISOString(),
  };
}

// ---------- cleanup report ----------

export interface RemovedResource {
  id: string;
  name: string;
  version: string;
}

export interface CleanupReport {
  dryRun: boolean;
  ran: boolean;
  models: {
    protected: RemovedResource[];
    candidates: RemovedResource[];
    removed: RemovedResource[];
    failed: { resource: RemovedResource; error: string }[];
  };
  datasets: {
    protected: RemovedResource[];
    candidates: RemovedResource[];
    removed: RemovedResource[];
    failed: { resource: RemovedResource; error: string }[];
  };
  warnings: string[];
  durationMs: number;
  analyzedAt: string;
}

function toResource(e: ResourceDependencyEntry): RemovedResource {
  return { id: e.id, name: e.name, version: e.version };
}

/**
 * §4.7/§5 — delete ONLY confirmed orphaned records. `dryRun: true` (default
 * in the API) produces the §4.8 report without touching anything. The actual
 * deletion removes the DB record only for resources with ZERO inbound
 * references — protected resources are structurally unreachable here. There
 * is no wildcard deletion and no filesystem wipe (model/dataset artifacts
 * live inside their records; user exports in /exports are downloads, not
 * runtime dependencies, and are never touched).
 *
 * IDEMPOTENT (§5): removed resources had no inbound references, so a second
 * run classifies nothing new as orphaned and removes nothing.
 */
export async function runResourceCleanup(dryRun = true): Promise<CleanupReport> {
  const started = Date.now();
  const analysis = await analyzeResourceDependencies();

  const report: CleanupReport = {
    dryRun,
    ran: !dryRun,
    models: { protected: [], candidates: [], removed: [], failed: [] },
    datasets: { protected: [], candidates: [], removed: [], failed: [] },
    warnings: analysis.warnings,
    durationMs: 0,
    analyzedAt: analysis.analyzedAt,
  };

  for (const entry of analysis.models) {
    const r = toResource(entry);
    if (entry.protectedResource) report.models.protected.push(r);
    else report.models.candidates.push(r);
  }
  for (const entry of analysis.datasets) {
    const r = toResource(entry);
    if (entry.protectedResource) report.datasets.protected.push(r);
    else report.datasets.candidates.push(r);
  }

  if (dryRun) {
    report.durationMs = Date.now() - started;
    return report;
  }

  // Actual deletion — per-record try/catch so one failure never aborts the
  // rest and the report describes exactly what happened (§3.7/§4.8).
  for (const entry of analysis.models) {
    if (entry.protectedResource) continue;
    const r = toResource(entry);
    try {
      await db.modelRecord.delete({ where: { id: entry.id } });
      report.models.removed.push(r);
    } catch (err) {
      report.models.failed.push({ resource: r, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const entry of analysis.datasets) {
    if (entry.protectedResource) continue;
    const r = toResource(entry);
    try {
      await db.datasetRecord.delete({ where: { id: entry.id } });
      report.datasets.removed.push(r);
    } catch (err) {
      report.datasets.failed.push({ resource: r, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (report.models.removed.length > 0 || report.datasets.removed.length > 0) {
    void emitEvent({
      type: 'system.maintenance.cleanup',
      source: 'system',
      message: `Resource cleanup removed ${report.models.removed.length} orphaned model(s) and ${report.datasets.removed.length} orphaned dataset(s).`,
      data: {
        removedModels: report.models.removed,
        removedDatasets: report.datasets.removed,
        failed: [...report.models.failed, ...report.datasets.failed],
      },
      priority: 4,
    });
  }

  report.durationMs = Date.now() - started;
  return report;
}

// =====================================================================
// §4.11 — startup/on-demand validation
// =====================================================================

export interface ValidationProblem {
  severity: 'error' | 'warning';
  resource: string;
  message: string;
}

export interface RuntimeValidationReport {
  ok: boolean;
  checkedAt: string;
  activeModel: {
    name: string;
    version: string;
    artifact: string;
    ok: boolean;
  };
  fallbackModel: { name: string; ok: boolean };
  checks: {
    models: number;
    datasets: number;
    trainingJobs: number;
    benchmarkRuns: number;
    manifestParses: number;
  };
  problems: ValidationProblem[];
}

/**
 * §4.11 — validate the runtime's required resources:
 *  - the active model exists (the built-in llm-core engine — code, always
 *    present; reported honestly) and its fallback is configured;
 *  - every registered model manifest parses (artifact metadata integrity);
 *  - required datasets exist and dataset references resolve;
 *  - model references resolve (training jobs, benchmark runs).
 *
 * Reports clear errors — it NEVER creates a replacement model or dataset.
 */
export async function validateRuntimeDependencies(): Promise<RuntimeValidationReport> {
  const [models, datasets, trainingJobs, benchmarkRuns] = await Promise.all([
    db.modelRecord.findMany({ select: { id: true, name: true, manifest: true, status: true } }),
    db.datasetRecord.findMany({ select: { id: true } }),
    db.trainingJobRecord.findMany({ select: { id: true, modelRecordId: true, datasetId: true } }),
    db.benchmarkRunRecord.findMany({ select: { id: true, modelKey: true, datasetId: true } }),
  ]);

  const problems: ValidationProblem[] = [];
  const modelIds = new Set(models.map((m) => m.id));
  const datasetIds = new Set(datasets.map((d) => d.id));
  let manifestParses = 0;

  for (const m of models) {
    try {
      JSON.parse(m.manifest);
      manifestParses += 1;
    } catch {
      problems.push({
        severity: 'error',
        resource: `model ${m.id} (${m.name})`,
        message: 'Manifest/artifact metadata is not parseable — the model record is broken/incomplete.',
      });
    }
  }

  for (const job of trainingJobs) {
    if (job.modelRecordId && !modelIds.has(job.modelRecordId)) {
      problems.push({
        severity: 'warning',
        resource: `training job ${job.id}`,
        message: `References missing model ${job.modelRecordId}.`,
      });
    }
    if (job.datasetId && !datasetIds.has(job.datasetId)) {
      problems.push({
        severity: 'error',
        resource: `training job ${job.id}`,
        message: `References missing dataset ${job.datasetId} — required dataset does not exist.`,
      });
    }
  }

  for (const run of benchmarkRuns) {
    if (run.modelKey !== CORE_MODULE_NAME && run.modelKey !== CORE_MODULE_FALLBACK && !modelIds.has(run.modelKey)) {
      problems.push({
        severity: 'warning',
        resource: `benchmark run ${run.id}`,
        message: `References missing model ${run.modelKey}.`,
      });
    }
    if (run.datasetId && !datasetIds.has(run.datasetId)) {
      problems.push({
        severity: 'error',
        resource: `benchmark run ${run.id}`,
        message: `References missing dataset ${run.datasetId} — required dataset does not exist.`,
      });
    }
  }

  // The active model is the built-in CoreModule decision unit (llm-core).
  // Its "artifact" is the module itself — always present with the runtime.
  const activeModel = {
    name: CORE_MODULE_NAME,
    version: CORE_MODULE_VERSION,
    artifact: 'built-in CoreModule decision unit (in-process)',
    ok: true,
  };
  const fallbackModel = { name: CORE_MODULE_FALLBACK, ok: true };
  // Any registered model marked "active" must still exist as a record (it
  // does by construction here) — a manual DB tamper is covered by the
  // manifest parse + reference checks above.

  return {
    ok: problems.every((p) => p.severity !== 'error'),
    checkedAt: new Date().toISOString(),
    activeModel,
    fallbackModel,
    checks: {
      models: models.length,
      datasets: datasets.length,
      trainingJobs: trainingJobs.length,
      benchmarkRuns: benchmarkRuns.length,
      manifestParses,
    },
    problems,
  };
}
