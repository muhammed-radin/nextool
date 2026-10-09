/**
 * NexTool v1.0.2 — REAL model packaging service (shared by Web Console + CLI).
 *
 * Export formats (both are real, importable artifacts):
 *  - tfjs zip:    model.json (modelTopology + weightsManifest) + group1-shard1ofN.bin
 *                 + metadata.json — exactly what tf.loadLayersModel(tf.io.*) consumes.
 *  - .nextool:    the NexTool package — manifest (name/version/architecture/metrics/
 *                 classes/dataset lineage) + native tfjs topology + weights (shard bins)
 *                 + metadata.json.
 *
 * Import: validates either package and registers it as a ModelRecord. Compatible
 * trained-classifier packages become runnable for benchmarking.
 *
 * Zip handling uses fflate (no shell-out, no path traversal: entries are
 * name-filtered and size-capped).
 */
import { db } from '@/lib/db';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import * as tf from '@tensorflow/tfjs';
import { APP_NAME, APP_VERSION } from '../version';
import type { ExportedModelMetadata } from '../types';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024; // 25 MiB zip budget

// ---------- shared helpers ----------

interface ModelArtifactsInfo {
  topology: Record<string, unknown> | unknown[];
  weightSpecs: { name: string; shape: number[]; dtype: string }[];
  weightData: ArrayBuffer;
  parameterCount: number;
  tfjsVersion: string;
}

async function loadArtifactsFromRecord(row: {
  id: string; name: string; version: string; format: string; manifest: string;
}): Promise<ModelArtifactsInfo> {
  const manifest = JSON.parse(row.manifest) as {
    modelTopology?: Record<string, unknown> | unknown[];
    weightSpecs?: { name: string; shape: number[]; dtype: string }[];
    weightData?: string;
    tfjsCompatibility?: string;
    architecture?: string;
  };
  if (manifest.modelTopology && manifest.weightSpecs && manifest.weightData) {
    const weightData = Uint8Array.from(Buffer.from(manifest.weightData, 'base64')).buffer;
    const parameterCount = manifest.weightSpecs.reduce((acc, w) => acc + w.shape.reduce((p, d) => p * d, 1), 0);
    return {
      topology: manifest.modelTopology,
      weightSpecs: manifest.weightSpecs,
      weightData,
      parameterCount,
      tfjsVersion: manifest.tfjsCompatibility ?? tf.version.tfjs ?? 'unknown',
    };
  }
  throw new Error(
    `Model "${row.name}" v${row.version} (format: ${row.format}) does not contain native TFJS weights — only trained classifier checkpoints (format tfjs-trained-classifier) can be exported as binary packages.`,
  );
}

function buildWeightsManifest(artifacts: ModelArtifactsInfo): { paths: string[]; weights: typeof artifacts.weightSpecs }[] {
  return [{ paths: ['group1-shard1of1.bin'], weights: artifacts.weightSpecs }];
}

function buildMetadata(pkg: {
  record: { name: string; version: string; format: string; note?: string | null };
  artifacts: ModelArtifactsInfo;
  datasetVersion: string | null;
  format: 'tfjs-zip' | 'nextool';
}): ExportedModelMetadata {
  return {
    packageName: pkg.record.name,
    applicationVersion: APP_VERSION,
    modelVersion: pkg.record.version,
    architecture: (pkg.artifacts.topology as { className?: string })?.className === 'Sequential' ? 'tfjs-sequential' : 'tfjs-model',
    parameterCount: pkg.artifacts.parameterCount,
    datasetVersion: pkg.datasetVersion,
    createdAt: new Date().toISOString(),
    tfjsCompatibility: pkg.artifacts.tfjsVersion,
    packageFormat: pkg.format,
    notes: pkg.record.note ?? undefined,
  };
}

/** datasetVersion lineage from the manifest (null when absent — never invented). */
function datasetVersionOf(manifest: Record<string, unknown>): string | null {
  const v = (manifest as { datasetVersion?: unknown }).datasetVersion;
  return typeof v === 'string' ? v : null;
}

// ---------- export ----------

export type ExportFormat = 'tfjs' | 'nextool';

export interface ExportResult {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Export a ModelRecord as a downloadable zip.
 * format=tfjs    → model.json + group1-shard1of1.bin + metadata.json
 * format=nextool → package.json (NexTool manifest) + model/ topology+shard + metadata.json
 */
export async function exportModel(modelId: string, format: ExportFormat): Promise<ExportResult> {
  // v1.0.16 §8.1/§8.4 — 'current' resolves to the ACTIVE model record in ONE
  // place so the Models UI, the export API and the CLI all agree. When no
  // current model exists the caller gets a useful error instead of an
  // unrelated model or a silent failure.
  let row = await db.modelRecord.findUnique({ where: { id: modelId } });
  if (!row && modelId === 'current') {
    row = await db.modelRecord.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'desc' } });
    if (!row) throw new Error('No current model is registered (no active checkpoint). Train a model first — the Training page or "nextool train".');
  }
  if (!row) {
    const byName = await db.modelRecord.findMany({ where: { name: modelId }, orderBy: { createdAt: 'desc' }, take: 1 });
    row = byName[0];
  }
  if (!row) throw new Error(`Model not found: ${modelId}`);

  const manifest = JSON.parse(row.manifest) as Record<string, unknown>;
  const artifacts = await loadArtifactsFromRecord(row);
  const datasetVersion = datasetVersionOf(manifest);

  if (format === 'tfjs') {
    const modelJson = {
      modelTopology: artifacts.topology,
      weightsManifest: buildWeightsManifest(artifacts),
      format: 'tfjs-layers-model',
      generatedBy: `${APP_NAME} v${APP_VERSION}`,
    };
    const meta = buildMetadata({ record: row, artifacts, datasetVersion, format: 'tfjs-zip' });
    const bytes = zipSync({
      'model.json': strToU8(JSON.stringify(modelJson, null, 2)),
      'group1-shard1of1.bin': new Uint8Array(artifacts.weightData),
      'metadata.json': strToU8(JSON.stringify(meta, null, 2)),
    });
    return {
      fileName: `${row.name}-tfjs-v${row.version}.zip`,
      contentType: 'application/zip',
      bytes,
    };
  }

  // .nextool package
  const packageManifest = {
    name: row.name,
    version: row.version,
    format: 'nextool-model-package',
    packageName: `${row.name}-v${row.version}`,
    application: APP_NAME,
    applicationVersion: APP_VERSION,
    modelVersion: row.version,
    architecture: manifest.architecture ?? 'tfjs-sequential',
    parameterCount: artifacts.parameterCount,
    datasetVersion,
    classes: manifest.classes ?? null,
    vocabSize: manifest.vocabSize ?? null,
    finalMetrics: manifest.finalMetrics ?? null,
    trainingConfig: manifest.trainingConfig ?? null,
    tfjsCompatibility: artifacts.tfjsVersion,
    packageFormat: 'nextool',
    createdAt: new Date().toISOString(),
    notes: row.note ?? undefined,
  };
  const meta = buildMetadata({ record: row, artifacts, datasetVersion, format: 'nextool' });
  const bytes = zipSync({
    'package.json': strToU8(JSON.stringify(packageManifest, null, 2)),
    'model/model.json': strToU8(JSON.stringify({
      modelTopology: artifacts.topology,
      weightsManifest: buildWeightsManifest(artifacts),
    })),
    'model/group1-shard1of1.bin': new Uint8Array(artifacts.weightData),
    'metadata.json': strToU8(JSON.stringify(meta, null, 2)),
  });
  return {
    fileName: `${row.name}-v${row.version}.nextool`,
    contentType: 'application/octet-stream',
    bytes,
  };
}

function strToU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- import ----------

export interface ImportResult {
  name: string;
  version: string;
  format: string;
  modelRecordId: string;
  runnable: boolean;
  metadata: ExportedModelMetadata | null;
  warnings: string[];
}

interface ParsedPackage {
  name: string;
  version: string;
  format: string;
  architecture?: string;
  notes?: string;
  modelTopology?: unknown;
  weightSpecs?: { name: string; shape: number[]; dtype: string }[];
  weightData?: string; // base64
  classes?: string[];
  vocabSize?: number;
  datasetVersion?: string;
  tfjsCompatibility?: string;
  parameterCount?: number;
}

function nameIsSafe(name: string): boolean {
  return /^[\w./-]+$/.test(name) && !name.startsWith('/') && !name.includes('..');
}

/**
 * Import a .nextool or native tfjs zip (both are zips — .nextool is a zip
 * container; a bare JSON manifest is also accepted for backwards compatibility
 * with the v1.0.1 manifest validator).
 */
export async function importModelPackage(fileName: string, bytes: Uint8Array): Promise<ImportResult> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(`Package exceeds ${MAX_IMPORT_BYTES / 1024 / 1024} MiB limit.`);
  }

  const lower = fileName.toLowerCase();
  let pkg: ParsedPackage;
  let warnings: string[] = [];

  if (lower.endsWith('.json')) {
    // Bare manifest (v1.0.1 style) — validate honestly.
    let parsed: unknown;
    try {
      parsed = JSON.parse(strFromU8(bytes));
    } catch {
      throw new Error('File is not valid JSON.');
    }
    const p = parsed as Partial<ParsedPackage>;
    if (!p.name || !p.version) throw new Error('Manifest requires at least "name" and "version".');
    pkg = {
      name: String(p.name).slice(0, 120),
      version: String(p.version).slice(0, 40),
      format: 'nextool-manifest',
      notes: p.architecture ? `architecture: ${p.architecture}` : undefined,
    };
    warnings.push('Bare manifest imported — contains no native TFJS weights, not runnable for benchmarks.');
  } else if (lower.endsWith('.zip') || lower.endsWith('.nextool')) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error('File is not a valid zip package.');
    }
    const names = Object.keys(entries).filter((n) => nameIsSafe(n));
    if (names.length === 0) throw new Error('Zip archive contains no readable entries.');

    const isNextool = names.includes('package.json') && names.some((n) => n.startsWith('model/'));
    if (isNextool) {
      const pkgJson = JSON.parse(strFromU8(entries['package.json'])) as Partial<ParsedPackage>;
      const modelJson = JSON.parse(strFromU8(entries['model/model.json'])) as {
        modelTopology: unknown;
        weightsManifest: { paths: string[]; weights: { name: string; shape: number[]; dtype: string }[] }[];
      };
      const shardPath = modelJson.weightsManifest?.[0]?.paths?.[0];
      const shard = shardPath ? entries[`model/${shardPath}`] : undefined;
      if (!modelJson.modelTopology || !modelJson.weightsManifest?.[0]?.weights || !shard) {
        throw new Error('.nextool package is missing model topology or weight shards.');
      }
      pkg = {
        name: String(pkgJson.name ?? fileName.replace(/\.nextool$/i, '')).slice(0, 120),
        version: String(pkgJson.version ?? '0.0.0').slice(0, 40),
        format: 'tfjs-trained-classifier',
        architecture: pkgJson.architecture,
        notes: pkgJson.notes,
        modelTopology: modelJson.modelTopology,
        weightSpecs: modelJson.weightsManifest[0].weights,
        weightData: Buffer.from(shard).toString('base64'),
        classes: pkgJson.classes,
        vocabSize: pkgJson.vocabSize,
        datasetVersion: pkgJson.datasetVersion,
        tfjsCompatibility: pkgJson.tfjsCompatibility,
        parameterCount: pkgJson.parameterCount,
      };
      // Compatibility gate: verify the weights actually load before registering.
      await verifyLoadable(pkg);
    } else {
      // Native tfjs zip: model.json at root + shard bin(s).
      const modelJsonEntry = names.find((n) => n === 'model.json');
      if (!modelJsonEntry) throw new Error('Not a recognizable model package: missing model.json (expected native TFJS zip or .nextool).');
      const modelJson = JSON.parse(strFromU8(entries[modelJsonEntry])) as {
        modelTopology: unknown;
        weightsManifest: { paths: string[]; weights: { name: string; shape: number[]; dtype: string }[] }[];
      };
      const shardPath = modelJson.weightsManifest?.[0]?.paths?.[0];
      const shard = shardPath ? entries[shardPath] : undefined;
      if (!shard) throw new Error(`Weight shard "${modelJson.weightsManifest?.[0]?.paths?.[0] ?? '?'}" not found in zip.`);
      pkg = {
        name: fileName.replace(/\.(zip|nextool)$/i, '').slice(0, 120),
        version: 'imported',
        format: 'tfjs-native-import',
        modelTopology: modelJson.modelTopology,
        weightSpecs: modelJson.weightsManifest[0].weights,
        weightData: Buffer.from(shard).toString('base64'),
        tfjsCompatibility: 'unknown',
      };
      warnings.push('Native TFJS package imported as "tfjs-native-import" — benchmark compatibility depends on the architecture.');
      await verifyLoadable(pkg);
    }
  } else {
    throw new Error('Unsupported file type — upload a .nextool, .zip or .json package.');
  }

  const parameterCount = pkg.parameterCount
    ?? pkg.weightSpecs?.reduce((acc, w) => acc + w.shape.reduce((p, d) => p * d, 1), 0)
    ?? undefined;

  const metadata: ExportedModelMetadata = {
    packageName: pkg.name,
    applicationVersion: APP_VERSION,
    modelVersion: pkg.version,
    architecture: pkg.architecture ?? 'unknown',
    parameterCount: parameterCount ?? 0,
    datasetVersion: pkg.datasetVersion ?? null,
    createdAt: new Date().toISOString(),
    tfjsCompatibility: pkg.tfjsCompatibility ?? 'unknown',
    packageFormat: lower.endsWith('.nextool') ? 'nextool' : lower.endsWith('.zip') ? 'tfjs-zip' : 'nextool',
    notes: pkg.notes,
  };

  const record = await db.modelRecord.create({
    data: {
      name: pkg.name,
      version: pkg.version,
      format: pkg.format,
      status: 'registered',
      manifest: JSON.stringify(pkg),
      sizeBytes: bytes.byteLength,
      note: `Imported package (${lower.endsWith('.nextool') ? '.nextool' : lower.endsWith('.zip') ? 'tfjs zip' : 'manifest'})`,
    },
  });

  return {
    name: pkg.name,
    version: pkg.version,
    format: pkg.format,
    modelRecordId: record.id,
    runnable: !!pkg.weightData,
    metadata,
    warnings,
  };
}

/** Compatibility check: the topology+weights must actually load into tfjs. */
async function verifyLoadable(pkg: ParsedPackage): Promise<void> {
  try {
    const weightData = Uint8Array.from(Buffer.from(pkg.weightData as string, 'base64')).buffer;
    const model = await tf.loadLayersModel(tf.io.fromMemory({
      modelTopology: pkg.modelTopology as tf.io.ModelArtifacts['modelTopology'],
      weightSpecs: pkg.weightSpecs as never,
      weightData,
    }));
    model.dispose();
  } catch (err) {
    throw new Error(`Package failed TFJS compatibility validation: ${err instanceof Error ? err.message : String(err)}`);
  }
}
