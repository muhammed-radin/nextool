/**
 * NexTool v1.1.0 §5 — OUR PRODUCTS API.
 *
 * GET /api/products — reads the operator-maintained registry
 * (config/products.json), validates the shape, and returns the entries.
 * The registry is the single maintainable source: the self-hosting operator
 * edits the JSON file (no rebuild needed; the file is read per request with
 * a short mtime cache). Entries are showcased VERBATIM — this API never
 * invents URLs, statuses or screenshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail } from '@/lib/nexool/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface ProductEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  technologies: string[];
  status: 'live' | 'demo' | 'in-development';
  url?: string;
  demoView?: string;
  screenshot?: string;
}

const VALID_STATUS = new Set(['live', 'demo', 'in-development']);
const VALID_DEMO_VIEWS = new Set([
  'dashboard', 'task-console', 'live-monitor', 'tools', 'connectors', 'memory',
  'live-state', 'inspector', 'events', 'history', 'models', 'datasets',
  'skills', 'training', 'benchmark', 'docs', 'settings', 'limitations', 'assistant',
]);

const g = globalThis as unknown as {
  __nextoolProductsCache?: { mtimeMs: number; size: number; products: ProductEntry[]; meta: Record<string, unknown>; error?: string };
};

function readRegistry(): { products: ProductEntry[]; meta: Record<string, unknown>; error?: string } {
  const filePath = path.join(process.cwd(), 'config', 'products.json');
  let raw: unknown;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    return { products: [], meta: {}, error: `products registry unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const obj = raw as { products?: unknown; $meta?: Record<string, unknown> };
  if (!Array.isArray(obj.products)) {
    return { products: [], meta: obj.$meta ?? {}, error: 'products registry invalid: "products" must be an array' };
  }
  const products: ProductEntry[] = [];
  const issues: string[] = [];
  for (const [i, p] of obj.products.entries()) {
    if (typeof p !== 'object' || p === null) {
      issues.push(`products[${i}] must be an object`);
      continue;
    }
    const e = p as Record<string, unknown>;
    const id = String(e.id ?? '').trim();
    const name = String(e.name ?? '').trim();
    if (!id || !name) {
      issues.push(`products[${i}]: id and name are required`);
      continue;
    }
    const status = String(e.status ?? 'demo');
    if (!VALID_STATUS.has(status)) {
      issues.push(`products[${i}] (${id}): status must be live | demo | in-development (got "${status}")`);
      continue;
    }
    const demoView = e.demoView ? String(e.demoView) : undefined;
    if (demoView && !VALID_DEMO_VIEWS.has(demoView)) {
      issues.push(`products[${i}] (${id}): unknown demoView "${demoView}" — internal demo links must name a console view`);
      continue;
    }
    const url = e.url ? String(e.url) : undefined;
    if (url && !/^https?:\/\//i.test(url)) {
      issues.push(`products[${i}] (${id}): url must be an absolute http(s) URL`);
      continue;
    }
    products.push({
      id,
      name,
      description: String(e.description ?? '').trim(),
      category: String(e.category ?? 'product'),
      technologies: Array.isArray(e.technologies) ? e.technologies.map(String).slice(0, 12) : [],
      status: status as ProductEntry['status'],
      url,
      demoView,
      screenshot: e.screenshot ? String(e.screenshot) : undefined,
    });
  }
  return { products, meta: obj.$meta ?? {}, error: issues.length > 0 ? issues.join('; ') : undefined };
}

export async function GET() {
  const filePath = path.join(process.cwd(), 'config', 'products.json');
  try {
    const stat = fs.statSync(filePath);
    const cached = g.__nextoolProductsCache;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return Response.json({ ok: true, data: { products: cached.products, meta: cached.meta, error: cached.error } });
    }
    const fresh = readRegistry();
    g.__nextoolProductsCache = { mtimeMs: stat.mtimeMs, size: stat.size, ...fresh };
    return Response.json({ ok: true, data: fresh });
  } catch {
    const fresh = readRegistry();
    return Response.json({ ok: true, data: fresh });
  }
}

export async function PUT() {
  return fail('READ_ONLY', 'The products registry is operator-maintained: edit config/products.json on the host (see the $meta block in that file). The API intentionally exposes no write path.', 405);
}
