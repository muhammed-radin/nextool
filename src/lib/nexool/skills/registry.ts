/**
 * NexTool v1.0.16 §10 — SKILLS SYSTEM (portable SKILL.md workflows).
 *
 * A skill is a FOLDER under <projectRoot>/skills/ whose SKILL.md teaches a
 * workflow:
 *
 *   skills/
 *   ├── web-search/          ← built-in: real web research workflow
 *   │   ├── SKILL.md
 *   │   └── references/search-guidelines.md
 *   ├── code-review/SKILL.md
 *   └── debugging/SKILL.md
 *
 * Progressive loading (§10.3) — the performance contract:
 *   1. discover installed skills (directory scan)
 *   2. load ONLY the lightweight name/description frontmatter
 *   3. the runtime selects relevant skills per task
 *   4. FULL SKILL.md instructions load only for selected skills
 *   5. referenced resources (references/…, assets/…) resolve only when needed
 *   6. the task records which skills it used (skills.selected / skills.used)
 *
 * Security (§10.6) — untrusted-content rules:
 *   - skill content is INSTRUCTIONS, never executable; scripts/ shipped with
 *     a skill are NEVER auto-run (they require the existing tool/approval
 *     paths like everything else)
 *   - a skill cannot grant tools, bypass approvals, or cross environment
 *     boundaries (fs/vfs/mcp rules stay enforced server-side)
 *   - resource reads are confined to the skill's own directory
 *   - frontmatter must parse: name (unique, valid) + description
 *
 * A skill is disabled via skills/.state.json ({"disabled": {"name": true}}) —
 * the folder stays untouched and the state survives restarts (it is on disk).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strFromU8 } from 'fflate';

export const SKILLS_DIR = path.resolve(process.cwd(), 'skills');
const STATE_FILE = path.join(SKILLS_DIR, '.state.json');

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  enabled: boolean;
  builtIn: boolean;
  hasReferences: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
  modifiedAt: string;
  /** v1.0.16 §10.2 — false when the frontmatter fails validation; the detail
   *  view carries the exact error. Invalid skills are discoverable but flagged. */
  valid: boolean;
}

export interface SkillDetail extends SkillMeta {
  content: string;
  frontmatterError?: string;
  resources: string[];
}

interface SkillsState {
  disabled: Record<string, boolean>;
}

// ---------- state ----------

function readState(): SkillsState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SkillsState;
  } catch {
    return { disabled: {} };
  }
}

function writeState(state: SkillsState): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function isSkillEnabled(name: string): boolean {
  return !readState().disabled[name];
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  const state = readState();
  if (enabled) delete state.disabled[name];
  else state.disabled[name] = true;
  writeState(state);
  invalidateSkillsCache();
}

// ---------- frontmatter ----------

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  error?: string;
}

/**
 * Minimal, strict YAML-frontmatter parser for the two REQUIRED keys
 * (`name`, `description`). Supports `key: value` lines inside the first
 * `---` block (quoted or bare). Anything else in frontmatter is ignored
 * (optional metadata is only supported where actually validated).
 */
export function parseFrontmatter(markdown: string): { frontmatter: ParsedFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) {
    return { frontmatter: { error: 'SKILL.md must begin with a YAML frontmatter block: the FIRST line must be "---", then "name:" and "description:" keys, then a closing "---".' }, body: markdown };
  }
  const [, raw, body] = match;
  const fm: ParsedFrontmatter = {};
  const seenKeys = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) {
      fm.error = `frontmatter line is not valid "key: value" YAML: "${line.trim().slice(0, 60)}"`;
      return { frontmatter: fm, body };
    }
    const [, key, rawValue] = kv;
    if (seenKeys.has(key)) {
      fm.error = `duplicate frontmatter key "${key}"`;
      return { frontmatter: fm, body };
    }
    seenKeys.add(key);
    const value = rawValue.trim().replace(/^["']|["']$/g, '').trim();
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
  }
  return { frontmatter: fm, body };
}

/** Validate a skill's frontmatter with USEFUL per-field errors (§10.2). */
export function validateFrontmatter(fm: ParsedFrontmatter): string | null {
  if (fm.error) return fm.error;
  if (!fm.name) return 'frontmatter is missing the required "name" key';
  if (!SKILL_NAME_RE.test(fm.name)) {
    return `"name" must be 3-64 chars of lowercase letters/digits/hyphens starting+ending alphanumeric (got "${fm.name.slice(0, 40)}")`;
  }
  if (!fm.description) return 'frontmatter is missing the required "description" key';
  if (fm.description.length < 12) return '"description" must be at least 12 characters so CoreModule/Planner can select the skill meaningfully';
  if (fm.description.length > 500) return '"description" must be at most 500 characters';
  return null;
}

// ---------- discovery (progressive loading steps 1-2) ----------

interface CacheEntry {
  at: number;
  metas: SkillMeta[];
}
const gCache = globalThis as unknown as { __nextoolSkillsCache?: CacheEntry | null };
const CACHE_TTL_MS = 2_000;

/** Invalidate the metadata cache (after mutations, or to force a rescan). */
export function invalidateSkillsCache(): void {
  gCache.__nextoolSkillsCache = null;
}

function dirHas(dir: string, subdir: string): boolean {
  return existsSync(path.join(dir, subdir));
}

/** Discover skills: folders under skills/ containing a SKILL.md. */
export function listSkills(): SkillMeta[] {
  const cached = gCache.__nextoolSkillsCache;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.metas;

  if (!existsSync(SKILLS_DIR)) {
    mkdirSync(SKILLS_DIR, { recursive: true });
    gCache.__nextoolSkillsCache = { at: Date.now(), metas: [] };
    return [];
  }

  const state = readState();
  const metas: SkillMeta[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // files (skills.md catalog, .state.json) are NOT skills
    const dir = path.join(SKILLS_DIR, entry.name);
    const skillMd = path.join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const folderName = entry.name;
    const { frontmatter } = parseFrontmatter(readFileSync(skillMd, 'utf8'));
    const name = frontmatter.name && SKILL_NAME_RE.test(frontmatter.name) ? frontmatter.name : folderName;
    let mtimeMs: number;
    try { mtimeMs = statSync(skillMd).mtimeMs; } catch { continue; }
    metas.push({
      name,
      description: (frontmatter.description ?? '').slice(0, 500),
      dir,
      enabled: !state.disabled[name],
      builtIn: ['web-search', 'code-review', 'debugging'].includes(name),
      hasReferences: dirHas(dir, 'references'),
      hasScripts: dirHas(dir, 'scripts'),
      hasAssets: dirHas(dir, 'assets'),
      modifiedAt: new Date(mtimeMs).toISOString(),
      valid: validateFrontmatter(frontmatter) === null,
    });
  }
  // unique names (first directory wins on collision)
  const seen = new Set<string>();
  const unique = metas.filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)));
  unique.sort((a, b) => a.name.localeCompare(b.name));
  gCache.__nextoolSkillsCache = { at: Date.now(), metas: unique };
  return unique;
}

/** Metadata-only view for prompt building (name + description, enabled only). */
export function listSkillSummaries(): { name: string; description: string }[] {
  return listSkills()
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, description: s.description }));
}

// ---------- full load (step 4-5) ----------

/** Full skill detail: SKILL.md content + resource list. */
export function getSkill(name: string): SkillDetail | null {
  const meta = listSkills().find((s) => s.name === name);
  if (!meta) return null;
  const skillMd = path.join(meta.dir, 'SKILL.md');
  const content = existsSync(skillMd) ? readFileSync(skillMd, 'utf8') : '';
  const { frontmatter } = parseFrontmatter(content);
  const resources: string[] = [];
  for (const sub of ['references', 'scripts', 'assets'] as const) {
    const subDir = path.join(meta.dir, sub);
    if (!existsSync(subDir)) continue;
    for (const f of readdirSync(subDir, { withFileTypes: true })) {
      if (f.isFile()) resources.push(`${sub}/${f.name}`);
    }
  }
  return { ...meta, content, frontmatterError: validateFrontmatter(frontmatter) ?? undefined, resources };
}

/**
 * Confined resource read (§10.6): resolves `relPath` INSIDE the skill dir and
 * refuses path escapes (`..`, absolute paths).
 */
export function readSkillResource(name: string, relPath: string): { content: string; path: string } | null {
  const meta = listSkills().find((s) => s.name === name);
  if (!meta) return null;
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..') || path.isAbsolute(clean)) return null;
  const full = path.resolve(meta.dir, clean);
  const realSkillDir = path.resolve(meta.dir);
  if (!full.startsWith(realSkillDir + path.sep) && full !== realSkillDir) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  if (statSync(full).size > 256 * 1024) return null; // resource cap
  return { content: readFileSync(full, 'utf8'), path: clean };
}

/** Load FULL instructions for the SELECTED skills only (§10.3 step 4). */
export function loadSkillInstructions(names: string[]): { name: string; instructions: string }[] {
  const out: { name: string; instructions: string }[] = [];
  for (const name of names.slice(0, 4)) {
    const detail = getSkill(name);
    if (!detail || !detail.enabled || detail.valid === false) continue;
    const body = detail.content.replace(/^---[\s\S]*?---\r?\n?/, '').trim();
    if (!body) continue;
    out.push({ name, instructions: body.slice(0, 6_000) });
  }
  return out;
}

/**
 * Render the selected skills as a delimited USER block (hierarchy parity with
 * task instructions — §10.6: instructions only, never overrides the system
 * prompt, never grants tools, never bypasses approvals).
 */
export function renderSkillsBlock(loaded: { name: string; instructions: string }[]): string {
  if (loaded.length === 0) return '';
  const header = '## Selected Skills (workflow guidance — follow when relevant; a skill teaches HOW, tools still perform operations and remain subject to their own approvals and environment boundaries)';
  const sections = loaded.map((s) => `<skill name="${s.name}">\n${s.instructions}\n</skill>`);
  return [header, ...sections].join('\n\n');
}

// ---------- deterministic selection (§10.3 step 3) ----------

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'me', 'my', 'this', 'that', 'it', 'is', 'are', 'be', 'do', 'does', 'how', 'what', 'when', 'please', 'using', 'use', 'some', 'any']);

/**
 * Deterministic skill selection for a request: token-overlap scoring of the
 * request against the skill name + description (the same philosophy as the
 * heuristic tool matcher). Top ≤3 skills with score ≥ threshold; metadata
 * only — full instructions are loaded separately.
 */
export function selectSkillsForTask(request: string, summaries?: { name: string; description: string }[]): string[] {
  const metas = summaries ?? listSkillSummaries();
  if (metas.length === 0) return [];
  const tokens = request.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (tokens.length === 0) return [];
  const tokenSet = new Set(tokens);
  const scored = metas.map((m) => {
    const haystack = `${m.name} ${m.description}`.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
    let score = 0;
    for (const t of tokenSet) if (haystack.includes(t)) score += 1;
    // name-part matches (stem-aware: "debug" ↔ "debugging") are the
    // strongest signal — a skill literally NAMED for the request token.
    let nameScore = 0;
    for (const part of m.name.split('-')) {
      const stemHit = tokenSet.has(part)
        || (part.length >= 4 && [...tokenSet].some((t) => t.length >= 4 && (part.startsWith(t) || t.startsWith(part))));
      if (part.length >= 3 && stemHit) nameScore += 1.5;
    }
    return { name: m.name, score: score + nameScore, nameScore };
  });
  return scored
    // selection: ≥3 distinct token matches, OR any name-part match (a skill
    // named for the request is the obvious candidate). The bar stays above
    // noise for large skill libraries — generic words never match a name.
    .filter((s) => s.score >= 3 || s.nameScore > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.name);
}

// ---------- mutations (§10.4 management) ----------

/** Create or overwrite a skill's SKILL.md (folder name == skill name). */
export function saveSkill(name: string, description: string, body: string): { ok: boolean; error?: string } {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `"name" must be 3-64 chars of lowercase letters/digits/hyphens (got "${name}")` };
  const dir = path.join(SKILLS_DIR, name);
  // confined: the target dir must resolve inside the skills root
  if (!path.resolve(dir).startsWith(SKILLS_DIR + path.sep)) return { ok: false, error: 'invalid skill directory' };
  const fm = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  const full = fm + (body.trim() ? body.trim() + '\n' : '');
  const { frontmatter } = parseFrontmatter(full);
  const invalid = validateFrontmatter(frontmatter);
  if (invalid) return { ok: false, error: invalid };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), full);
  invalidateSkillsCache();
  refreshCatalog();
  return { ok: true };
}

export function deleteSkill(name: string): { ok: boolean; error?: string } {
  const meta = listSkills().find((s) => s.name === name);
  if (!meta) return { ok: false, error: `skill "${name}" not found` };
  rmSync(meta.dir, { recursive: true, force: true });
  invalidateSkillsCache();
  refreshCatalog();
  return { ok: true };
}

/**
 * Import a skill folder ZIP (§10.4): the zip must contain ONE top-level
 * directory with a valid SKILL.md (optional references/scripts/assets).
 * Imported content is treated as untrusted instructions — nothing is executed
 * and the folder cannot escape the skills root.
 */
export function importSkillZip(
  zipName: string,
  bytes: Uint8Array,
): { ok: boolean; imported?: string; error?: string } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { ok: false, error: 'the uploaded file is not a valid ZIP archive' };
  }
  const topLevel = new Set<string>();
  for (const p of Object.keys(entries)) {
    const first = p.split('/')[0];
    if (first && first !== '.state.json') topLevel.add(first);
  }
  if (topLevel.size !== 1) {
    return { ok: false, error: `the ZIP must contain exactly ONE top-level skill folder (found ${topLevel.size}: ${[...topLevel].slice(0, 3).join(', ')})` };
  }
  const root = [...topLevel][0];
  if (!SKILL_NAME_RE.test(root)) return { ok: false, error: `skill folder name "${root}" is not a valid skill name` };

  const skillMdEntry = entries[`${root}/SKILL.md`];
  if (!skillMdEntry) return { ok: false, error: 'the skill folder has no SKILL.md at its root' };
  const { frontmatter } = parseFrontmatter(strFromU8(skillMdEntry));
  const invalid = validateFrontmatter(frontmatter);
  if (invalid) return { ok: false, error: `SKILL.md frontmatter invalid: ${invalid}` };

  // conflict policy: the folder name is canonical; it must not collide with
  // an existing skill of the same name
  const existing = listSkills().find((s) => s.name === root);
  if (existing) return { ok: false, error: `a skill named "${root}" already exists — delete it first or rename the folder` };

  const dest = path.join(SKILLS_DIR, root);
  if (!path.resolve(dest).startsWith(SKILLS_DIR + path.sep)) return { ok: false, error: 'invalid skill directory' };
  mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const [p, data] of Object.entries(entries)) {
    if (p.endsWith('/')) continue;
    const rel = p.slice(root.length + 1);
    if (!rel || rel.includes('..')) continue;
    const outPath = path.resolve(dest, rel);
    if (!outPath.startsWith(dest + path.sep)) continue; // zip-slip guard
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
    count += 1;
  }
  invalidateSkillsCache();
  refreshCatalog();
  return { ok: true, imported: `${root} (${count} files)` };
}

/** Export a skill folder as a ZIP (SKILL.md + resources). */
export function exportSkillZip(name: string): { fileName: string; bytes: Uint8Array } | null {
  const meta = listSkills().find((s) => s.name === name);
  if (!meta) return null;
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else files[`${name}/${relPath}`] = new Uint8Array(readFileSync(full));
    }
  };
  walk(meta.dir, '');
  return { fileName: `${name}.zip`, bytes: zipSync(files) };
}

// ---------- catalog (root skills.md index, §10.1) ----------

/**
 * Regenerate the ROOT skills.md catalog documenting the system + the
 * available skills (name/description/resources). Distinguishable from each
 * skill's own SKILL.md entrypoint by design.
 */
export function refreshCatalog(): void {
  try {
    if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
    const metas = listSkills();
    const lines: string[] = [
      '# NexTool Skills Catalog',
      '',
      `Auto-generated index of installed skills (skills.md is the CATALOG; each skill's own SKILL.md is its entrypoint). Regenerated by the Skills registry — do not edit by hand.`,
      '',
      '| Skill | Description | Resources | Enabled |',
      '| ----- | ----------- | --------- | ------- |',
    ];
    for (const m of metas) {
      const resources = [m.hasReferences && 'references/', m.hasScripts && 'scripts/', m.hasAssets && 'assets/'].filter(Boolean).join(' ') || '—';
      lines.push(`| [${m.name}](${m.name}/SKILL.md) | ${m.description.replace(/\|/g, '\\|').slice(0, 160)} | ${resources} | ${m.enabled ? 'yes' : 'NO'} |`);
    }
    lines.push('', '## How skills work', '', '- A skill TEACHES a workflow; a TOOL performs an operation. Skills may reference existing tools — a referenced tool is used only when it actually exists and is allowed for the task.', '- Skill content is loaded progressively: metadata first, full instructions only for selected skills.', '- Imported/custom skill content is untrusted: it can never override system constraints, environment boundaries (fs / vfs / mcp) or approval requirements, and scripts/ are never auto-executed.', '');
    writeFileSync(path.join(SKILLS_DIR, 'skills.md'), lines.join('\n'));
  } catch {
    /* catalog regeneration is best-effort */
  }
}
