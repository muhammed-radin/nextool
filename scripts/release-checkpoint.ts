/**
 * NexTool v1.0.16 — checkpoint release script (spec §9/§17, replaces the
 * v1.0.4-specific release-checkpoint-v104.ts with a parameterized flow).
 *
 *   bun scripts/release-checkpoint.ts --version 1.0.5
 *
 * Workflow (§9.1): resolve the trained model of the target version in the
 * registry → mark it CURRENT → export TFJS ZIP + .nextool to
 * model-checkpoints/v<version>/ → validate BOTH artifacts through the REAL
 * load paths (tf.loadLayersModel for the zip, importModelPackage+verifyLoadable
 * for the package) → run REAL inference from the exported checkpoint →
 * verify the version metadata. Exits non-zero on any violation — the release
 * is only done when the checkpoint actually loads and answers.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { db } from '../src/lib/db';
import { APP_VERSION, TRAINED_MODEL_VERSION } from '../src/lib/nexool/version';
import { exportModel, importModelPackage } from '../src/lib/nexool/training/model-package';
import { markModelCurrent, getActiveTrainedModel } from '../src/lib/nexool/training/current-model';
import { vectorize } from '../src/lib/nexool/training/engine';
import { unzipSync, strFromU8 } from 'fflate';
import * as tf from '@tensorflow/tfjs';

// ---------- args ----------
const argIdx = process.argv.indexOf('--version');
const requested = argIdx !== -1 ? process.argv[argIdx + 1] : undefined;
const MODEL_VERSION = (requested ?? TRAINED_MODEL_VERSION).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(MODEL_VERSION)) {
  console.error(`[checkpoint] invalid version: ${MODEL_VERSION}`);
  process.exit(1);
}
const ROOT = path.resolve('model-checkpoints', `v${MODEL_VERSION}`);

function fail(msg: string): never {
  console.error(`[checkpoint] FAIL: ${msg}`);
  process.exit(1);
}

console.log(`[checkpoint] release target: model v${MODEL_VERSION} (application v${APP_VERSION})`);

// ---------- 1. resolve the trained model ----------
const candidates = await db.modelRecord.findMany({
  where: { version: MODEL_VERSION, format: 'tfjs-trained-classifier' },
  orderBy: { createdAt: 'desc' },
});
const active = candidates.find((c) => c.status === 'active') ?? candidates[0];
if (!active) fail(`no trained model with version ${MODEL_VERSION} in the registry — train first (nextool train)`);
console.log(`[checkpoint] canonical v${MODEL_VERSION}: ${active.id} (${active.status}) — ${candidates.length} record(s) of this version in the registry`);

// ---------- 2. registry: mark CURRENT ----------
await markModelCurrent(active.id);
const activeAfter = await getActiveTrainedModel();
if (!activeAfter || activeAfter.id !== active.id) fail('active model pointer did not update');
console.log(`[checkpoint] registry: ${active.name} v${activeAfter.version} is CURRENT (status=active)`);

// ---------- 3. export (never overwrite an OLDER version's directory) ----------
if (existsSync(ROOT)) {
  console.log(`[checkpoint] target directory exists — replacing v${MODEL_VERSION} artifacts with the current trained model`);
} else {
  mkdirSync(ROOT, { recursive: true });
  console.log(`[checkpoint] created ${ROOT}`);
}

const tfjs = await exportModel(active.id, 'tfjs');
const nextool = await exportModel(active.id, 'nextool');
writeFileSync(path.join(ROOT, 'model.zip'), tfjs.bytes);
writeFileSync(path.join(ROOT, 'model.nextool'), nextool.bytes);
console.log(`[checkpoint] exported TFJS native ZIP  → model-checkpoints/v${MODEL_VERSION}/model.zip (${tfjs.bytes.byteLength} bytes)`);
console.log(`[checkpoint] exported NexTool package → model-checkpoints/v${MODEL_VERSION}/model.nextool (${nextool.bytes.byteLength} bytes)`);

if (!existsSync(path.join(ROOT, 'model.zip'))) fail('model.zip missing after export');
if (!existsSync(path.join(ROOT, 'model.nextool'))) fail('model.nextool missing after export');

// ---------- 4a. validate model.zip: load from disk ----------
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
await tf.loadLayersModel(tf.io.fromMemory({
  modelTopology: modelJson.modelTopology as tf.io.ModelArtifacts['modelTopology'],
  weightSpecs: modelJson.weightsManifest[0].weights as never,
  weightData: shard.buffer.slice(shard.byteOffset, shard.byteOffset + shard.byteLength),
}));
console.log('[checkpoint] VALIDATION model.zip: TFJS native package loads → PASS');

// ---------- 4b. validate model.nextool through the REAL package validator ----------
try {
  const imported = await importModelPackage('model.nextool', new Uint8Array(readFileSync(path.join(ROOT, 'model.nextool'))));
  // The import registers a validation record — remove it again so the
  // registry keeps its canonical set.
  await db.modelRecord.delete({ where: { id: imported.modelRecordId } });
  console.log(`[checkpoint] VALIDATION model.nextool: importModelPackage + verifyLoadable → PASS (${imported.name} v${imported.version}, runnable=${imported.runnable})`);
} catch (err) {
  fail(`.nextool package failed the real validation path: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------- 4c. metadata must say the target version ----------
const pkgBytes = new Uint8Array(readFileSync(path.join(ROOT, 'model.nextool')));
const pkgEntries = unzipSync(pkgBytes);
const pkgManifest = JSON.parse(strFromU8(pkgEntries['package.json'])) as {
  name: string; version: string; modelVersion: string; datasetVersion: string;
  classes: string[]; vocabSize: number; parameterCount: number; finalMetrics: Record<string, number>;
  featurization?: string; applicationVersion?: string;
};
if (pkgManifest.version !== MODEL_VERSION || pkgManifest.modelVersion !== MODEL_VERSION) {
  fail(`package manifest reports version ${pkgManifest.version}/${pkgManifest.modelVersion} — expected ${MODEL_VERSION}`);
}
console.log(`[checkpoint] VALIDATION metadata: modelVersion=${pkgManifest.modelVersion} datasetVersion=${pkgManifest.datasetVersion} classes=${pkgManifest.classes.length} vocabSize=${pkgManifest.vocabSize} params=${pkgManifest.parameterCount} app=${pkgManifest.applicationVersion ?? '?'} → PASS`);

// ---------- 4d. REAL INFERENCE on the exported checkpoint ----------
const classes: string[] = pkgManifest.classes;
const vocabSize: number = pkgManifest.vocabSize;
const samples: Array<{ request: string; expect: string }> = [
  { request: 'read src/app.ts and explain the fetch call', expect: 'fs.readfile' },
  { request: 'run the build and show compiler errors', expect: 'fs.cmd' },
  { request: 'list the files in the project folder', expect: 'fs.list' },
  { request: 'what is 84 divided by 2', expect: 'math.evaluate' },
  { request: 'explain how async/await works in javascript', expect: 'ask.self' },
];
let passCount = 0;
for (const s of samples) {
  const input = tf.tensor2d([vectorize(s.request, vocabSize)]);
  const model = await tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: modelJson.modelTopology as tf.io.ModelArtifacts['modelTopology'],
    weightSpecs: modelJson.weightsManifest[0].weights as never,
    weightData: shard.buffer.slice(shard.byteOffset, shard.byteOffset + shard.byteLength),
  }));
  const prediction = model.predict(input) as tf.Tensor;
  const probs = Array.from(await prediction.data());
  input.dispose();
  prediction.dispose();
  let bestIdx = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;
  const predicted = classes[bestIdx];
  const ok = predicted === s.expect;
  if (ok) passCount += 1;
  console.log(`[checkpoint] inference "${s.request.slice(0, 44)}" → ${predicted} (${probs[bestIdx].toFixed(2)}) ${ok ? '✓' : `✗ expected ${s.expect}`}`);
}
if (passCount < 3) fail(`checkpoint inference only matched ${passCount}/${samples.length} probes`);
console.log(`[checkpoint] VALIDATION inference: ${passCount}/${samples.length} probes correct → PASS`);

console.log(`\n[checkpoint] DONE — NexTool v${APP_VERSION} ships model v${MODEL_VERSION}:`);
console.log(`  model-checkpoints/v${MODEL_VERSION}/model.zip     (${tfjs.bytes.byteLength} bytes, loads via tf.loadLayersModel)`);
console.log(`  model-checkpoints/v${MODEL_VERSION}/model.nextool (${nextool.bytes.byteLength} bytes, loads via importModelPackage)`);
console.log(`  registry current model: v${(await getActiveTrainedModel())?.version}`);
process.exit(0);
