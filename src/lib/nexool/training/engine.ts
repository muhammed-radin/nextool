/**
 * NexTool v1.0.2 — REAL TensorFlow.js training engine (shared service layer).
 *
 * Both the Web Console (/api/training/*) and the CLI (nextool train) call the
 * functions in this module — there is exactly ONE training implementation
 * (v1.0.2 §43/§56). There is no second engine and no synthetic output: every
 * metric reported here is produced by an actual tf.layers model.fit run.
 *
 * Task: tool-selection classification. Dataset examples carry
 * { request, expectedTool, split }. Requests are vectorized with a hashed
 * bag-of-words (deterministic, no external deps); a small dense softmax
 * classifier is trained on the CPU backend.
 *
 * Everything is honest: examples without expectedTool are skipped and counted,
 * dataset too small → job fails with a readable reason, cancel is checked
 * between epochs. Pause is NOT supported (documented — no fake button).
 */
import { db } from '@/lib/db';
import * as tf from '@tensorflow/tfjs';
import type { TrainingConfig, TrainingEpochMetrics, TrainingLogLine } from '../types';
import { TRAINED_MODEL_VERSION } from '../version';

export const TRAINING_LOG_CAP = 400;

/** Internal resolved config: modelVersion stays OPTIONAL (legacy tc-<job>
 *  versions remain the default when unset). */
type ResolvedTrainingConfig = Required<Omit<TrainingConfig, 'earlyStoppingPatience' | 'modelVersion' | 'hiddenUnits'>> &
  Pick<TrainingConfig, 'earlyStoppingPatience' | 'modelVersion' | 'hiddenUnits'>;

const DEFAULT_CONFIG: ResolvedTrainingConfig = {
  epochs: 20,
  batchSize: 8,
  learningRate: 0.01,
  validationSplit: 0.2,
  shuffle: true,
  vocabSize: 128,
  hiddenUnits: 64,
  earlyStoppingPatience: 0,
  modelVersion: undefined,
};

export function resolveTrainingConfig(partial?: Partial<TrainingConfig>): ResolvedTrainingConfig {
  return {
    epochs: clampInt(partial?.epochs, DEFAULT_CONFIG.epochs, 1, 100),
    batchSize: clampInt(partial?.batchSize, DEFAULT_CONFIG.batchSize, 1, 128),
    learningRate: clampNum(partial?.learningRate, DEFAULT_CONFIG.learningRate, 0.0001, 1),
    validationSplit: clampNum(partial?.validationSplit, DEFAULT_CONFIG.validationSplit, 0, 0.5),
    shuffle: partial?.shuffle ?? true,
    vocabSize: clampInt(partial?.vocabSize, DEFAULT_CONFIG.vocabSize, 16, 1024),
    // v1.0.15 — configurable hidden width (8-512) for the expanded curriculum.
    hiddenUnits: clampInt(partial?.hiddenUnits, DEFAULT_CONFIG.hiddenUnits, 8, 512),
    earlyStoppingPatience: clampInt(partial?.earlyStoppingPatience, 0, 0, 50),
    // v1.0.10 §29 — semantic checkpoint version (e.g. '1.0.1'); validated for
    // shape here, honest fallback to the legacy tc-<job> version when unset.
    modelVersion:
      typeof partial?.modelVersion === 'string' && /^\d+\.\d+\.\d+/.test(partial.modelVersion.trim())
        ? partial.modelVersion.trim()
        : undefined,
  };
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}
function clampNum(v: number | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}

// ---------- tokenization ----------

/** Deterministic 32-bit string hash (FNV-1a). */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // keep dots and dashes so tokens like "api-01" survive intact
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Hashed bag-of-words + bigram vector, L2-normalized. Deterministic across runs.
 *
 * v1.0.15 — adjacent-token bigram features were added so the classifier sees
 * word order and structure, not just a bag of tokens. Within-family requests
 * ("show the contents of X" vs "show the metadata of X" vs "does X exist")
 * share nearly identical unigram vocabulary — the bigram terms
 * ("contents of", "does the", "metadata for") are what actually separate
 * them. Training (this file) and every inference path (benchmark runner,
 * runtime classifier) import this ONE function, so featurization can never
 * drift between train and serve. Checkpoints trained before v1.0.15
 * (unigram-only weights) keep their records for traceability but should be
 * retrained under v1.0.4+ for benchmark numbers to be meaningful.
 */
export function vectorize(text: string, vocabSize: number): number[] {
  const vec = new Float32Array(vocabSize);
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    vec[hashToken(tokens[i]) % vocabSize] += 1;
    if (i > 0) vec[hashToken(`b:${tokens[i - 1]} ${tokens[i]}`) % vocabSize] += 0.5;
  }
  let norm = 0;
  for (let i = 0; i < vocabSize; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vocabSize; i++) vec[i] /= norm;
  }
  return Array.from(vec);
}

export interface DatasetBundle {
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  /** examples with expectedTool, after split selection */
  train: { request: string; tool: string }[];
  val: { request: string; tool: string }[];
  skipped: number;
  classes: string[];
}

/** Select examples (explicit split > heuristic) and build the class table. */
export function prepareDataset(
  examples: { request: string; expectedTool?: string; split?: string }[],
  validationSplit: number,
): DatasetBundle {
  const usable = examples.filter((e) => typeof e.request === 'string' && e.request.trim() && typeof e.expectedTool === 'string' && e.expectedTool.trim());
  const skipped = examples.length - usable.length;

  let trainList = usable.filter((e) => e.split === 'train');
  const valList = usable.filter((e) => e.split === 'validation');
  const unlabeled = usable.filter((e) => !e.split);

  // Datasets without explicit splits: carve a validation holdout (deterministic).
  if (trainList.length === 0 && valList.length === 0) {
    const shuffled = [...usable];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = hashToken(shuffled[i].request) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const valCount = Math.floor(shuffled.length * validationSplit);
    valList.push(...shuffled.slice(0, valCount));
    trainList.push(...shuffled.slice(valCount));
  } else {
    trainList.push(...unlabeled);
  }

  const classes = [...new Set([...trainList, ...valList].map((e) => e.expectedTool as string))].sort();
  return {
    datasetId: '',
    datasetName: '',
    datasetVersion: '',
    train: trainList.map((e) => ({ request: e.request, tool: e.expectedTool as string })),
    val: valList.map((e) => ({ request: e.request, tool: e.expectedTool as string })),
    skipped,
    classes,
  };
}

// ---------- job runner ----------

export interface TrainResult {
  ok: boolean;
  jobId?: string;
  modelRecordId?: string;
  modelVersion?: string;
  finalMetrics?: {
    loss: number;
    valLoss: number | null;
    accuracy: number;
    valAccuracy: number | null;
    trainMs: number;
  };
  error?: string;
}

async function jobLog(jobId: string, level: TrainingLogLine['level'], message: string): Promise<void> {
  try {
    const row = await db.trainingJobRecord.findUnique({ where: { id: jobId }, select: { logs: true } });
    const logs = JSON.parse(row?.logs ?? '[]') as TrainingLogLine[];
    logs.push({ at: new Date().toISOString(), level, message });
    await db.trainingJobRecord.update({
      where: { id: jobId },
      data: { logs: JSON.stringify(logs.slice(-TRAINING_LOG_CAP)) },
    });
  } catch {
    /* logging must never break training */
  }
}

/**
 * Run a full training job end-to-end and persist status/metrics/logs to
 * TrainingJobRecord as it progresses (the UI polls this row).
 */
export async function runTrainingJob(input: {
  jobId: string;
  datasetId: string;
  config: ResolvedTrainingConfig;
}): Promise<TrainResult> {
  const { jobId, datasetId, config } = input;
  const t0 = Date.now();
  // v1.0.10 — the model handle lives OUTSIDE the try so a failed job still
  // disposes its tf.js variables (a leaked model permanently collides with
  // any later job: "Variable with name dense_Dense1/kernel was already
  // registered").
  let model: tf.Sequential | null = null;

  try {
    await db.trainingJobRecord.update({ where: { id: jobId }, data: { status: 'starting', startedAt: new Date() } });
    await jobLog(jobId, 'info', 'Training job starting — loading dataset');

    const dataset = await db.datasetRecord.findUnique({ where: { id: datasetId } });
    if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);
    const examples = JSON.parse(dataset.examples) as { request: string; expectedTool?: string; split?: string }[];
    await jobLog(jobId, 'info', `Dataset loaded: ${dataset.name} v${dataset.version} (${examples.length} examples)`);

    const bundle = prepareDataset(examples, config.validationSplit);
    if (bundle.skipped > 0) {
      await jobLog(jobId, 'warn', `${bundle.skipped} example(s) skipped — missing request or expectedTool`);
    }
    if (bundle.train.length < 4 || bundle.classes.length < 2) {
      throw new Error(
        `Not enough labeled training data: need >= 4 examples and >= 2 distinct tools, got ${bundle.train.length} examples / ${bundle.classes.length} classes`,
      );
    }
    await jobLog(jobId, 'info', `Prepared ${bundle.train.length} train / ${bundle.val.length} validation examples across ${bundle.classes.length} tools`);
    await jobLog(jobId, 'info', `Preprocessing: hashed bag-of-words (dim ${config.vocabSize}), L2-normalized`);

    // Preprocess
    const trainX = bundle.train.map((e) => vectorize(e.request, config.vocabSize));
    const trainY = bundle.train.map((e) => bundle.classes.indexOf(e.tool));
    const valX = bundle.val.map((e) => vectorize(e.request, config.vocabSize));
    const valY = bundle.val.map((e) => bundle.classes.indexOf(e.tool));
    const hasVal = valX.length > 0;

    await jobLog(jobId, 'info', `Model initialized: dense(${config.hiddenUnits ?? 64},relu) → dropout(0.1) → dense(softmax)`);

    // v1.0.10 — unique per-job model AND layer names: tf.js registers
    // variables by LAYER name, so two jobs in one process (or a job whose
    // variables were leaked by an earlier failure) must never reuse
    // `dense_Dense1` — otherwise "Variable ... was already registered".
    const uid = `${jobId.replace(/[^a-z0-9]/gi, '').slice(-8)}${Date.now().toString(36).slice(-4)}`;
    model = tf.sequential({ name: `nexool-tc-${uid}`, layers: [
      tf.layers.dense({ name: `din_${uid}`, inputShape: [config.vocabSize], units: config.hiddenUnits ?? 64, activation: 'relu' }),
      tf.layers.dropout({ name: `drop_${uid}`, rate: 0.1 }),
      tf.layers.dense({ name: `dout_${uid}`, units: bundle.classes.length, activation: 'softmax' }),
    ] });
    // Non-null alias for closures below (model is assigned once, right here).
    const net = model;
    model.compile({
      optimizer: tf.train.adam(config.learningRate),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });

    const xTensor = tf.tensor2d(trainX);
    const yTensor = tf.tensor2d(trainY.map((y) => oneHot(y, bundle.classes.length)));
    const valXTensor = hasVal ? tf.tensor2d(valX) : undefined;
    const valYTensor = hasVal ? tf.tensor2d(valY.map((y) => oneHot(y, bundle.classes.length))) : undefined;

    await db.trainingJobRecord.update({ where: { id: jobId }, data: { status: 'running', epochs: config.epochs } });
    await jobLog(jobId, 'info', `Training started: ${config.epochs} epochs, batch ${config.batchSize}, lr ${config.learningRate}${hasVal ? `, validation on ${valX.length} examples` : ' (no validation holdout)'}`);

    const metrics: TrainingEpochMetrics[] = [];
    let cancelRequested = false;
    // v1.0.10 §30 — early stopping + checkpoint selection state.
    let bestValLoss: number | null = null;
    let epochsSinceBestValLoss = 0;
    let earlyStoppedAt: number | null = null;

    // v1.0.10 §30 — checkpoint selection: snapshot the weights at the BEST
    // validation accuracy epoch and restore them before saving. The produced
    // checkpoint therefore represents the best validated state, not merely
    // the final epoch (anti-overfitting; works without overfitting by epoch
    // count).
    let bestValAccuracy = -1;
    let bestEpoch = 0;
    let bestWeightData: ArrayBuffer | null = null;
    let bestWeightSpecs: { name: string; shape: number[]; dtype: string }[] | null = null;
    let bestModelTopology: unknown = null;
    const snapshotBestWeights = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        void net.save(tf.io.withSaveHandler(async (a) => {
          bestWeightSpecs = (a.weightSpecs ?? []) as { name: string; shape: number[]; dtype: string }[];
          bestWeightData = a.weightData as ArrayBuffer;
          bestModelTopology = a.modelTopology;
          resolve();
          return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
        }));
      });
    };

    const callbacks: tf.CustomCallbackArgs = {
      onEpochEnd: async (epoch, logs) => {
        const row = {
          at: new Date().toISOString(),
          epoch: epoch + 1,
          loss: round4(logs?.loss ?? 0),
          valLoss: logs?.val_loss !== undefined ? round4(logs.val_loss as number) : null,
          accuracy: round4(logs?.acc ?? logs?.accuracy ?? 0),
          valAccuracy: logs?.val_acc !== undefined ? round4(logs.val_acc as number) : logs?.val_accuracy !== undefined ? round4(logs.val_accuracy as number) : null,
          elapsedMs: Date.now() - t0,
        };
        metrics.push(row);
        // §30 — keep the checkpoint of the best validation-accuracy epoch.
        if (row.valAccuracy !== null && row.valAccuracy > bestValAccuracy) {
          bestValAccuracy = row.valAccuracy;
          bestEpoch = row.epoch;
          await snapshotBestWeights();
        }
        await db.trainingJobRecord.update({
          where: { id: jobId },
          data: {
            epochsDone: epoch + 1,
            metrics: JSON.stringify(metrics),
          },
        });
        await jobLog(
          jobId,
          'info',
          `Epoch ${epoch + 1}/${config.epochs} — loss ${row.loss}${row.valLoss !== null ? `, val_loss ${row.valLoss}` : ''}, accuracy ${row.accuracy}${row.valAccuracy !== null ? `, val_accuracy ${row.valAccuracy}` : ''}${row.epoch === bestEpoch && row.valAccuracy !== null ? ' ★ best' : ''}`,
        );

        // Honor cancellation between epochs (status flipped by the API/CLI).
        const current = await db.trainingJobRecord.findUnique({ where: { id: jobId }, select: { status: true } });
        if (current?.status === 'cancelled') {
          cancelRequested = true;
          net.stopTraining = true;
          return;
        }
        // v1.0.10 §30 — MANUAL early stopping (val_loss, patience N). The tf.js
        // EarlyStopping callback is broken in this build (restoreBestWeights
        // unimplemented; getMonitorValue missing when combined with custom
        // callbacks) — so the safeguard is implemented here, deterministically.
        if ((config.earlyStoppingPatience ?? 0) > 0 && row.valLoss !== null) {
          const patience = config.earlyStoppingPatience ?? 0;
          if (bestValLoss === null || row.valLoss < bestValLoss - 1e-6) {
            bestValLoss = row.valLoss;
            epochsSinceBestValLoss = 0;
          } else {
            epochsSinceBestValLoss += 1;
            if (epochsSinceBestValLoss >= patience) {
              earlyStoppedAt = row.epoch;
              net.stopTraining = true;
              await jobLog(jobId, 'info', `Early stopping triggered: val_loss has not improved for ${patience} epoch(s) — stopping after epoch ${row.epoch}.`);
            }
          }
        }
      },
    };

    const fitCallbacks: tf.CustomCallbackArgs[] = [callbacks];
    if (hasVal && config.earlyStoppingPatience && config.earlyStoppingPatience > 0) {
      await jobLog(jobId, 'info', `Early stopping enabled (monitor val_loss, patience ${config.earlyStoppingPatience}) — manual implementation; best checkpoint restored via validation-accuracy selection`);
    }

    await net.fit(xTensor, yTensor, {
      epochs: config.epochs,
      batchSize: config.batchSize,
      shuffle: config.shuffle,
      validationData: hasVal ? [valXTensor as tf.Tensor, valYTensor as tf.Tensor] : undefined,
      callbacks: fitCallbacks,
    });

    xTensor.dispose();
    yTensor.dispose();
    valXTensor?.dispose();
    valYTensor?.dispose();

    if (cancelRequested) {
      await jobLog(jobId, 'warn', 'Training cancelled — model discarded');
      model.dispose();
      await db.trainingJobRecord.update({ where: { id: jobId }, data: { completedAt: new Date() } });
      return { ok: false, jobId, error: 'cancelled' };
    }
    if (earlyStoppedAt !== null) {
      await jobLog(jobId, 'info', `Training stopped early at epoch ${earlyStoppedAt}/${config.epochs} — the best validated checkpoint (epoch ${bestEpoch}, val_accuracy ${bestValAccuracy}) is restored below.`);
    }

    const finalLogs = metrics[metrics.length - 1];
    const trainMs = Date.now() - t0;
    const finalMetrics = {
      loss: finalLogs?.loss ?? 0,
      valLoss: finalLogs?.valLoss ?? null,
      accuracy: finalLogs?.accuracy ?? 0,
      valAccuracy: finalLogs?.valAccuracy ?? null,
      trainMs,
    };

    // ---- Persist the trained model as a REAL TFJS artifact (ModelRecord) ----
    // v1.0.10 §30 — when a best-validation checkpoint exists it REPLACES the
    // final-epoch weights: the registered checkpoint is the best validated
    // state, not simply the last one. Without validation data the final
    // weights are used (honest fallback).
    let artifacts: tf.io.ModelArtifacts;
    if (bestWeightData && bestWeightSpecs) {
      artifacts = {
        modelTopology: bestModelTopology as tf.io.ModelArtifacts['modelTopology'],
        weightSpecs: bestWeightSpecs,
        weightData: bestWeightData,
      };
      await jobLog(jobId, 'info', `Checkpoint selection: epoch ${bestEpoch} restored (best val_accuracy ${bestValAccuracy})`);
    } else {
      artifacts = await new Promise<tf.io.ModelArtifacts>((resolve) => {
        void net.save(tf.io.withSaveHandler(async (a) => {
          resolve(a);
          return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
        }));
      });
    }
    const weightSpecs = artifacts.weightSpecs ?? [];
    const parameterCount = weightSpecs.reduce((acc, w) => acc + w.shape.reduce((p, d) => p * d, 1), 0);
    const legacyVersion = `tc-${jobId.slice(-8, undefined).replace(/[^a-z0-9]/gi, '').slice(0, 8) || Date.now().toString(36).slice(-6)}`;
    // v1.0.10 §29 — semantic model version: config override (e.g. '1.0.1') →
    // shipped TRAINED_MODEL_VERSION for this release generation → legacy
    // tc-<job> identifier. Old checkpoints keep their versions (traceability).
    const modelVersion = config.modelVersion ?? TRAINED_MODEL_VERSION ?? legacyVersion;
    const packageName = `tool-classifier-${dataset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    const manifest = {
      name: packageName,
      version: modelVersion,
      checkpointId: legacyVersion, // v1.0.10 — legacy per-job identifier kept for traceability
      modelSemanticVersion: config.modelVersion ?? TRAINED_MODEL_VERSION,
      format: 'tfjs-trained-classifier',
      architecture: `dense-${config.hiddenUnits ?? 64}-relu → dropout-0.1 → dense-softmax`,
      featurization: 'hashed bag-of-words + bigrams, L2-normalized (v1.0.15)',
      parameterCount,
      classes: bundle.classes,
      vocabSize: config.vocabSize,
      datasetId,
      datasetName: dataset.name,
      datasetVersion: dataset.version,
      trainingConfig: config,
      checkpointSelection: bestWeightData ? { selectedEpoch: bestEpoch, valAccuracy: bestValAccuracy, strategy: 'best-validation-accuracy' } : { strategy: 'final-epoch (no validation holdout)' },
      finalMetrics,
      trainedAt: new Date().toISOString(),
      tfjsCompatibility: tf.version.tfjs ?? 'unknown',
      modelTopology: artifacts.modelTopology,
      weightSpecs,
      weightData: Buffer.from(artifacts.weightData as ArrayBuffer).toString('base64'),
    };

    const modelRecord = await db.modelRecord.create({
      data: {
        name: packageName,
        version: modelVersion,
        format: 'tfjs-trained-classifier',
        status: 'registered',
        manifest: JSON.stringify(manifest),
        sizeBytes: Buffer.byteLength(manifest.weightData, 'base64'),
        note: `Trained on ${dataset.name} v${dataset.version} — tool-selection classifier`,
      },
    });

    await jobLog(jobId, 'info', `Checkpoint saved: ${packageName} v${modelVersion} (${parameterCount} parameters) — model version ${config.modelVersion ?? TRAINED_MODEL_VERSION}`);
    await jobLog(jobId, 'info', `Training completed in ${(trainMs / 1000).toFixed(1)}s`);
    model.dispose();

    // v1.0.15 §29 — the freshly trained checkpoint becomes the CURRENT model:
    // the registry demotes every other active checkpoint and promotes this
    // one, so the runtime classifier (CoreModule hint + fallback) serves the
    // new generation immediately. Dynamic import — avoids the module cycle
    // with current-model.ts (which imports vectorize from this file).
    try {
      const { markModelCurrent } = await import('./current-model');
      await markModelCurrent(modelRecord.id);
      await jobLog(jobId, 'info', `Model registry: v${modelVersion} checkpoint marked CURRENT (active).`);
    } catch (promoteErr) {
      await jobLog(jobId, 'warn', `Model registry update failed (checkpoint stays registered): ${promoteErr instanceof Error ? promoteErr.message : String(promoteErr)}`);
    }

    await db.trainingJobRecord.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        epochsDone: metrics.length,
        metrics: JSON.stringify(metrics),
        finalMetrics: JSON.stringify({
          loss: finalLogs?.loss ?? 0,
          valLoss: finalLogs?.valLoss ?? null,
          accuracy: finalLogs?.accuracy ?? 0,
          valAccuracy: finalLogs?.valAccuracy ?? null,
          trainMs,
        }),
        modelRecordId: modelRecord.id,
        completedAt: new Date(),
      },
    });

    return {
      ok: true,
      jobId,
      modelRecordId: modelRecord.id,
      modelVersion,
      finalMetrics: {
        loss: finalLogs?.loss ?? 0,
        valLoss: finalLogs?.valLoss ?? null,
        accuracy: finalLogs?.accuracy ?? 0,
        valAccuracy: finalLogs?.valAccuracy ?? null,
        trainMs,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobLog(jobId, 'error', `Training failed: ${message}`);
    // v1.0.10 — release tf.js variables even on failure (see comment above).
    try {
      model?.dispose();
    } catch { /* already disposed */ }
    await db.trainingJobRecord.update({
      where: { id: jobId },
      data: { status: 'failed', error: message, completedAt: new Date() },
    });
    return { ok: false, jobId, error: message };
  }
}

function oneHot(index: number, size: number): number[] {
  const arr = new Array(size).fill(0);
  arr[index] = 1;
  return arr;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
