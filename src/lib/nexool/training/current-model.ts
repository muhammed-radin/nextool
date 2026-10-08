/**
 * NexTool v1.0.15 — CURRENT MODEL registry + runtime classifier bridge.
 *
 * v1.0.14 and earlier had NO current-model pointer: ModelRecord.status
 * allowed 'active' but nothing ever wrote it, and the trained tfjs
 * classifiers were benchmark-only. v1.0.15 closes that gap:
 *
 *  - markModelCurrent(modelId)  — the explicit registry write (demotes every
 *    other active model, promotes exactly one). Called when a training job
 *    completes and by release tooling.
 *  - getActiveTrainedModel()    — the registry read.
 *  - getRuntimeClassifier()     — cached loader that turns the active
 *    checkpoint into a request → tool suggester for the DECISION RUNTIME.
 *    CoreModule consults it as (a) a hint inside the LLM prompt and (b) the
 *    first fallback when the LLM call fails — so the trained v1.0.4 model
 *    genuinely improves live tool selection instead of only benchmarks.
 *
 * The suggester caches ONE tf.LayersModel keyed by model id; a registry
 * change (new active model) invalidates it automatically.
 */
import { db } from '@/lib/db';
import * as tf from '@tensorflow/tfjs';
import { vectorize } from './engine';

export interface ActiveModelInfo {
  id: string;
  name: string;
  version: string;
  format: string;
  classes: string[];
  vocabSize: number;
  parameterCount: number | null;
  datasetVersion: string | null;
  finalMetrics: Record<string, unknown> | null;
  trainedAt: string;
}

/** The one active trained checkpoint (status='active'), or null. */
export async function getActiveTrainedModel(): Promise<ActiveModelInfo | null> {
  const row = await db.modelRecord.findFirst({
    where: { status: 'active', format: 'tfjs-trained-classifier' },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(row.manifest) as Record<string, unknown>; } catch { /* keep empty */ }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    format: row.format,
    classes: Array.isArray(manifest.classes) ? (manifest.classes as string[]) : [],
    vocabSize: typeof manifest.vocabSize === 'number' ? manifest.vocabSize : null,
    parameterCount: typeof manifest.parameterCount === 'number' ? manifest.parameterCount : null,
    datasetVersion: typeof manifest.datasetVersion === 'string' ? manifest.datasetVersion : null,
    finalMetrics: (manifest.finalMetrics ?? null) as Record<string, unknown> | null,
    trainedAt: row.createdAt.toISOString(),
  } as ActiveModelInfo;
}

/**
 * Mark `modelId` as THE current trained model. Demotes every other active
 * model first — at most one active checkpoint exists at any time.
 */
export async function markModelCurrent(modelId: string): Promise<void> {
  await db.$transaction([
    db.modelRecord.updateMany({ where: { status: 'active', id: { not: modelId } }, data: { status: 'registered' } }),
    db.modelRecord.update({ where: { id: modelId }, data: { status: 'active' } }),
  ]);
  invalidateClassifierCache();
}

// ---------- runtime classifier (cached tf model for decision paths) ----------

interface ClassifierBundle {
  modelId: string;
  modelVersion: string;
  model: tf.LayersModel;
  classes: string[];
  vocabSize: number;
}

const gClassifier = globalThis as unknown as { __nextoolRuntimeClassifier?: ClassifierBundle | null };

function invalidateClassifierCache(): void {
  gClassifier.__nextoolRuntimeClassifier = null;
}

async function loadRuntimeClassifier(): Promise<ClassifierBundle | null> {
  const active = await getActiveTrainedModel();
  if (!active) return null;
  const cached = gClassifier.__nextoolRuntimeClassifier;
  if (cached && cached.modelId === active.id) return cached;

  const row = await db.modelRecord.findUnique({ where: { id: active.id } });
  if (!row) return null;
  const manifest = JSON.parse(row.manifest) as {
    modelTopology?: unknown;
    weightSpecs?: { name: string; shape: number[]; dtype: string }[];
    weightData?: string;
    classes?: string[];
    vocabSize?: number;
  };
  if (!manifest.modelTopology || !manifest.weightSpecs || !manifest.weightData || !manifest.classes || !manifest.vocabSize) {
    return null;
  }
  const weightData = Uint8Array.from(Buffer.from(manifest.weightData, 'base64')).buffer;
  const model = await tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: manifest.modelTopology as tf.io.ModelArtifacts['modelTopology'],
    weightSpecs: manifest.weightSpecs as never,
    weightData,
  }));
  const bundle: ClassifierBundle = {
    modelId: active.id,
    modelVersion: active.version,
    model,
    classes: manifest.classes,
    vocabSize: manifest.vocabSize,
  };
  gClassifier.__nextoolRuntimeClassifier = bundle;
  return bundle;
}

export interface ClassifierSuggestion {
  tool: string;
  confidence: number;
  modelVersion: string;
  modelId: string;
}

/**
 * Suggest ONE tool for a free-text request using the active trained
 * checkpoint. Returns null when no active model exists or it cannot load —
 * callers must degrade gracefully (heuristic fallback stays last).
 */
export async function suggestToolFromTrainedModel(request: string): Promise<ClassifierSuggestion | null> {
  try {
    const bundle = await loadRuntimeClassifier();
    if (!bundle) return null;
    const input = tf.tensor2d([vectorize(request, bundle.vocabSize)]);
    const prediction = bundle.model.predict(input) as tf.Tensor;
    const probs = Array.from(await prediction.data());
    input.dispose();
    prediction.dispose();
    let bestIdx = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;
    const tool = bundle.classes[bestIdx];
    if (!tool) return null;
    return {
      tool,
      confidence: Math.round(probs[bestIdx] * 1000) / 1000,
      modelVersion: bundle.modelVersion,
      modelId: bundle.modelId,
    };
  } catch (err) {
    console.error('[current-model] runtime classifier failed:', err);
    invalidateClassifierCache();
    return null;
  }
}
