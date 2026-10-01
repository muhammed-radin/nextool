/**
 * Memory tool handlers — persistent memory store (MemoryEntry table).
 */
import { db } from '@/lib/db';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** memory.store — { key required, value required (any JSON), tags? } → upsert. */
export const memoryStore: ToolHandler = async (params) => {
  const key = params.key === undefined ? undefined : String(params.key);
  if (!key) throw new ToolFailure('Missing required param: key', 'INVALID_PARAMS');
  if (params.value === undefined) throw new ToolFailure('Missing required param: value', 'INVALID_PARAMS');

  const tags = Array.isArray(params.tags) ? params.tags.map(String) : [];
  const valueJson = stringifyValue(params.value);

  const entry = await db.memoryEntry.upsert({
    where: { key },
    update: { value: valueJson, tags: JSON.stringify(tags), source: 'tool' },
    create: { key, value: valueJson, tags: JSON.stringify(tags), source: 'tool' },
  });

  return {
    key: entry.key,
    value: safeParse(entry.value),
    tags: safeParseTags(entry.tags),
    updatedAt: entry.updatedAt.toISOString(),
  };
};

/** memory.recall — { key? , query? }: exact key recall or fuzzy search (top 5). */
export const memoryRecall: ToolHandler = async (params) => {
  const key = params.key === undefined ? undefined : String(params.key);
  const query = params.query === undefined ? undefined : String(params.query).toLowerCase();

  if (key) {
    const entry = await db.memoryEntry.findUnique({ where: { key } });
    if (entry) {
      return {
        found: true,
        key: entry.key,
        value: safeParse(entry.value),
        tags: safeParseTags(entry.tags),
        source: entry.source,
        updatedAt: entry.updatedAt.toISOString(),
      };
    }
    if (!query) {
      return { found: false, key, message: `No memory entry found for key: ${key}` };
    }
  }

  if (!query && !key) throw new ToolFailure('Provide key or query', 'INVALID_PARAMS');
  if (!query) throw new ToolFailure('Missing required param: query', 'INVALID_PARAMS');

  const all = await db.memoryEntry.findMany({ take: 500, orderBy: { updatedAt: 'desc' } });
  const matches = all
    .filter((e) => {
      const tags = safeParseTags(e.tags).join(' ').toLowerCase();
      return (
        e.key.toLowerCase().includes(query) ||
        tags.includes(query) ||
        e.value.toLowerCase().includes(query)
      );
    })
    .slice(0, 5)
    .map((e) => ({
      key: e.key,
      value: safeParse(e.value),
      tags: safeParseTags(e.tags),
      updatedAt: e.updatedAt.toISOString(),
    }));

  return { found: matches.length > 0, query, matches };
};

function safeParse(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function safeParseTags(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
