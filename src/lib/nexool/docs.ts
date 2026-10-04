/**
 * Documentation loader (server-side) — reads the markdown documentation system
 * from `<project>/docs`. Used by /api/docs and /api/docs/[slug].
 *
 * Files use optional front-matter:
 *   ---
 *   title: Architecture
 *   category: Architecture
 *   order: 10
 *   ---
 * The first `# Heading` is used as fallback title; the filename is the slug.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface DocMeta {
  slug: string;
  title: string;
  category: string;
  order: number;
  excerpt: string;
}

export interface DocContent extends DocMeta {
  content: string;
  updatedAt: string;
}

const DOCS_DIR = path.join(process.cwd(), 'docs');

/** Slug chars only (no separators/dots) — blocks path traversal by construction. */
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Canonical category display order for the docs index (fallback: alphabetical). */
const CATEGORY_ORDER = [
  'Getting Started',
  'Architecture',
  'AI Core',
  'Modes',
  'Tools',
  'Data',
  'Realtime',
  'API',
  'Frontend',
  'Operations',
  'Reference',
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

interface FrontMatter {
  title?: string;
  category?: string;
  order?: number;
}

function parseFrontMatter(raw: string): { meta: FrontMatter; body: string } {
  const meta: FrontMatter = {};
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('---', 3);
    if (end > 0) {
      const block = raw.slice(3, end);
      for (const line of block.split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)\s*$/);
        if (!m) continue;
        const [, key, value] = m;
        if (key === 'order') meta.order = Number(value) || 0;
        else if (key === 'title') meta.title = value.trim();
        else if (key === 'category') meta.category = value.trim();
      }
      body = raw.slice(end + 3).replace(/^\s*\n/, '');
    }
  }
  return { meta, body };
}

function titleFromBody(body: string, slug: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return slug
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function excerptFromBody(body: string): string {
  const text = body
    .replace(/^#.+$/m, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`|[-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 160);
}

export async function listDocs(): Promise<DocMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(DOCS_DIR);
  } catch {
    return []; // docs/ not present yet — honest empty state
  }
  const metas: DocMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    if (!SAFE_SLUG.test(slug)) continue;
    try {
      const raw = await fs.readFile(path.join(DOCS_DIR, name), 'utf8');
      const { meta, body } = parseFrontMatter(raw);
      metas.push({
        slug,
        title: meta.title ?? titleFromBody(body, slug),
        category: meta.category ?? 'Reference',
        order: meta.order ?? 500,
        excerpt: excerptFromBody(body),
      });
    } catch {
      // unreadable file — skip rather than break the index
    }
  }
  // Canonical category ordering (Getting Started → Reference), then per-category order.
  return metas.sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      a.order - b.order ||
      a.title.localeCompare(b.title),
  );
}

export async function readDoc(slug: string): Promise<DocContent | null> {
  if (!SAFE_SLUG.test(slug)) return null;
  try {
    const raw = await fs.readFile(path.join(DOCS_DIR, `${slug}.md`), 'utf8');
    const stat = await fs.stat(path.join(DOCS_DIR, `${slug}.md`));
    const { meta, body } = parseFrontMatter(raw);
    return {
      slug,
      title: meta.title ?? titleFromBody(body, slug),
      category: meta.category ?? 'Reference',
      order: meta.order ?? 500,
      excerpt: excerptFromBody(body),
      content: body,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}
