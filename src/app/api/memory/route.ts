/**
 * /api/memory — GET list, POST upsert, DELETE (?key=).
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseTags(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseValue(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export async function GET() {
  const rows = await db.memoryEntry.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 });
  return ok(rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: parseValue(r.value),
    tags: parseTags(r.tags),
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  })));
}

interface Body {
  key?: string;
  value?: unknown;
  tags?: string[];
  source?: string;
}

export async function POST(req: Request) {
  const body = await readJson<Body>(req);
  if (!body?.key || typeof body.key !== 'string' || !body.key.trim()) {
    return fail('INVALID_PARAMS', 'key (string) is required');
  }
  if (body.value === undefined) return fail('INVALID_PARAMS', 'value is required');
  const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
  const valueJson = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
  const row = await db.memoryEntry.upsert({
    where: { key: body.key.trim() },
    update: { value: valueJson, tags: JSON.stringify(tags), source: body.source ?? 'user' },
    create: { key: body.key.trim(), value: valueJson, tags: JSON.stringify(tags), source: body.source ?? 'user' },
  });
  return ok({
    id: row.id,
    key: row.key,
    value: parseValue(row.value),
    tags: parseTags(row.tags),
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }, 201);
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) return fail('INVALID_PARAMS', 'query param key is required');
  try {
    await db.memoryEntry.delete({ where: { key } });
    return ok({ deleted: true });
  } catch {
    return fail('NOT_FOUND', `Memory entry not found: ${key}`, 404);
  }
}
