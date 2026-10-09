/**
 * NexTool v1.1.0 §4 — FILE-EDITING TOOLS.
 *
 *   fs.apply_edits   — one or more validated, non-overlapping line/column or
 *                      character-offset edits applied as a SINGLE write
 *                      (validate the entire set first; never a partial patch).
 *   fs.find_replace  — literal or safely-bounded regex replacement with
 *                      case sensitivity, region limits, occurrence caps and
 *                      an HONEST zero-match result (matchCount 0 is reported,
 *                      never disguised as success).
 *   fs.insert_text   — insert at a line/column or before/after a matched
 *                      anchor (with occurrence selection).
 *   fs.append_text   — append to the end of a file (optional newline fixup,
 *                      optional create-if-missing).
 *
 * ENVIRONMENT BOUNDARY (§4.4 — unchanged): like every fs.* sibling these
 * handlers operate exclusively through the shared directory-backed VFS
 * (openGlobalVfs → normalizeVirtualPath → resolveSecure + symlink refusal).
 * They never touch the host filesystem and never widen any environment
 * boundary; MCP/restricted environments reach the same shared VFS only.
 *
 * SAFETY (§4.5): every edit set is validated BEFORE the file is modified;
 * the file is written once (all-or-nothing — no partial application);
 * results carry success/path/operation/changed/editCount|matchCount|
 * replacementCount/before-after sizes; durable-write-then-report. Destructive
 * usage flows through the standard approval hierarchy (autoExecuteTools
 * resolution) exactly like fs.writefile.
 */

import type { ToolDefinition, ToolParamDef } from '../types';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';
import { openGlobalVfs, VirtualFsError } from './vfs';

const FS_EDIT_CATEGORY = 'filesystem';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_EDITS = 50;
const MAX_PATTERN_CHARS = 500;
const MAX_REGEX_STEPS = 200_000;

function fp(
  name: string, type: ToolParamDef['type'], required: boolean, description: string,
  extra?: Partial<ToolParamDef>,
): ToolParamDef {
  return { name, type, required, description, generation: 'constructive', ...extra };
}

function toFsEditFailure(err: unknown): never {
  if (err instanceof ToolFailure) throw err;
  if (err instanceof VirtualFsError) {
    const code = err.code === 'ENOENT' ? 'FS_NOT_FOUND' : err.code === 'VFS_ACCESS' ? 'FS_ACCESS' : err.code;
    throw new ToolFailure(err.message, code);
  }
  throw new ToolFailure(err instanceof Error ? err.message : 'fs edit failed', 'FS_EDIT_FAILED');
}

// ---------- offset helpers ----------

interface Pos { line: number; column: number } // line 1-based, column 0-based chars

/** Offset of a 1-based line + 0-based column. Line/col beyond EOF clamp to EOF. */
function offsetOf(content: string, pos: Pos): number {
  const lines = content.split('\n');
  const lineIdx = Math.min(Math.max(pos.line - 1, 0), lines.length);
  let offset = 0;
  for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1; // +1 for '\n'
  const lineLen = lines[lineIdx]?.length ?? 0;
  // column == lineLen + 1 → include the trailing newline (start of next line)
  const col = Math.min(Math.max(pos.column ?? 0, 0), lineLen + (lineIdx < lines.length ? 1 : 0));
  return offset + col;
}

function offsetOfEndOfLine(content: string, line: number): number {
  const lines = content.split('\n');
  const lineIdx = Math.min(Math.max(line - 1, 0), lines.length);
  let offset = 0;
  for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1;
  return offset + (lines[lineIdx]?.length ?? 0);
}

interface EditRange { start: number; end: number; text: string; label: string }

function buildRange(content: string, edit: Record<string, unknown>, index: number): EditRange {
  const op = String(edit.op ?? '');
  const unit = edit.unit === 'offset' ? 'offset' : 'line';
  const text = typeof edit.text === 'string' ? edit.text : '';
  if (text.length > MAX_TEXT_CHARS) {
    throw new ToolFailure(`edits[${index}].text exceeds ${MAX_TEXT_CHARS} characters.`, 'FS_EDITS_INVALID');
  }
  const label = `edits[${index}] ${op}`;

  if (unit === 'offset') {
    const offset = Number(edit.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > content.length) {
      throw new ToolFailure(`${label}: "offset" must be an integer within [0, ${content.length}].`, 'FS_EDITS_INVALID');
    }
    if (op === 'insert_at') return { start: offset, end: offset, text, label };
    const length = Number(edit.length);
    if (!Number.isInteger(length) || length < 0 || offset + length > content.length) {
      throw new ToolFailure(`${label}: "length" must be an integer within [0, ${content.length - offset}].`, 'FS_EDITS_INVALID');
    }
    if (op === 'replace_range') return { start: offset, end: offset + length, text, label };
    if (op === 'remove_range') return { start: offset, end: offset + length, text: '', label };
    throw new ToolFailure(`${label}: unknown op "${op}" (replace_range | insert_at | remove_range).`, 'FS_EDITS_INVALID');
  }

  // line/column unit
  const startLine = Number(edit.startLine ?? edit.line);
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new ToolFailure(`${label}: "startLine" (or "line") must be a positive integer.`, 'FS_EDITS_INVALID');
  }
  if (op === 'insert_at') {
    const start = offsetOf(content, { line: startLine, column: Number(edit.column ?? 0) });
    return { start, end: start, text, label };
  }
  const endLine = Number(edit.endLine ?? startLine);
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new ToolFailure(`${label}: "endLine" must be an integer >= startLine.`, 'FS_EDITS_INVALID');
  }
  const start = offsetOf(content, { line: startLine, column: Number(edit.startColumn ?? 0) });
  const end = edit.endColumn === undefined
    ? offsetOfEndOfLine(content, endLine)
    : offsetOf(content, { line: endLine, column: Number(edit.endColumn) });
  if (end < start) {
    throw new ToolFailure(`${label}: the computed range is empty or inverted (start ${start} > end ${end}).`, 'FS_EDITS_INVALID');
  }
  if (op === 'replace_range') return { start, end, text, label };
  if (op === 'remove_range') return { start, end, text: '', label };
  throw new ToolFailure(`${label}: unknown op "${op}" (replace_range | insert_at | remove_range).`, 'FS_EDITS_INVALID');
}

/** Apply non-overlapping ranges sorted by start DESC (offsets stay stable). */
function applyRanges(content: string, ranges: EditRange[]): { content: string; applied: { label: string; start: number; end: number }[] } {
  const sorted = [...ranges].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = content;
  const applied: { label: string; start: number; end: number }[] = [];
  for (const r of sorted) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
    applied.push({ label: r.label, start: r.start, end: r.end });
  }
  applied.reverse(); // report in original order
  return { content: out, applied };
}

function readUtf8File(path: string): string {
  const vfs = openGlobalVfs();
  let raw: string | Buffer;
  try {
    raw = vfs.readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof VirtualFsError && err.code === 'ENOENT') {
      throw new ToolFailure(`fs edit: "${path}" does not exist in the shared VFS.`, 'FS_NOT_FOUND');
    }
    toFsEditFailure(err);
  }
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_TEXT_CHARS * 4) {
    throw new ToolFailure(`fs edit: "${path}" is too large for text editing (${text.length} chars).`, 'FS_TOO_LARGE');
  }
  return text;
}

function writeUtf8File(path: string, content: string): void {
  try {
    openGlobalVfs().writeFile(path, content);
  } catch (err) {
    toFsEditFailure(err);
  }
}

// ---------- fs.apply_edits ----------

export const fsApplyEdits: ToolHandler = async (params) => {
  const path = typeof params.path === 'string' ? params.path.trim() : '';
  if (!path) throw new ToolFailure('fs.apply_edits requires a non-empty string "path" (VFS-absolute).', 'INVALID_PARAMS');
  const editsRaw = params.edits;
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
    throw new ToolFailure('fs.apply_edits requires a non-empty "edits" array.', 'INVALID_PARAMS');
  }
  if (editsRaw.length > MAX_EDITS) {
    throw new ToolFailure(`fs.apply_edits accepts at most ${MAX_EDITS} edits per call (got ${editsRaw.length}).`, 'INVALID_PARAMS');
  }

  const content = readUtf8File(path);
  // §4.1 — validate the ENTIRE set first; overlapping/conflicting ranges abort
  // the whole call before anything is written.
  const ranges: EditRange[] = [];
  for (let i = 0; i < editsRaw.length; i++) {
    const e = editsRaw[i];
    if (typeof e !== 'object' || e === null) {
      throw new ToolFailure(`edits[${i}] must be an object.`, 'FS_EDITS_INVALID');
    }
    ranges.push(buildRange(content, e as Record<string, unknown>, i));
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new ToolFailure(
        `fs.apply_edits: overlapping/conflicting edits are rejected — ${sorted[i - 1].label} [${sorted[i - 1].start},${sorted[i - 1].end}) overlaps ${sorted[i].label} [${sorted[i].start},${sorted[i].end}). Split the call or fix the ranges.`,
        'FS_EDITS_OVERLAP',
      );
    }
  }

  const beforeSize = content.length;
  const { content: next, applied } = applyRanges(content, ranges);
  // single durable write — success is reported only after the write returned
  writeUtf8File(path, next);

  return {
    success: true,
    path,
    operation: 'apply_edits',
    changed: next !== content,
    editCount: ranges.length,
    beforeSize,
    afterSize: next.length,
    applied,
  };
};

// ---------- fs.find_replace ----------

/** Bounded regex scan — a pathological pattern cannot pin the runtime. */
function safeRegexReplace(
  content: string, pattern: string, flags: string, replacement: string, maxReplacements: number | null,
): { out: string; matchCount: number; replacementCount: number } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    throw new ToolFailure(
      `fs.find_replace: invalid regular expression "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
      'REGEX_INVALID',
    );
  }
  let matchCount = 0;
  let replacementCount = 0;
  let steps = 0;
  const out = content.replace(re, (...args) => {
    steps++;
    if (steps > MAX_REGEX_STEPS) {
      throw new ToolFailure(
        `fs.find_replace: the pattern exceeded ${MAX_REGEX_STEPS} match steps — refused to protect the runtime (narrow the pattern or the region).`,
        'REGEX_RISK',
      );
    }
    matchCount++;
    if (maxReplacements !== null && replacementCount >= maxReplacements) return String(args[0]);
    replacementCount++;
    return replacement;
  });
  return { out, matchCount, replacementCount };
}

export const fsFindReplace: ToolHandler = async (params) => {
  const path = typeof params.path === 'string' ? params.path.trim() : '';
  const find = typeof params.find === 'string' ? params.find : '';
  if (!path) throw new ToolFailure('fs.find_replace requires a non-empty string "path".', 'INVALID_PARAMS');
  if (!find) throw new ToolFailure('fs.find_replace requires a non-empty string "find".', 'INVALID_PARAMS');
  if (find.length > MAX_PATTERN_CHARS && params.regex === true) {
    throw new ToolFailure(`fs.find_replace: a regex pattern is capped at ${MAX_PATTERN_CHARS} characters.`, 'INVALID_PARAMS');
  }
  const replace = typeof params.replace === 'string' ? params.replace : '';
  const useRegex = params.regex === true;
  const caseSensitive = params.caseSensitive !== false;
  const maxReplacements = typeof params.maxReplacements === 'number' && Number.isInteger(params.maxReplacements) && params.maxReplacements > 0
    ? params.maxReplacements
    : null;

  const content = readUtf8File(path);

  // optional region — only the selected line span is edited
  let regionPrefix = '';
  let regionBody = content;
  let regionSuffix = '';
  const region = (params.region && typeof params.region === 'object') ? params.region as Record<string, unknown> : null;
  if (region) {
    const startLine = Number(region.startLine);
    const endLine = Number(region.endLine);
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) {
      throw new ToolFailure('fs.find_replace: region { startLine, endLine } must be positive integers with endLine >= startLine.', 'INVALID_PARAMS');
    }
    const start = offsetOfEndOfLine(content, startLine === 1 ? 1 : startLine - 1) + (startLine === 1 ? 0 : 1);
    const end = offsetOfEndOfLine(content, endLine);
    regionPrefix = content.slice(0, start);
    regionBody = content.slice(start, end);
    regionSuffix = content.slice(end);
  }

  let out: string;
  let matchCount = 0;
  let replacementCount = 0;
  if (useRegex) {
    const flags = `g${caseSensitive ? '' : 'i'}m`;
    const r = safeRegexReplace(regionBody, find, flags, replace, maxReplacements);
    out = r.out;
    matchCount = r.matchCount;
    replacementCount = r.replacementCount;
  } else if (caseSensitive) {
    let remaining = regionBody;
    const pieces: string[] = [];
    for (;;) {
      const idx = remaining.indexOf(find);
      if (idx === -1) break;
      matchCount++;
      if (maxReplacements === null || replacementCount < maxReplacements) {
        pieces.push(remaining.slice(0, idx), replace);
        replacementCount++;
        remaining = remaining.slice(idx + find.length);
      } else {
        pieces.push(remaining.slice(0, idx + find.length));
        remaining = remaining.slice(idx + find.length);
      }
    }
    pieces.push(remaining);
    out = pieces.join('');
  } else {
    const r = safeRegexReplace(regionBody, find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi', replace, maxReplacements);
    out = r.out;
    matchCount = r.matchCount;
    replacementCount = r.replacementCount;
  }

  const next = regionPrefix + out + regionSuffix;
  // §4.2 — an explicit zero-match request is a USEFUL result, not a fake success
  if (matchCount === 0) {
    return {
      success: true,
      path,
      operation: 'find_replace',
      changed: false,
      matchCount: 0,
      replacementCount: 0,
      beforeSize: content.length,
      afterSize: content.length,
      message: `No occurrence${useRegex ? 's of the pattern' : 's of the text'} found${region ? ' in the requested region' : ''} — the file was NOT modified.`,
    };
  }

  if (next !== content) writeUtf8File(path, next);
  return {
    success: true,
    path,
    operation: 'find_replace',
    changed: next !== content,
    matchCount,
    replacementCount,
    beforeSize: content.length,
    afterSize: next.length,
    message: replacementCount < matchCount ? `${matchCount} occurrence(s) found; only the first ${replacementCount} were replaced (maxReplacements).` : `${replacementCount} occurrence(s) replaced.`,
  };
};

// ---------- fs.insert_text ----------

export const fsInsertText: ToolHandler = async (params) => {
  const path = typeof params.path === 'string' ? params.path.trim() : '';
  const text = typeof params.text === 'string' ? params.text : '';
  if (!path) throw new ToolFailure('fs.insert_text requires a non-empty string "path".', 'INVALID_PARAMS');
  if (!text) throw new ToolFailure('fs.insert_text requires a non-empty string "text".', 'INVALID_PARAMS');
  if (text.length > MAX_TEXT_CHARS) throw new ToolFailure(`fs.insert_text: "text" exceeds ${MAX_TEXT_CHARS} characters.`, 'INVALID_PARAMS');

  const hasAt = params.at && typeof params.at === 'object';
  const hasAnchor = params.anchor && typeof params.anchor === 'object';
  if (hasAt === hasAnchor) {
    throw new ToolFailure('fs.insert_text requires exactly ONE of "at" ({ line, column? }) or "anchor" ({ find, occurrence?, position? }).', 'INVALID_PARAMS');
  }
  const content = readUtf8File(path);

  let start: number;
  let description: string;
  if (hasAt) {
    const at = params.at as Record<string, unknown>;
    const line = Number(at.line);
    if (!Number.isInteger(line) || line < 1) {
      throw new ToolFailure('fs.insert_text: at.line must be a positive integer (1-based).', 'FS_EDITS_INVALID');
    }
    const lines = content.split('\n');
    if (line > lines.length + 1) {
      throw new ToolFailure(`fs.insert_text: at.line ${line} is beyond the end of the file (${lines.length} line(s)). Use append for end-of-file insertion.`, 'FS_EDITS_INVALID');
    }
    start = offsetOf(content, { line, column: Number(at.column ?? 0) });
    description = `line ${line}, column ${Number(at.column ?? 0)}`;
  } else {
    const anchor = params.anchor as Record<string, unknown>;
    const find = typeof anchor.find === 'string' ? anchor.find : '';
    if (!find) throw new ToolFailure('fs.insert_text: anchor.find must be a non-empty string.', 'INVALID_PARAMS');
    const occurrence = Number.isInteger(Number(anchor.occurrence)) && Number(anchor.occurrence) > 0 ? Number(anchor.occurrence) : 1;
    const position = anchor.position === 'after' ? 'after' : 'before';
    let idx = -1;
    let from = 0;
    for (let i = 0; i < occurrence; i++) {
      idx = content.indexOf(find, from);
      if (idx === -1) break;
      from = idx + 1;
    }
    if (idx === -1 || occurrence > 1 && idx === -1) {
      throw new ToolFailure(
        `fs.insert_text: anchor ${JSON.stringify(find.slice(0, 80))} (occurrence ${occurrence}) was not found in "${path}".`,
        'FS_ANCHOR_NOT_FOUND',
      );
    }
    start = position === 'before' ? idx : idx + find.length;
    description = `${position} anchor occurrence ${occurrence}`;
  }

  const next = content.slice(0, start) + text + content.slice(start);
  writeUtf8File(path, next);
  return {
    success: true,
    path,
    operation: 'insert_text',
    changed: true,
    editCount: 1,
    beforeSize: content.length,
    afterSize: next.length,
    insertedAt: start,
    anchor: description,
  };
};

// ---------- fs.append_text ----------

export const fsAppendText: ToolHandler = async (params) => {
  const path = typeof params.path === 'string' ? params.path.trim() : '';
  const text = typeof params.text === 'string' ? params.text : '';
  if (!path) throw new ToolFailure('fs.append_text requires a non-empty string "path".', 'INVALID_PARAMS');
  if (!text) throw new ToolFailure('fs.append_text requires a non-empty string "text".', 'INVALID_PARAMS');
  if (text.length > MAX_TEXT_CHARS) throw new ToolFailure(`fs.append_text: "text" exceeds ${MAX_TEXT_CHARS} characters.`, 'INVALID_PARAMS');
  const ensureNewline = params.ensureNewline !== false;
  const createIfMissing = params.createIfMissing === true;

  const vfs = openGlobalVfs();
  let content = '';
  try {
    const raw = vfs.readFile(path, 'utf8');
    content = typeof raw === 'string' ? raw : raw.toString('utf8');
  } catch (err) {
    if (err instanceof VirtualFsError && err.code === 'ENOENT') {
      if (!createIfMissing) {
        throw new ToolFailure(`fs.append_text: "${path}" does not exist (pass createIfMissing: true to create it).`, 'FS_NOT_FOUND');
      }
      content = '';
    } else {
      toFsEditFailure(err);
    }
  }

  let appendage = text;
  if (ensureNewline && content.length > 0 && !content.endsWith('\n') && !appendage.startsWith('\n')) {
    appendage = `\n${appendage}`;
  }
  const next = content + appendage;
  writeUtf8File(path, next);
  return {
    success: true,
    path,
    operation: 'append_text',
    changed: true,
    editCount: 1,
    beforeSize: content.length,
    afterSize: next.length,
    created: content.length === 0,
  };
};

// ---------- definitions ----------

export const FS_EDIT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'fs.apply_edits',
    description: 'Applies one or more validated, non-overlapping edits to a VFS file in a single atomic write. Each edit: { op: replace_range|insert_at|remove_range, unit: line|offset, startLine/startColumn/endLine/endColumn or offset/length, text }. The whole set is validated first — overlapping or conflicting edits are rejected before anything is written.',
    purpose: 'Make precise multi-point changes to an existing file without rewriting it.',
    category: FS_EDIT_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        fp('path', 'string', true, 'VFS-absolute path of the file to edit (e.g. "/workspace/main.ts").'),
        fp('edits', 'array', true, '1..50 edit operations: { op, unit?, startLine?, startColumn?, endLine?, endColumn?, offset?, length?, text? }'),
        fp('text', 'string', false, 'Replacement/inserted text when provided at the top level of an edit object.'),
      ],
    },
  },
  {
    name: 'fs.find_replace',
    description: 'Finds and replaces text in a VFS file: literal or regex mode (safely bounded), case sensitivity toggle, optional line region, occurrence cap. Reports matchCount and replacementCount; a zero-match request returns an honest changed:false result.',
    purpose: 'Replace occurrences of a string or pattern across a file without manual line math.',
    category: FS_EDIT_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        fp('path', 'string', true, 'VFS-absolute path of the file.'),
        fp('find', 'string', true, 'Literal text or regex pattern to find.'),
        fp('replace', 'string', false, 'Replacement text (default empty = delete matches).'),
        fp('regex', 'boolean', false, 'Treat "find" as a regular expression (default false).'),
        fp('caseSensitive', 'boolean', false, 'Case-sensitive matching (default true).'),
        fp('maxReplacements', 'number', false, 'Replace at most N occurrences (default all).'),
        fp('region', 'object', false, 'Optional { startLine, endLine } — restrict the operation to those lines.'),
      ],
    },
  },
  {
    name: 'fs.insert_text',
    description: 'Inserts text into a VFS file at a precise location: either at { line, column } (1-based line, 0-based column) or before/after an { anchor: find } match with an optional occurrence number. The rest of the file is preserved.',
    purpose: 'Add content at an exact position without replacing existing text.',
    category: FS_EDIT_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        fp('path', 'string', true, 'VFS-absolute path of the file.'),
        fp('text', 'string', true, 'Text to insert.'),
        fp('at', 'object', false, '{ line, column? } — insert at a line/column position.'),
        fp('anchor', 'object', false, '{ find, occurrence?, position?: "before"|"after" } — insert relative to a matched anchor.'),
      ],
    },
  },
  {
    name: 'fs.append_text',
    description: 'Appends text to the end of a VFS file. Optionally normalizes the trailing newline (ensureNewline, default true) and can create the file when missing (createIfMissing, default false).',
    purpose: 'Add content to the end of an existing file (logs, sections, entries).',
    category: FS_EDIT_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        fp('path', 'string', true, 'VFS-absolute path of the file.'),
        fp('text', 'string', true, 'Text to append.'),
        fp('ensureNewline', 'boolean', false, 'Insert a leading newline when the file does not end with one (default true).'),
        fp('createIfMissing', 'boolean', false, 'Create the file when it does not exist (default false).'),
      ],
    },
  },
];
