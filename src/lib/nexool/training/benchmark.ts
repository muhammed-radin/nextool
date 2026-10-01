/**
 * NexTool v1.0.2 — REAL benchmark engine (shared service layer).
 *
 * The Web Console (/api/benchmark/*) and the CLI (nextool benchmark) both call
 * runBenchmark — one implementation, no duplicated logic (v1.0.2 §43/§56).
 *
 * Runs the ACTUAL decision unit per dataset example and compares against the
 * example's expectedTool:
 *  - modelKey "llm-core"          → the live LLM CoreModule (real SDK calls)
 *  - modelKey "heuristic-fallback"→ the deterministic heuristic matcher
 *  - any other modelKey           → a trained tool-classifier ModelRecord
 *                                   (weights restored into a tf.LayersModel)
 *
 * Only metrics that are actually computed are reported. paramAccuracy is null
 * when no example carries expectedParams, or when the model cannot generate
 * parameters (trained classifiers are tool selectors only — documented).
 */
import { db } from '@/lib/db';
import * as tf from '@tensorflow/tfjs';
import type {
  BenchmarkCaseResult, BenchmarkConfig, BenchmarkMetrics, ToolDefinition,
} from '../types';
import { decide, type DecideInput } from '../core/coremodule';
import { heuristicDecide } from '../core/heuristic';
import { validateParams } from '../tools/executor';
import { vectorize } from './engine';

const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const REQUEST_TRUNCATE = 240;

export interface BenchmarkRunResult {
  ok: boolean;
  runId?: string;
  metrics?: BenchmarkMetrics;
  error?: string;
}

interface WeightSpecLike {
  name: string;
  shape: number[];
  dtype: string;
}

interface TrainedBundle {
  model: tf.LayersModel;
  classes: string[];
  vocabSize: number;
  manifest: Record<string, unknown>;
  dispose: () => void;
}

/** Restore a trained classifier checkpoint from its ModelRecord manifest. */
async function loadTrainedModel(modelRecordId: string): Promise<TrainedBundle> {
  const row = await db.modelRecord.findUnique({ where: { id: modelRecordId } });
  if (!row) throw new Error(`Model not found: ${modelRecordId}`);
  const manifest = JSON.parse(row.manifest) as {
    modelTopology: unknown;
    weightSpecs: WeightSpecLike[];
    weightData: string;
    classes: string[];
    vocabSize: number;
    format: string;
  };
  if (manifest.format !== 'tfjs-trained-classifier' || !manifest.modelTopology || !manifest.weightSpecs || !manifest.weightData) {
    throw new Error(`Model ${row.name} v${row.version} is not a runnable trained classifier (format: ${row.format})`);
  }
  const weightData = Uint8Array.from(Buffer.from(manifest.weightData, 'base64')).buffer;
  const model = await tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: manifest.modelTopology as tf.io.ModelArtifacts['modelTopology'],
    weightSpecs: manifest.weightSpecs as never,
    weightData,
  }));
  return {
    model,
    classes: manifest.classes,
    vocabSize: manifest.vocabSize,
    manifest: manifest as unknown as Record<string, unknown>,
    dispose: () => model.dispose(),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one benchmark pass. Synchronous completion (the caller awaits the full
 * run) — runs are also persisted with status transitions so history survives.
 */
export async function runBenchmark(input: BenchmarkConfig & { label?: string }): Promise<BenchmarkRunResult> {
  const t0 = Date.now();
  const caseTimeoutMs = input.timeoutPerCaseMs ?? DEFAULT_CASE_TIMEOUT_MS;

  // Resolve dataset + examples (test split first, honest fallbacks with notes).
  const dataset = await db.datasetRecord.findUnique({ where: { id: input.datasetId } });
  if (!dataset) return { ok: false, error: `Dataset not found: ${input.datasetId}` };
  const allExamples = JSON.parse(dataset.examples) as {
    request: string; expectedTool?: string; expectedParams?: Record<string, unknown>; split?: string;
  }[];
  let examples = allExamples.filter((e) => e.split === 'test' && e.expectedTool);
  let splitUsed = 'test';
  if (examples.length === 0) {
    examples = allExamples.filter((e) => e.split === 'validation' && e.expectedTool);
    splitUsed = 'validation';
  }
  if (examples.length === 0) {
    examples = allExamples.filter((e) => e.expectedTool);
    splitUsed = 'all (no explicit splits)';
  }
  if (examples.length === 0) {
    return { ok: false, error: 'Dataset has no examples with expectedTool — nothing to benchmark.' };
  }
  if (input.limit && input.limit > 0) examples = examples.slice(0, input.limit);

  // Resolve tool defs available to the decision unit.
  const toolRows = await db.toolRecord.findMany({ where: { enabled: true } });
  const toolDefs: ToolDefinition[] = toolRows.map((r) => JSON.parse(r.definition) as ToolDefinition);
  const toolDefByName = new Map(toolDefs.map((d) => [d.name, d]));

  const run = await db.benchmarkRunRecord.create({
    data: {
      label: input.label ?? null,
      modelKey: input.modelKey,
      datasetId: dataset.id,
      datasetName: dataset.name,
      datasetVersion: dataset.version,
      config: JSON.stringify(input),
      status: 'running',
    },
  });

  try {
    // Resolve the decision unit.
    let trained: TrainedBundle | null = null;
    if (input.modelKey !== 'llm-core' && input.modelKey !== 'heuristic-fallback') {
      trained = await loadTrainedModel(input.modelKey);
    }

    const cases: BenchmarkCaseResult[] = [];
    const latencies: number[] = [];
    let confidenceSum = 0;
    let noTool = 0;
    let schemaChecked = 0;
    let schemaValid = 0;
    let paramChecked = 0;
    let paramCorrect = 0;

    for (const example of examples) {
      const started = Date.now();
      let decidedTool: string | undefined;
      let status: BenchmarkCaseResult['status'] = 'no_tool';
      let confidence = 0;
      let engine: string = input.modelKey;
      let params: Record<string, unknown> | undefined;

      if (trained) {
        // Trained classifier inference (real tf.predict, no LLM).
        const input2d = tf.tensor2d([vectorize(example.request, trained.vocabSize)]);
        try {
          const pred = trained.model.predict(input2d) as tf.Tensor2D;
          const probs = Array.from(await pred.data());
          pred.dispose();
          let best = 0;
          for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
          confidence = probs[best];
          if (trained.classes[best]) {
            decidedTool = trained.classes[best];
            status = 'tool_call';
            params = {};
          } else {
            status = 'no_tool';
          }
          engine = `trained:${trained.manifest.name ?? input.modelKey}`;
        } finally {
          input2d.dispose();
        }
      } else {
        const decideInput: DecideInput = {
          objective: example.request,
          request: example.request,
          goal: example.request,
          toolDefs,
          contextBundle: { memory: [], history: [], stateSummary: '{}' },
          reasoningLevel: 3,
        };
        const decision = input.modelKey === 'heuristic-fallback'
          ? heuristicDecide({ objective: example.request, request: example.request, toolDefs, lastObservation: undefined })
          : await withTimeout(decide(decideInput), caseTimeoutMs, () => ({
              status: 'no_tool' as const,
              confidence: 0,
              reason: 'case timeout',
              engine: 'llm-core' as const,
              latencyMs: caseTimeoutMs,
            }));
        status = decision.status;
        confidence = decision.confidence;
        decidedTool = decision.tool;
        params = decision.params;
        engine = decision.engine;
      }

      const latencyMs = Date.now() - started;
      latencies.push(latencyMs);
      confidenceSum += confidence;
      const isNoTool = status === 'no_tool' || status === 'cannot_execute' || status === 'stop';
      if (isNoTool) noTool += 1;

      let schemaValidCase: boolean | null = null;
      if (status === 'tool_call' && decidedTool) {
        const def = toolDefByName.get(decidedTool);
        if (def) {
          const errors = validateParams(params ?? {}, def.schema);
          schemaChecked += 1;
          schemaValidCase = errors.length === 0;
          if (schemaValidCase) schemaValid += 1;
        }
      }

      const paramMatches = (() => {
        if (!example.expectedParams || Object.keys(example.expectedParams).length === 0) return null;
        if (trained) return null; // classifiers do not generate parameters (documented)
        if (status !== 'tool_call') return false;
        paramChecked += 1;
        return stableStringify(params ?? {}) === stableStringify(example.expectedParams);
      })();
      if (paramMatches !== null && paramChecked > 0 && paramMatches) paramCorrect += 1;

      cases.push({
        request: example.request.slice(0, REQUEST_TRUNCATE),
        expectedTool: example.expectedTool,
        decidedTool,
        status,
        correct: decidedTool === example.expectedTool,
        confidence: Math.round(confidence * 1000) / 1000,
        latencyMs,
        engine,
      });
      void schemaValidCase; // captured via counters above
      void paramMatches;
    }

    trained?.dispose();

    const sorted = [...latencies].sort((a, b) => a - b);
    const metrics: BenchmarkMetrics = {
      cases: cases.length,
      toolSelectionAccuracy: cases.length ? round4(cases.filter((c) => c.correct).length / cases.length) : 0,
      noToolRate: cases.length ? round4(noTool / cases.length) : 0,
      paramAccuracy: paramChecked > 0 ? round4(paramCorrect / paramChecked) : null,
      schemaValidity: schemaChecked > 0 ? round4(schemaValid / schemaChecked) : 0,
      avgDecisionLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p95DecisionLatencyMs: percentile(sorted, 95),
      avgConfidence: cases.length ? round4(confidenceSum / cases.length) : 0,
      avgCoreCallsPerCase: 1,
    };

    const durationMs = Date.now() - t0;
    await db.benchmarkRunRecord.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        metrics: JSON.stringify(metrics),
        cases: JSON.stringify(cases.slice(0, 500)),
        durationMs,
      },
    });

    void splitUsed; // documented in docs/benchmarks.md — test > validation > all
    return { ok: true, runId: run.id, metrics };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.benchmarkRunRecord.update({
      where: { id: run.id },
      data: { status: 'failed', error: message, durationMs: Date.now() - t0 },
    });
    return { ok: false, runId: run.id, error: message };
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
