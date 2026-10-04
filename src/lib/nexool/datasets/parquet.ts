/**
 * NexTool v1.0.3 — Parquet dataset adapter.
 *
 * REAL binary Parquet interchange for the dataset system, implemented on
 * @dsnp/parquetjs 1.8.9 (pure-JavaScript Parquet reader + writer, works in the
 * Node.js runtime and Bun). This replaces the v1.0.2 "not installed" state —
 * the adapter is installed, and import/export/inspection go through this ONE
 * module so the web console, the API and the CLI share the same behavior.
 *
 * Why Parquet (docs/datasets.md):
 *   JSON   → human-readable row interchange, convenient for small datasets.
 *   Parquet→ binary, column-oriented format; efficient storage/compression
 *            for larger datasets and the standard interchange format for
 *            analytics/training pipelines.
 *
 * Storage model: examples always live in the registry as structured records;
 * Parquet is the ENCODING used at the import/export boundary:
 *
 *   Parquet file → decode → DatasetExample[] → registry
 *   registry     → DatasetExample[] → encode → Parquet file
 *
 * Column schema (flat, one row per example):
 *   category       UTF8 (required)
 *   request        UTF8 (required)
 *   expectedTool   UTF8 (optional)
 *   expectedParams UTF8 (optional — JSON-serialized object)
 *   split          UTF8 (train | validation | test)
 *
 * Capability detection is honest: `parquetAdapterInfo()` attempts the real
 * import and reports what actually happened — nothing is faked.
 */
import type { DatasetExample } from '../types';

const PARQUET_PACKAGE = '@dsnp/parquetjs';
const MAX_EXAMPLES = 5000; // mirrors datasetImportSchema cap

// ---------- capability detection (cached, honest) ----------

interface AdapterState {
  available: boolean;
  checked: boolean;
  error: string | null;
}

const g = globalThis as unknown as { __nextoolParquetAdapter?: AdapterState };

export interface ParquetAdapterInfo {
  available: boolean;
  /** Package used by the adapter when available. */
  packageName: string | null;
  /** Readable reason when the adapter is unavailable. */
  error: string | null;
}

/**
 * Detect the Parquet adapter by attempting the real module import once per
 * process. Never pretends: `available` reflects whether the dependency is
 * actually loadable in this runtime.
 */
export async function parquetAdapterInfo(force = false): Promise<ParquetAdapterInfo> {
  const cached = g.__nextoolParquetAdapter;
  if (!force && cached?.checked) {
    return { available: cached.available, packageName: cached.available ? PARQUET_PACKAGE : null, error: cached.error };
  }
  const state: AdapterState = { available: false, checked: true, error: null };
  try {
    await import('@dsnp/parquetjs');
    state.available = true;
  } catch (err) {
    state.available = false;
    state.error = err instanceof Error ? err.message : 'Parquet library failed to load.';
  }
  g.__nextoolParquetAdapter = state;
  return { available: state.available, packageName: state.available ? PARQUET_PACKAGE : null, error: state.error };
}

// ---------- encode: DatasetExample[] → Parquet bytes ----------

/**
 * Encode dataset examples as a Parquet file buffer. Throws a readable Error
 * when the adapter is unavailable or the payload cannot be encoded.
 */
export async function encodeParquetDataset(examples: DatasetExample[]): Promise<Uint8Array> {
  const info = await parquetAdapterInfo();
  if (!info.available) {
    throw new Error(`Parquet adapter is not available (${info.error ?? 'dependency missing'}).`);
  }
  if (examples.length === 0) throw new Error('Cannot encode an empty dataset.');
  if (examples.length > MAX_EXAMPLES) {
    throw new Error(`Dataset exceeds the ${MAX_EXAMPLES} example limit for Parquet export.`);
  }

  const { ParquetWriter, ParquetSchema } = await import('@dsnp/parquetjs');
  const schema = new ParquetSchema({
    category: { type: 'UTF8' },
    request: { type: 'UTF8' },
    expectedTool: { type: 'UTF8', optional: true },
    expectedParams: { type: 'UTF8', optional: true },
    split: { type: 'UTF8' },
  } as const);

  const sink = new BufferSink();
  const writer = await ParquetWriter.openStream(schema, sink as never);
  try {
    for (const ex of examples) {
      await writer.appendRow({
        category: ex.category,
        request: ex.request,
        expectedTool: ex.expectedTool ?? null,
        expectedParams: ex.expectedParams !== undefined ? JSON.stringify(ex.expectedParams) : null,
        split: ex.split ?? 'train',
      });
    }
  } finally {
    await writer.close();
  }
  return new Uint8Array(sink.toBuffer());
}

/**
 * Minimal write sink matching the parquetjs stream contract
 * (`write(buf, cb)` / `end(cb)`) that accumulates chunks in memory.
 */
class BufferSink {
  private chunks: Buffer[] = [];

  write(buf: Buffer, cb: (err?: Error | null) => void) {
    this.chunks.push(buf);
    cb(null);
  }

  end(cb: (err?: Error | null) => void) {
    cb(null);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// ---------- decode: Parquet bytes → DatasetExample[] ----------

const SPLITS = new Set(['train', 'validation', 'test']);

/**
 * Decode a Parquet file buffer into dataset examples. Rows are validated
 * (category/request required, split vocabulary, expectedParams JSON) — a bad
 * row aborts with a readable message including its row index.
 */
export async function decodeParquetDataset(bytes: Uint8Array | Buffer): Promise<DatasetExample[]> {
  const info = await parquetAdapterInfo();
  if (!info.available) {
    throw new Error(`Parquet adapter is not available (${info.error ?? 'dependency missing'}).`);
  }

  const { ParquetReader } = await import('@dsnp/parquetjs');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  const reader = await ParquetReader.openBuffer(buf);
  try {
    const cursor = reader.getCursor();
    const examples: DatasetExample[] = [];
    let rowIndex = 0;
    let row: Record<string, unknown> | null;
    while ((row = (await cursor.next()) as Record<string, unknown> | null) !== null) {
      const category = readString(row.category, 'category');
      const request = readString(row.request, 'request');
      if (!category || !request) {
        throw new Error(`Parquet row ${rowIndex}: "category" and "request" are required non-empty strings.`);
      }
      const expectedTool = readOptionalString(row.expectedTool);
      let expectedParams: Record<string, unknown> | undefined;
      const rawParams = readOptionalString(row.expectedParams);
      if (rawParams !== undefined && rawParams.trim() !== '') {
        try {
          const parsed = JSON.parse(rawParams) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not a JSON object');
          }
          expectedParams = parsed as Record<string, unknown>;
        } catch {
          throw new Error(`Parquet row ${rowIndex}: expectedParams is not a JSON object string.`);
        }
      }
      const splitRaw = readOptionalString(row.split) ?? 'train';
      if (!SPLITS.has(splitRaw)) {
        throw new Error(`Parquet row ${rowIndex}: split must be one of train | validation | test (found "${splitRaw}").`);
      }
      examples.push({
        category,
        request,
        ...(expectedTool !== undefined ? { expectedTool } : {}),
        ...(expectedParams !== undefined ? { expectedParams } : {}),
        split: splitRaw as DatasetExample['split'],
      });
      rowIndex += 1;
      if (rowIndex > MAX_EXAMPLES) {
        throw new Error(`Parquet dataset exceeds the ${MAX_EXAMPLES} example limit.`);
      }
    }
    if (examples.length === 0) throw new Error('Parquet file contains no rows.');
    return examples;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function readString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`Parquet column "${what}" must be a string.`);
  return v;
}

function readOptionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error('optional string column has a non-string value.');
  return v;
}
