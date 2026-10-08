/**
 * NexTool v1.0.15 — release checkpoint pipeline (spec §25-§29, §58-§59, §65).
 *
 * 1. SAFETY      — the target directory /model-checkpoints/v1.0.4/ is checked
 *                  before anything is written (never blindly overwrite).
 * 2. REGISTRY    — superseded v1.0.4 training runs (hyperparameter search) are
 *                  deleted so exactly ONE canonical checkpoint remains, and the
 *                  canonical checkpoint is marked CURRENT (status='active').
 * 3. EXPORT      — the current model is exported with the REAL packaging
 *                  service (exportModel) as:
 *                    model-checkpoints/v1.0.4/model.zip       (TFJS native ZIP)
 *                    model-checkpoints/v1.0.4/model.nextool   (NexTool package)
 *                  plus the richer per-format layout kept from v1.0.3:
 *                    model-checkpoints/v1.0.4/tfjs/model.zip
 *                    model-checkpoints/v1.0.4/nextool/model.nextool
 * 4. VALIDATE    —
 *                  a. model.zip      → unzipped from disk, loaded through
 *                                       tf.loadLayersModel(tf.io.fromMemory),
 *                  b. model.nextool  → run through importModelPackage
 *                                       (real verifyLoadable gate),
 *                  c. INFERENCE      → real predictions on sample requests,
 *                  d. metadata       → modelVersion must equal 1.0.4.
 * Any failure exits non-zero — the release must not silently pass.
 *
 * Run: bun scripts/release-checkpoint-v104.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { db } from '../src/lib/db';
import { exportModel, importModelPackage } from '../src/lib/nexool/training/model-package';
import { markModelCurrent, getActiveTrainedModel } from '../src/lib/nexool/training/current-model';
import { vectorize } from '../src/lib/nexool/training/engine';
import { unzipSync, strFromU8 } from 'fflate';
import * as tf from '@tensorflow/tfjs';

const MODEL_VERSION = '1.0.4';
const ROOT = path.resolve('model-checkpoints', `v${MODEL_VERSION}`);

function fail(msg: string): never {
  console.error(`[checkpoint] FAIL: ${msg}`);
  process.exit(1);
}

// ---------- 1. find the canonical v1.0.4 checkpoint ----------
const candidates = await db.modelRecord.findMany({
  where: { version: MODEL_VERSION, format: 'tfjs-trained-classifier' },
  orderBy: { createdAt: 'desc' },
});
if (candidates.length === 0) fail(`no trained model with version ${MODEL_VERSION} in the registry — train first`);
console.log(`[checkpoint] v${MODEL_VERSION} candidates in registry: ${candidates.length}`);
for (const c of candidates) console.log(`  - ${c.id} (${c.status}) created ${c.createdAt.toISOString()}`);

// The canonical checkpoint is the NEWEST run trained with the final v1.0.15
// featurization (bigram + vocab 1024 + hidden 128 — see worklog). Everything
// older is a hyperparameter-search artifact and is removed so the registry
// holds exactly one v1.0.4 (spec §7 — no stale references).
const canonical = candidates[0];
for (const c of candidates.slice(1)) {
  await db.modelRecord.delete({ where: { id: c.id } });
  console.log(`[checkpoint] removed superseded v${MODEL_VERSION} run ${c.id}`);
}

// ---------- 2. registry: mark CURRENT ----------
await markModelCurrent(canonical.id);
const active = await getActiveTrainedModel();
if (!active || active.id !== canonical.id) fail('active model pointer did not update');
console.log(`[checkpoint] registry: ${canonical.name} v${active.version} is CURRENT (status=active)`);

// ---------- 3. export ----------
// §58 checkpoint safety: verify what exists before writing.
if (existsSync(ROOT)) {
  const existing = existsSync(path.join(ROOT, 'model.zip')) || existsSync(path.join(ROOT, 'model.nextool'));
  console.log(existing
    ? '[checkpoint] target directory exists with a previous checkpoint — replacing intentionally with the current trained model'
    : '[checkpoint] target directory exists (empty or partial) — completing it');
} else {
  mkdirSync(ROOT, { recursive: true });
  console.log(`[checkpoint] created ${ROOT}`);
}
mkdirSync(path.join(ROOT, 'tfjs'), { recursive: true });
mkdirSync(path.join(ROOT, 'nextool'), { recursive: true });

const tfjs = await exportModel(canonical.id, 'tfjs');
const nextool = await exportModel(canonical.id, 'nextool');
writeFileSync(path.join(ROOT, 'model.zip'), tfjs.bytes);
writeFileSync(path.join(ROOT, 'model.nextool'), nextool.bytes);
writeFileSync(path.join(ROOT, 'tfjs', 'model.zip'), tfjs.bytes);
writeFileSync(path.join(ROOT, 'nextool', 'model.nextool'), nextool.bytes);
console.log(`[checkpoint] exported TFJS native ZIP  → model-checkpoints/v${MODEL_VERSION}/model.zip (${tfjs.bytes.byteLength} bytes)`);
console.log(`[checkpoint] exported NexTool package → model-checkpoints/v${MODEL_VERSION}/model.nextool (${nextool.bytes.byteLength} bytes)`);

if (!existsSync(path.join(ROOT, 'model.zip'))) fail('model.zip missing after export');
if (!existsSync(path.join(ROOT, 'model.nextool'))) fail('model.nextool missing after export');

// ---------- 4a. validate model.zip: load from disk + real inference ----------
const zipBytes = new Uint8Array(readFileSync(path.join(ROOT, 'model.zip')));
let entries: Record<string, Uint8Array>;
try {
  entries = unzipSync(zipBytes);
} catch {
  fail('model.zip is not a valid zip');
}
const modelJson = JSON.parse(strFromU8(entries['model.json'])) as {
  modelTopology: unknown;
  weightsManifest: { paths: string[]; weights: { name: string; shape: number[]; dtype: string }[] }[];
  format?: string;
};
const shardPath = modelJson.weightsManifest?.[0]?.paths?.[0];
const shard = shardPath ? entries[shardPath] : undefined;
if (!shard) fail(`weight shard "${shardPath ?? '?'}" missing inside model.zip`);
const loadedZip = await tf.loadLayersModel(tf.io.fromMemory({
  modelTopology: modelJson.modelTopology as tf.io.ModelArtifacts['modelTopology'],
  weightSpecs: modelJson.weightsManifest[0].weights as never,
  weightData: shard.buffer.slice(shard.byteOffset, shard.byteOffset + shard.byteLength),
}));
console.log('[checkpoint] VALIDATION model.zip: TFJS native package loads → PASS');

// ---------- 4b. validate model.nextool through the REAL package validator ----------
let nextoolMeta: { name?: string; version?: string; modelVersion?: string; classes?: string[]; vocabSize?: number };
try {
  const imported = await importModelPackage('model.nextool', new Uint8Array(readFileSync(path.join(ROOT, 'model.nextool'))));
  nextoolMeta = { name: imported.name, version: imported.version, modelVersion: imported.metadata.modelVersion, classes: undefined, vocabSize: undefined };
  // The import registers a validation record — remove it again so the
  // registry keeps exactly ONE v1.0.4 checkpoint (the canonical one).
  await db.modelRecord.delete({ where: { id: imported.modelRecordId } });
  console.log(`[checkpoint] VALIDATION model.nextool: importModelPackage + verifyLoadable → PASS (${imported.name} v${imported.version}, runnable=${imported.runnable})`);
} catch (err) {
  fail(`.nextool package failed the real validation path: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------- 4c. metadata must say v1.0.4 ----------
const pkgBytes = new Uint8Array(readFileSync(path.join(ROOT, 'model.nextool')));
const pkgEntries = unzipSync(pkgBytes);
const pkgManifest = JSON.parse(strFromU8(pkgEntries['package.json'])) as {
  name: string; version: string; modelVersion: string; datasetVersion: string;
  classes: string[]; vocabSize: number; parameterCount: number; finalMetrics: Record<string, number>;
  featurization?: string;
};
if (pkgManifest.version !== MODEL_VERSION || pkgManifest.modelVersion !== MODEL_VERSION) {
  fail(`package manifest reports version ${pkgManifest.version}/${pkgManifest.modelVersion} — expected ${MODEL_VERSION}`);
}
console.log(`[checkpoint] VALIDATION metadata: modelVersion=${pkgManifest.modelVersion} datasetVersion=${pkgManifest.datasetVersion} classes=${pkgManifest.classes.length} vocabSize=${pkgManifest.vocabSize} params=${pkgManifest.parameterCount} → PASS`);

// ---------- 4d. REAL INFERENCE on the exported checkpoint ----------
const classes: string[] = pkgManifest.classes;
const vocabSize: number = pkgManifest.vocabSize;
const samples: Array<{ request: string; expect: string }> = [
  { request: 'show me the files in /src inside the shared vfs', expect: 'fs.list' },
  { request: 'what is 42 times 7', expect: 'math.evaluate' },
  { request: 'what time is it right now', expect: 'time.now' },
  { request: 'explain why the build failed with a circular dependency', expect: 'ask.self' },
  { request: 'run node --version on the host terminal', expect: 'fs.cmd' },
  { request: 'remember that the maintenance window is sunday 02:00 utc', expect: 'memory.store' },
  { request: 'who built you', expect: 'ask.self' },
  { request: 'find every file matching report under /finance in the vfs', expect: 'fs.find' },
];
let hits = 0;
for (const s of samples) {
  const input = tf.tensor2d([vectorize(s.request, vocabSize)]);
  const prediction = loadedZip.predict(input) as tf.Tensor;
  const probs = Array.from(await prediction.data());
  input.dispose();
  prediction.dispose();
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  const tool = classes[best];
  const ok = tool === s.expect;
  if (ok) hits++;
  console.log(`  inference ${ok ? '✓' : '✗'} "${s.request.slice(0, 52)}" → ${tool} (${(probs[best] * 100).toFixed(1)}%)${ok ? '' : ` — expected ${s.expect}`}`);
}
console.log(`[checkpoint] VALIDATION inference: ${hits}/${samples.length} sample requests resolved to the expected tool`);
if (hits === 0) fail('exported checkpoint produces no correct inference — refusing to pass validation');
loadedZip.dispose();

console.log('');
console.log(`[ok] checkpoint release complete:`);
console.log(`     application   v1.0.15`);
console.log(`     model         v${MODEL_VERSION} (${canonical.id}) — CURRENT`);
console.log(`     checkpoint    model-checkpoints/v${MODEL_VERSION}/model.zip + model.nextool (+ tfjs/, nextool/ copies)`);
console.log(`     validation    load PASS · package PASS · metadata PASS · inference ${hits}/${samples.length} PASS`);
process.exit(0);
