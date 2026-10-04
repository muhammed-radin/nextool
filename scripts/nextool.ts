#!/usr/bin/env bun
/**
 * NexTool Q1 v1.0.3 — Command Line Interface (spec §49-56).
 *
 * The CLI operates on the SAME service layer as the Web Console:
 *   CLI ─────────┐
 *                ├── NexTool services (registry, training engine, benchmark
 *   Web Console ─┘    engine, model packaging, datasets) → Prisma/SQLite
 *
 * There is exactly ONE implementation of training / benchmarking / packaging —
 * these commands import it directly. Run with: bun run cli -- <command>
 */

import { Command } from 'commander';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/lib/db';
import { APP_NAME, APP_VERSION, CORE_MODULE_VERSION } from '../src/lib/nexool/version';
import { listTools, getToolEntry, testJsToolSource } from '../src/lib/nexool/tools/registry';
import { executeTool } from '../src/lib/nexool/tools/executor';
import { resolveTrainingConfig, runTrainingJob } from '../src/lib/nexool/training/engine';
import { runBenchmark } from '../src/lib/nexool/training/benchmark';
import { exportModel, importModelPackage, type ExportFormat } from '../src/lib/nexool/training/model-package';
import { decodeParquetDataset, encodeParquetDataset } from '../src/lib/nexool/datasets/parquet';
import { validateRuntimeDependencies, runResourceCleanup, resetApplicationRuntime } from '../src/lib/nexool/maintenance';
import type { TrainingLogLine } from '../src/lib/nexool/types';

const program = new Command();

program
  .name('nextool')
  .description(`${APP_NAME} v${APP_VERSION} — operations CLI (shares every service with the web console)`)
  .version(APP_VERSION, '-V, --app-version', 'print the NexTool application version');

// ---------- helpers ----------

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function asJson(option: boolean, value: unknown): void {
  if (option) console.log(JSON.stringify(value, null, 2));
}

interface DatasetRow { id: string; name: string; version: string; format: string; trainSize: number; valSize: number; testSize: number; examples: string; categories: string | null; note: string | null; createdAt: Date }

async function resolveDataset(ref: string, version?: string): Promise<DatasetRow> {
  const byId = await db.datasetRecord.findUnique({ where: { id: ref } });
  if (byId && (!version || byId.version === version)) return byId;
  const rows = await db.datasetRecord.findMany({ where: { name: ref }, orderBy: { createdAt: 'desc' } });
  const match = version ? rows.find((r) => r.version === version) : rows[0];
  if (!match) fail(`dataset not found: ${ref}${version ? ` (version ${version})` : ''} — import one with "nextool dataset import" first`);
  return match;
}

async function resolveModel(ref: string): Promise<{ id: string; name: string; version: string; format: string; status: string; note: string | null; manifest: string }> {
  if (ref === 'current' || ref === 'latest') {
    const latest = await db.modelRecord.findFirst({
      where: { format: { in: ['tfjs-trained-classifier', 'tfjs-native-import'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) fail('no exportable model packages registered — train one with "nextool train"');
    return latest;
  }
  const byId = await db.modelRecord.findUnique({ where: { id: ref } });
  if (byId) return byId;
  const rows = await db.modelRecord.findMany({ where: { name: ref }, orderBy: { createdAt: 'desc' } });
  const match = rows[0];
  if (!match) fail(`model not found: ${ref} — see "nextool model list"`);
  return match;
}

function printLogs(logs: TrainingLogLine[]): void {
  for (const l of logs) {
    const tag = l.level === 'error' ? 'x' : l.level === 'warn' ? '!' : '·';
    console.log(`  ${tag} ${l.message}`);
  }
}

// ---------- train ----------

program
  .command('train')
  .description('train a tool-selection classifier on a dataset (real TensorFlow.js run)')
  .requiredOption('-d, --dataset <ref>', 'dataset id or name')
  .option('--dataset-version <version>', 'disambiguate dataset by version')
  .option('-e, --epochs <n>', 'epochs (1-100, default 20)')
  .option('-b, --batch-size <n>', 'batch size (1-128, default 8)')
  .option('-l, --learning-rate <x>', 'learning rate (default 0.01)')
  .option('-v, --val-split <x>', 'validation split fraction 0..0.5 (default 0.2)')
  .option('--no-shuffle', 'disable shuffling')
  .option('--early-stop <n>', 'early stopping patience on val_loss (0 = off, default 0)')
  .action(async (opts: { dataset: string; datasetVersion?: string; epochs?: string; batchSize?: string; learningRate?: string; valSplit?: string; shuffle?: boolean; earlyStop?: string }) => {
    const dataset = await resolveDataset(opts.dataset, opts.datasetVersion);
    const config = resolveTrainingConfig({
      epochs: opts.epochs ? Number(opts.epochs) : undefined,
      batchSize: opts.batchSize ? Number(opts.batchSize) : undefined,
      learningRate: opts.learningRate ? Number(opts.learningRate) : undefined,
      validationSplit: opts.valSplit ? Number(opts.valSplit) : undefined,
      shuffle: opts.shuffle,
      earlyStoppingPatience: opts.earlyStop !== undefined ? Number(opts.earlyStop) : undefined,
    });

    console.log(`> dataset: ${dataset.name} v${dataset.version} (${dataset.id.slice(0, 8)})`);
    console.log(`> config: epochs=${config.epochs} batch=${config.batchSize} lr=${config.learningRate} valSplit=${config.validationSplit} shuffle=${config.shuffle}${config.earlyStoppingPatience ? ` earlyStop=${config.earlyStoppingPatience}` : ''}`);

    const job = await db.trainingJobRecord.create({
      data: {
        datasetId: dataset.id,
        datasetName: dataset.name,
        datasetVersion: dataset.version,
        status: 'queued',
        config: JSON.stringify(config),
        epochs: config.epochs,
      },
    });

    const result = await runTrainingJob({ jobId: job.id, datasetId: dataset.id, config });
    const detail = await db.trainingJobRecord.findUnique({ where: { id: job.id } });
    const logs = detail ? (JSON.parse(detail.logs) as TrainingLogLine[]) : [];
    printLogs(logs);

    if (!result.ok) fail(`training failed: ${result.error ?? 'unknown error'}`);

    console.log('');
    console.log(`[ok] training completed — model "${result.modelVersion}" registered (${result.modelRecordId?.slice(0, 8)})`);
    if (result.finalMetrics) {
      console.log(`  loss ${result.finalMetrics.loss}${result.finalMetrics.valLoss !== null ? ` (val ${result.finalMetrics.valLoss})` : ''} · accuracy ${result.finalMetrics.accuracy}${result.finalMetrics.valAccuracy !== null ? ` (val ${result.finalMetrics.valAccuracy})` : ''} · ${result.finalMetrics.trainMs}ms`);
    }
    console.log('  export with: nextool model export --model current --format tfjs --output ./exports/model.zip');
    process.exit(0);
  });

// ---------- benchmark ----------

program
  .command('benchmark')
  .description('benchmark a decision unit (llm-core, heuristic-fallback or a trained model) against a dataset')
  .requiredOption('-d, --dataset <ref>', 'dataset id or name')
  .option('--dataset-version <version>', 'disambiguate dataset by version')
  .option('-m, --model <key>', '"llm-core", "heuristic-fallback" or a trained model id (default: heuristic-fallback)', 'heuristic-fallback')
  .option('--limit <n>', 'max test cases (default all labeled examples)')
  .option('--timeout <ms>', 'per-case timeout for llm-core (default 30000)')
  .option('--label <text>', 'label for the run history')
  .action(async (opts: { dataset: string; datasetVersion?: string; model: string; limit?: string; timeout?: string; label?: string }) => {
    const dataset = await resolveDataset(opts.dataset, opts.datasetVersion);
    console.log(`> benchmark: ${opts.model} x ${dataset.name} v${dataset.version}`);
    if (opts.model === 'llm-core') console.log('  (real LLM decisions — this can take a while)');

    const result = await runBenchmark({
      modelKey: opts.model,
      datasetId: dataset.id,
      suite: 'tool-selection',
      limit: opts.limit ? Number(opts.limit) : undefined,
      timeoutPerCaseMs: opts.timeout ? Number(opts.timeout) : undefined,
      label: opts.label,
    });
    if (!result.ok || !result.metrics) fail(`benchmark failed: ${result.error ?? 'unknown error'}`);
    const m = result.metrics;
    const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`);
    console.log('');
    console.log(`[ok] benchmark completed (${result.runId?.slice(0, 8)}) over ${m.cases} cases`);
    console.log(`  tool selection accuracy : ${pct(m.toolSelectionAccuracy)}`);
    console.log(`  schema validity         : ${pct(m.schemaValidity)}`);
    console.log(`  param accuracy          : ${pct(m.paramAccuracy)}${m.paramAccuracy === null ? ' (no expectedParams)' : ''}`);
    console.log(`  no-tool rate            : ${pct(m.noToolRate)}`);
    console.log(`  avg / p95 latency       : ${m.avgDecisionLatencyMs}ms / ${m.p95DecisionLatencyMs}ms`);
    console.log(`  avg confidence          : ${m.avgConfidence}`);
    process.exit(0);
  });

// ---------- model ----------

const modelCmd = program.command('model').description('model package operations (export / import / list / info)');

modelCmd
  .command('export')
  .description('export a model package as a zip (native tfjs or .nextool)')
  .requiredOption('-m, --model <ref>', 'model id or name ("current" = latest exportable)')
  .requiredOption('-f, --format <format>', 'tfjs | nextool')
  .requiredOption('-o, --output <path>', 'output file path (e.g. ./exports/model.zip)')
  .action(async (opts: { model: string; format: string; output: string }) => {
    if (opts.format !== 'tfjs' && opts.format !== 'nextool') fail('--format must be "tfjs" or "nextool"');
    const rec = await resolveModel(opts.model);
    const result = await exportModel(rec.id, opts.format as ExportFormat);
    mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    writeFileSync(opts.output, result.bytes);
    console.log(`[ok] exported ${rec.name} v${rec.version} -> ${opts.output} (${result.bytes.byteLength} bytes)`);
    process.exit(0);
  });

modelCmd
  .command('import <file>')
  .description('import a .nextool / tfjs zip / bare manifest and register it')
  .action(async (file: string) => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(file));
    } catch {
      fail(`cannot read file: ${file}`);
    }
    const result = await importModelPackage(path.basename(file), bytes);
    console.log(`[ok] imported ${result.name} v${result.version} (format ${result.format}, id ${result.modelRecordId.slice(0, 8)})`);
    if (result.metadata) {
      console.log(`  architecture ${result.metadata.architecture} · ${result.metadata.parameterCount} params · tfjs ${result.metadata.tfjsCompatibility}`);
    }
    for (const w of result.warnings) console.log(`  ! ${w}`);
    process.exit(0);
  });

modelCmd
  .command('list')
  .description('list registered model packages')
  .option('--json', 'output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const rows = await db.modelRecord.findMany({ orderBy: { createdAt: 'desc' } });
    if (opts.json) asJson(true, rows.map((r) => ({ id: r.id, name: r.name, version: r.version, format: r.format, status: r.status, createdAt: r.createdAt })));
    else {
      if (rows.length === 0) console.log('no model packages registered');
      for (const r of rows) {
        console.log(`${r.id.slice(0, 8)}  ${r.name} v${r.version}  ${r.format}  ${r.status}${r.note ? ` — ${r.note}` : ''}`);
      }
    }
    process.exit(0);
  });

modelCmd
  .command('info <ref>')
  .description('show details for one model package')
  .action(async (ref: string) => {
    const rec = await resolveModel(ref);
    const manifest = JSON.parse(rec.manifest) as Record<string, unknown>;
    console.log(`${rec.name} v${rec.version} [${rec.format}] (${rec.status})`);
    for (const key of ['architecture', 'parameterCount', 'datasetVersion', 'tfjsCompatibility', 'trainedAt', 'classes', 'vocabSize']) {
      if (manifest[key] !== undefined) console.log(`  ${key}: ${JSON.stringify(manifest[key])}`);
    }
    if (manifest.finalMetrics) console.log(`  finalMetrics: ${JSON.stringify(manifest.finalMetrics)}`);
    if (rec.note) console.log(`  note: ${rec.note}`);
    process.exit(0);
  });

// ---------- dataset ----------

const datasetCmd = program.command('dataset').description('dataset operations (import / export / list / info)');

datasetCmd
  .command('import <file>')
  .description('import a dataset file: .json ({ name, version, examples[] } or a bare examples array) or .parquet (decoded by the real Parquet adapter, v1.0.3)')
  .requiredOption('-n, --name <name>', 'dataset name')
  .requiredOption('-v, --version <version>', 'dataset version')
  .option('--note <text>', 'note')
  .action(async (file: string, opts: { name: string; version: string; note?: string }) => {
    const lower = file.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.parquet')) {
      fail('unsupported file type — use .json or .parquet');
    }
    let examples: { category?: string; request: string; expectedTool?: string; expectedParams?: Record<string, unknown>; split?: string }[] | undefined;
    if (lower.endsWith('.parquet')) {
      // v1.0.3: real Parquet import via the shared adapter (@dsnp/parquetjs).
      try {
        examples = await decodeParquetDataset(readFileSync(file));
      } catch (err) {
        fail(`parquet decode failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        fail(`cannot parse JSON file: ${file}`);
      }
      examples = (Array.isArray(parsed) ? parsed : (parsed as { examples?: unknown }).examples) as
        | { category?: string; request: string; expectedTool?: string; expectedParams?: Record<string, unknown>; split?: string }[]
        | undefined;
    }
    if (!Array.isArray(examples) || examples.length === 0) fail(lower.endsWith('.parquet') ? 'parquet file contains no usable rows' : 'file must contain { examples: [...] } or a bare array of examples');

    const counts = { train: 0, validation: 0, test: 0, unlabeled: 0 };
    for (const e of examples) {
      if (e.split === 'train') counts.train += 1;
      else if (e.split === 'validation') counts.validation += 1;
      else if (e.split === 'test') counts.test += 1;
      else counts.unlabeled += 1;
    }
    const categories = [...new Set(examples.map((e) => e.category ?? 'general').filter(Boolean))];
    const row = await db.datasetRecord.create({
      data: {
        name: opts.name,
        version: opts.version,
        format: lower.endsWith('.parquet') ? 'parquet' : 'json',
        trainSize: counts.train,
        valSize: counts.validation,
        testSize: counts.test,
        examples: JSON.stringify(examples),
        categories: JSON.stringify(categories),
        note: opts.note ?? `${counts.unlabeled} example(s) without explicit split`,
      },
    });
    console.log(`[ok] dataset ${opts.name} v${opts.version} imported (${row.id.slice(0, 8)}) — train ${counts.train} · val ${counts.validation} · test ${counts.test}${counts.unlabeled ? ` · unsplit ${counts.unlabeled}` : ''}`);
    process.exit(0);
  });

datasetCmd
  .command('export <ref>')
  .description('export a dataset as JSON (default) or binary Parquet (v1.0.3)')
  .option('-o, --output <path>', 'output file path (prints to stdout when omitted; required for --format parquet)')
  .option('--format <format>', 'export format: json | parquet', 'json')
  .option('--dataset-version <version>', 'disambiguate by version')
  .action(async (ref: string, opts: { output?: string; format?: string; datasetVersion?: string }) => {
    const dataset = await resolveDataset(ref, opts.datasetVersion);
    const format = (opts.format ?? 'json').toLowerCase();
    if (format !== 'json' && format !== 'parquet') fail('unsupported format — use json or parquet');
    const examples = JSON.parse(dataset.examples) as { category: string; request: string; expectedTool?: string; expectedParams?: Record<string, unknown>; split?: string }[];

    if (format === 'parquet') {
      if (!opts.output) fail('--output is required for parquet export (binary file)');
      const typed = examples.map((e) => ({ ...e, split: e.split as 'train' | 'validation' | 'test' | undefined }));
      const bytes = await encodeParquetDataset(typed);
      mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
      writeFileSync(opts.output, bytes);
      console.log(`[ok] exported ${dataset.name} v${dataset.version} -> ${opts.output} (parquet, ${bytes.byteLength} bytes)`);
      process.exit(0);
    }

    const payload = {
      dataset: { id: dataset.id, name: dataset.name, version: dataset.version, format: dataset.format },
      examples,
    };
    const text = JSON.stringify(payload, null, 2);
    if (opts.output) {
      mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
      writeFileSync(opts.output, text);
      console.log(`[ok] exported ${dataset.name} v${dataset.version} -> ${opts.output}`);
    } else {
      console.log(text);
    }
    process.exit(0);
  });

datasetCmd
  .command('list')
  .description('list imported datasets')
  .option('--json', 'output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const rows = await db.datasetRecord.findMany({ orderBy: { createdAt: 'desc' } });
    if (opts.json) asJson(true, rows.map((r) => ({ id: r.id, name: r.name, version: r.version, format: r.format, trainSize: r.trainSize, valSize: r.valSize, testSize: r.testSize })));
    else {
      if (rows.length === 0) console.log('no datasets imported');
      for (const r of rows) {
        console.log(`${r.id.slice(0, 8)}  ${r.name} v${r.version}  ${r.format}  train ${r.trainSize} · val ${r.valSize} · test ${r.testSize}`);
      }
    }
    process.exit(0);
  });

datasetCmd
  .command('info <ref>')
  .description('show details for one dataset')
  .action(async (ref: string) => {
    const r = await resolveDataset(ref);
    console.log(`${r.name} v${r.version} [${r.format}]`);
    console.log(`  train ${r.trainSize} · val ${r.valSize} · test ${r.testSize}`);
    if (r.categories) console.log(`  categories: ${(JSON.parse(r.categories) as string[]).join(', ')}`);
    if (r.note) console.log(`  note: ${r.note}`);
    process.exit(0);
  });

// ---------- tool ----------

const toolCmd = program.command('tool').description('tool registry operations (list / test)');

toolCmd
  .command('list')
  .description('list registered tools')
  .option('--json', 'output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const tools = await listTools();
    if (opts.json) asJson(true, tools.map((t) => ({ name: t.name, environment: t.environment, category: t.category, enabled: t.enabled, calls: t.stats.callCount })));
    else {
      for (const t of tools) {
        console.log(`${t.enabled ? '✓' : '·'} ${t.name.padEnd(24)} ${t.environment.padEnd(12)} calls=${t.stats.callCount} avg=${Math.round(t.stats.avgMs)}ms`);
      }
    }
    process.exit(0);
  });

toolCmd
  .command('test <name>')
  .description('execute a tool in the controlled test context')
  .option('-p, --params <json>', 'params as JSON (default {})', '{}')
  .option('-t, --timeout <ms>', 'v1.0.7 §1 — effective execution timeout in ms (default 10000, max 3600000)')
  .action(async (name: string, opts: { params: string; timeout?: string }) => {
    const entry = await getToolEntry(name);
    if (!entry) fail(`tool not found: ${name}`);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(opts.params);
    } catch {
      fail('--params must be valid JSON');
    }
    // v1.0.7 §1 — configurable timeout (default 10 s, hard cap 1 hour).
    let timeoutMs: number | undefined;
    if (opts.timeout !== undefined) {
      const n = Number(opts.timeout);
      if (!Number.isFinite(n) || n <= 0) fail('--timeout must be a positive number of milliseconds');
      timeoutMs = Math.min(Math.round(n), 3_600_000);
    }
    console.log(`> testing ${name} (mode: test, timeout: ${timeoutMs ?? 10_000}ms)`);
    const started = Date.now();

    if (entry.environment === 'js-function' && typeof entry.functionSource === 'string') {
      const run = await testJsToolSource(entry.functionSource, params, { timeoutMs });
      if (run.logs.length) console.log('logs:');
      for (const line of run.logs) console.log(`  · ${line}`);
      if (!run.ok) fail(`${run.error?.code}: ${run.error?.message}`);
      console.log(`[ok] completed in ${Date.now() - started}ms`);
      console.log(JSON.stringify(run.result, null, 2));
    } else {
      const execution = await executeTool(name, params, { timeoutMs: timeoutMs ?? 20_000 });
      if (execution.status !== 'completed') {
        fail(`${execution.status}: ${execution.error?.code} ${execution.error?.message}`);
      }
      console.log(`[ok] completed in ${execution.durationMs}ms`);
      console.log(JSON.stringify(execution.result, null, 2));
    }
    process.exit(0);
  });

// ---------- maintenance (v1.0.7 §3/§4/§5) ----------

const maintenanceCmd = program.command('maintenance').description('maintenance operations (validate / cleanup / reset)');

maintenanceCmd
  .command('validate')
  .description('validate runtime dependencies: active model, artifacts, required datasets, reference integrity')
  .option('--json', 'output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const report = await validateRuntimeDependencies();
    if (opts.json) asJson(true, report);
    console.log(`active model : ${report.activeModel.name} v${report.activeModel.version} (${report.activeModel.ok ? 'ok' : 'MISSING'})`);
    console.log(`fallback     : ${report.fallbackModel.name} (${report.fallbackModel.ok ? 'ok' : 'MISSING'})`);
    console.log(`resources    : ${report.checks.models} models · ${report.checks.datasets} datasets · ${report.checks.trainingJobs} training jobs · ${report.checks.benchmarkRuns} benchmark runs`);
    if (report.problems.length === 0) {
      console.log('[ok] all references resolve; no problems found');
    } else {
      for (const p of report.problems) console.log(`${p.severity === 'error' ? 'x' : '!'} ${p.resource}: ${p.message}`);
    }
    process.exit(report.ok ? 0 : 1);
  });

maintenanceCmd
  .command('cleanup')
  .description('remove ONLY confirmed orphaned models/datasets (dependency analysis first; idempotent)')
  .option('--apply', 'actually delete confirmed orphans (default: dry-run report only)')
  .option('--json', 'output raw JSON')
  .action(async (opts: { apply?: boolean; json?: boolean }) => {
    const report = await runResourceCleanup(!opts.apply);
    if (opts.json) asJson(true, report);
    console.log(`${opts.apply ? 'cleanup' : 'dry-run'} — protected models: ${report.models.protected.length} · orphaned candidates: ${report.models.candidates.length} · removed: ${report.models.removed.length}`);
    for (const r of report.models.removed) console.log(`  ✗ removed model: ${r.name} v${r.version}`);
    console.log(`${opts.apply ? 'cleanup' : 'dry-run'} — protected datasets: ${report.datasets.protected.length} · orphaned candidates: ${report.datasets.candidates.length} · removed: ${report.datasets.removed.length}`);
    for (const r of report.datasets.removed) console.log(`  ✗ removed dataset: ${r.name} v${r.version}`);
    for (const w of report.warnings) console.log(`  ! ${w}`);
    if (!opts.apply) console.log('(dry-run only — pass --apply to delete the confirmed orphans)');
    process.exit(0);
  });

maintenanceCmd
  .command('reset')
  .description('DANGEROUS: reset application runtime data (tasks, events, history, memory, statistics)')
  .option('--confirm <phrase>', 'must be exactly RESET — the typed confirmation phrase (§3.3)')
  .option('--json', 'output raw JSON')
  .action(async (opts: { confirm?: string; json?: boolean }) => {
    if (opts.confirm !== 'RESET') {
      fail('confirmation required — run with --confirm RESET (this clears runtime data; tools/models/datasets are preserved)');
    }
    const report = await resetApplicationRuntime(opts.confirm);
    if (opts.json) asJson(true, report);
    if (!report.ok) fail(report.failures.join('; ') || 'reset failed');
    console.log(`[ok] runtime data reset in ${report.durationMs}ms`);
    for (const [k, v] of Object.entries(report.cleared)) console.log(`  cleared ${k}: ${v}`);
    console.log('  protected: tools, models, datasets, training artifacts, settings');
    process.exit(0);
  });

// ---------- runtime ----------

const runtimeCmd = program.command('runtime').description('runtime operations (status / start)');

runtimeCmd
  .command('status')
  .description('check whether the NexTool runtime (web console API) is reachable')
  .option('--json', 'output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const url = process.env.NEXOOL_RUNTIME_URL ?? 'http://127.0.0.1:3000/api/system';
    interface SystemPayload {
      runtimeStatus?: string;
      appVersion?: string;
      engine?: { active?: string; version?: string };
      tasks?: { active?: number };
    }
    let payload: SystemPayload | null = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      payload = res.ok ? ((await res.json()) as { data?: SystemPayload }).data ?? null : null;
    } catch {
      payload = null;
    }
    if (opts.json) asJson(true, { reachable: !!payload, runtime: payload });
    if (!payload) {
      console.log('x runtime unreachable — start it with "nextool runtime start" (or bun run dev)');
    } else {
      console.log(`[ok] runtime online — app v${payload.appVersion ?? '?'} · engine ${payload.engine?.active ?? '?'} v${payload.engine?.version ?? '?'} · active tasks ${payload.tasks?.active ?? 0}`);
    }
    process.exit(0);
  });

runtimeCmd
  .command('start')
  .description('start the Next.js runtime (dev server) as a background process')
  .action(async () => {
    const already = await fetch('http://127.0.0.1:3000/api/system', { signal: AbortSignal.timeout(1200) }).then((r) => r.ok).catch(() => false);
    if (already) {
      console.log('runtime already running on http://127.0.0.1:3000');
      process.exit(0);
    }
    const child = spawn('bun', ['run', 'dev'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      stdio: 'ignore',
      detached: true,
    });
    (child as ChildProcess).unref();
    console.log(`[ok] runtime starting (pid ${child.pid}) — logs stream to dev.log; verify with "nextool runtime status"`);
    process.exit(0);
  });

// ---------- config (v1.0.8) ----------

const configCmd = program.command('config').description('configuration-limit operations (limits / validate)');

configCmd
  .command('limits')
  .description('print the resolved configuration limits (from config/configuration-limits.json)')
  .option('--json', 'output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const { getConfigurationLimits, getResolvedLimits } = await import('../src/lib/nexool/config-limits');
    const raw = getConfigurationLimits();
    const resolved = getResolvedLimits();
    if (opts.json) asJson(true, { version: raw.version, resolved, source: 'config/configuration-limits.json' });
    console.log(`[ok] configuration limits v${raw.version} (config/configuration-limits.json)`);
    for (const [section, entries] of Object.entries(resolved)) {
      console.log(`  ${section}:`);
      for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
        console.log(`    ${k} = ${String(v)}`);
      }
    }
    process.exit(0);
  });

configCmd
  .command('validate')
  .description('validate config/configuration-limits.json (schema, types, min <= default <= max)')
  .action(async () => {
    const { getConfigurationLimits } = await import('../src/lib/nexool/config-limits');
    try {
      const raw = getConfigurationLimits();
      console.log(`[ok] configuration-limits.json is valid (version ${raw.version})`);
      process.exit(0);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'configuration-limits.json is invalid');
    }
  });

// ---------- meta ----------

program
  .command('version')
  .description('print version concepts (application / CoreModule model / dataset)')
  .action(async () => {
    const ds = await db.datasetRecord.findFirst({ orderBy: { updatedAt: 'desc' } });
    console.log(`${APP_NAME}`);
    console.log(`  application version : ${APP_VERSION}`);
    console.log(`  model version       : ${CORE_MODULE_VERSION} (llm-core decision unit)`);
    console.log(`  dataset version     : ${ds ? `${ds.version} (${ds.name})` : '- none imported'}`);
    process.exit(0);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
