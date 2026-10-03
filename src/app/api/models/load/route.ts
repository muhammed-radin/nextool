/**
 * POST /api/models/load — validates a .nextool JSON manifest and registers it.
 * Body shape validated with modelLoadSchema (zod), then semantic .nextool checks
 * (v1.0.1 §54). Invalid manifest → 400 { ok:false, error:{ code:'INVALID_MANIFEST' } }.
 * Honest state: registration succeeds, but the inference adapter is NOT active
 * (no TF.js runtime in this environment — active engine stays llm-core).
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { modelLoadSchema } from '@/lib/nexool/schemas';
import type { ModelPackageInfo } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Manifest {
  name?: unknown;
  version?: unknown;
  format?: unknown;
  architecture?: unknown;
  compatibility?: unknown;
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, modelLoadSchema, 'INVALID_MANIFEST');
  if (parsed.error) return parsed.error;
  const manifest = parsed.data.manifest as Manifest;

  const errors: string[] = [];
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name must be a non-empty string');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) errors.push('version must be semver-like (e.g. 1.0.0)');
  if (manifest.format !== 'nextool') errors.push('format must be "nextool"');
  if (!manifest.architecture || typeof manifest.architecture !== 'object' || Array.isArray(manifest.architecture)) errors.push('architecture must be an object');
  const compat = manifest.compatibility as { runtime?: unknown } | undefined;
  if (!compat || typeof compat.runtime !== 'string' || !(compat.runtime as string).trim()) errors.push('compatibility.runtime must be a string');

  if (errors.length > 0) {
    return fail('INVALID_MANIFEST', `Invalid .nextool manifest: ${errors.join('; ')}`, 400);
  }

  const sizeBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  const row = await db.modelRecord.create({
    data: {
      name: (manifest.name as string).trim(),
      version: manifest.version as string,
      format: 'nextool-manifest',
      status: 'registered',
      manifest: JSON.stringify(manifest),
      sizeBytes,
      note: 'Registered. Inference adapter not active in this environment — active engine: llm-core.',
    },
  });

  return ok({
    id: row.id,
    name: row.name,
    version: row.version,
    format: row.format,
    status: row.status as ModelPackageInfo['status'],
    sizeBytes: row.sizeBytes ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.createdAt.toISOString(),
    manifest,
  }, 201);
}
