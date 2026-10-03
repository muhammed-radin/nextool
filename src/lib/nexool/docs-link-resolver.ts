/**
 * NexTool v1.0.5 §6 — CENTRALIZED documentation link resolver.
 *
 * One resolver decides how every markdown link inside the built-in docs viewer
 * behaves (§6.2 — no one-off fixes scattered across pages):
 *
 *   Markdown link
 *    ↓ isExternalHref?  → YES → normal external anchor (target _blank)
 *    ↓ isInPageAnchor?  → YES → scroll inside the current page
 *    ↓ isInternalDocLink → normalize against the REAL /api/docs index
 *                          ├── resolved → navigate WITHIN the Docs view
 *                          └── null     → in-viewer "not found" state (§6.5)
 *
 * The docs are FLAT files (<docs>/*.md, slug = filename), but source pages link
 * each other with category-style paths (`../ai-core/core-module.md`,
 * `./tools.md`, `tools.md#anchor`). Normalization takes the BASENAME, strips
 * `./`, `../` segments and the `.md` extension, then validates the result
 * against the actual documentation index — fictional pages are never created
 * (§6.3/§7).
 */

/** http(s), protocol-relative, mailto and tel links stay external (§6.6). */
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Absolute application paths (/api/..., /robots.txt, …) are NOT doc links. */
const APP_ABSOLUTE_RE = /^\//;

export function isExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  return EXTERNAL_RE.test(trimmed) || /^(mailto|tel):/i.test(trimmed);
}

export function isInPageAnchor(href: string): boolean {
  return href.trim().startsWith('#');
}

/** Anything else inside a doc page belongs to the internal documentation system. */
export function isInternalDocLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed || isExternalHref(trimmed) || isInPageAnchor(trimmed)) return false;
  if (APP_ABSOLUTE_RE.test(trimmed)) return false;
  return true;
}

/** The `#anchor` suffix of a link ('' when absent). */
export function docLinkAnchor(href: string): string {
  const hash = href.indexOf('#');
  return hash === -1 ? '' : href.slice(hash + 1);
}

export function stripAnchor(href: string): string {
  const hash = href.indexOf('#');
  return hash === -1 ? href : href.slice(0, hash);
}

/**
 * Normalize a doc href into a candidate slug:
 *   ../ai-core/core-module.md → core-module
 *   ./tool-development.md     → tool-development
 *   tools.md#export           → tools
 *   core-module               → core-module
 */
export function normalizeDocHref(href: string): string {
  let candidate = stripAnchor(href.trim());
  candidate = candidate.replace(/^\.{1,2}\//, '').replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '');
  // Flat docs directory: only the basename can match a real slug.
  const base = candidate.split('/').pop() ?? candidate;
  return base.replace(/\.md$/i, '').trim();
}

/**
 * Resolve a doc href against the ACTUAL documentation index (§6.3 — the index
 * from GET /api/docs). Returns the real slug, or null when the page genuinely
 * does not exist (caller shows the in-viewer not-found state — never a 404).
 */
export function resolveDocSlug(href: string, availableSlugs: readonly string[]): string | null {
  if (!isInternalDocLink(href)) return null;
  const candidate = normalizeDocHref(href);
  if (!candidate) return null;
  if (availableSlugs.includes(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  const ci = availableSlugs.find((s) => s.toLowerCase() === lower);
  return ci ?? null;
}

/**
 * GitHub-style heading slug — powers in-page anchors (`page.md#section`) and
 * heading ids in the docs viewer. Both sides use THIS function so anchors match.
 * GitHub parity: punctuation is REMOVED (not dash-replaced), so "A / B" keeps
 * its double dash from the surrounding spaces ("a--b") — matching the anchors
 * already written in the docs sources (e.g. tools.md#tool-export--import-as-json-v104).
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()#]/g, '')
    .replace(/[^\w\s-]/g, '')
    // Each whitespace char becomes one dash (GitHub parity — "A / B" → "a--b").
    .replace(/\s/g, '-')
    .trim();
}
