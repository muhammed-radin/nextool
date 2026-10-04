/**
 * NexTool v1.0.4 §11-17 — tool portability (export/import as JSON).
 *
 * Pure, dependency-free module shared by the Tools view and the unit tests:
 *
 *   ToolDefinition (registry)
 *        ↓  exportToolJson / exportToolsJson
 *   Portable JSON on disk ({ name, description, functionSource, schema, … })
 *        ↓  parseToolImport → validateImportedTool
 *   Validated preview → registered via the REAL registry endpoints
 *
 * The exported JSON preserves the function source code AS TEXT (§12) using
 * the project's actual tool schema field names — never a placeholder. Import
 * validation (§14) rejects malformed files BEFORE anything is registered.
 */

import type { ToolEntry } from './api-contract';
import type { ToolParamDef, ToolSchema } from './types';

/** Marker describing the export envelope/version — read on import, advisory only. */
export const TOOL_EXPORT_KIND = 'nextool.tool';
export const TOOL_EXPORT_VERSION = 1;

/** The portable JSON shape of a single tool. */
export interface PortableTool {
  nexool?: { kind: string; version: number; appVersion?: string; exportedAt?: string };
  name: string;
  description: string;
  purpose?: string;
  category: string;
  /** v1.0.5: "nodejs" joins the portable set (§3.10) — validated on import.
   *  v1.0.11: "freedom-node" joins too — the environment string round-trips
   *  EXACTLY (§30); runtime authorization stays configuration-gated. */
  environment: 'js-function' | 'nodejs' | 'dynamic' | 'freedom-node' | string;
  toolVersion?: string;
  enabled?: boolean;
  /** The project's actual tool input schema (ToolParamDef[] wrapped). */
  schema: ToolSchema;
  /** The EXACT JavaScript function source, preserved as text. */
  functionSource?: string;
  /** dynamic handler tools only. */
  handlerKind?: string;
  handlerConfig?: Record<string, unknown>;
  /** v1.0.5 §2.8: structured user metadata round-trips through export/import. */
  metadata?: Record<string, string>;
  /** v1.0.6 §9.2/§23: per-tool auto-execute; absent ⇒ registered default false. */
  autoExecute?: boolean;
  /** v1.0.7 §1: tool-specific execution timeout (ms); absent ⇒ global default. */
  timeoutMs?: number;
}

// ---------- export ----------

/**
 * v1.0.12 §2.1 — tool source classification derived from the EXISTING
 * `environment` field (no duplicate ownership field was introduced — the
 * environment already encodes provenance):
 *   - 'builtin' → shipped system/runtime tools (builtin, virtual-env):
 *     VISIBLE but never exportable (§2.2).
 *   - 'custom'  → user-authored tools (dynamic, js-function, nodejs,
 *     freedom-node): exportable.
 *   - 'mcp'     → connector-backed imports: managed via Connectors, never
 *     exportable (their identity only makes sense with their server, and
 *     §1.7/§1.14 require that no connector data travels in exports).
 */
export type ToolExportClass = 'builtin' | 'custom' | 'mcp';

const CUSTOM_ENVIRONMENTS = new Set(['dynamic', 'js-function', 'nodejs', 'freedom-node']);

export function toolExportClass(environment: string): ToolExportClass {
  if (environment === 'mcp') return 'mcp';
  if (CUSTOM_ENVIRONMENTS.has(environment)) return 'custom';
  return 'builtin';
}

/** v1.0.12 §2.2 — ONLY custom-created tools may be exported. */
export function isToolExportable(entry: Pick<ToolEntry, 'environment'>): boolean {
  return toolExportClass(entry.environment) === 'custom';
}

/** Build the portable JSON for ONE tool from its live registry entry. */
export function exportToolJson(entry: ToolEntry, appVersion?: string): PortableTool {
  // Defense in depth (§2.2): built-ins and mcp tools never produce portable
  // JSON, even if a future caller forgets the UI gate.
  if (!isToolExportable(entry)) {
    throw new Error(
      toolExportClass(entry.environment) === 'mcp'
        ? `MCP tool ${entry.name} cannot be exported — it is connector-backed. Manage it from the Connectors page.`
        : `Built-in tool ${entry.name} cannot be exported — only custom-created tools are exportable.`,
    );
  }
  return {
    nexool: { kind: TOOL_EXPORT_KIND, version: TOOL_EXPORT_VERSION, ...(appVersion ? { appVersion } : {}), exportedAt: new Date().toISOString() },
    name: entry.name,
    description: entry.description,
    ...(entry.purpose ? { purpose: entry.purpose } : {}),
    category: entry.category,
    environment: entry.environment,
    ...(entry.toolVersion ? { toolVersion: entry.toolVersion } : {}),
    enabled: entry.enabled,
    schema: entry.schema ?? { type: 'object', properties: [] },
    ...(typeof entry.functionSource === 'string' ? { functionSource: entry.functionSource } : {}),
    ...(entry.handlerKind ? { handlerKind: entry.handlerKind } : {}),
    ...(entry.handlerConfig && Object.keys(entry.handlerConfig).length > 0 ? { handlerConfig: entry.handlerConfig } : {}),
    ...(entry.metadata && Object.keys(entry.metadata).length > 0 ? { metadata: entry.metadata } : {}),
    ...(entry.autoExecute === true ? { autoExecute: true } : {}),
    // v1.0.7 §1 — tool-specific execution timeout round-trips.
    ...(typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0 ? { timeoutMs: entry.timeoutMs } : {}),
  };
}

/** Build the portable JSON for MANY tools (an array of single-tool objects).
 *  v1.0.12 §2.2 — non-exportable tools (built-ins, mcp) are silently
 *  EXCLUDED here; callers surface the exclusion count in the UI. */
export function exportToolsJson(entries: ToolEntry[], appVersion?: string): PortableTool[] {
  return entries.filter((e) => isToolExportable(e)).map((e) => exportToolJson(e, appVersion));
}

/** Download filename for a tool export. */
export function toolExportFilename(name: string): string {
  return `${name.replace(/[^\w.-]+/g, '_')}.json`;
}

// ---------- import ----------

export interface ImportValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  tool: PortableTool | null;
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$/;
const PARAM_TYPES = ['string', 'number', 'boolean', 'object', 'array'];
/** v1.0.5 §3.10 — environments a portable tool file may declare.
 *  v1.0.11 §30 — freedom-node joins the set (import/export round trips
 *  preserve the environment exactly). */
const IMPORTABLE_ENVIRONMENTS = ['js-function', 'dynamic', 'nodejs', 'freedom-node'] as const;

/**
 * Parse + validate an imported tool JSON (§14/§15).
 * Accepts a single tool object; `null`/non-object input yields errors.
 * Every rejection reason is human-readable — nothing is registered malformed.
 */
export function validateImportedTool(raw: unknown): ImportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Not a tool definition — expected a single JSON object with name, description, schema and functionSource.'], warnings, tool: null };
  }
  const obj = raw as Record<string, unknown>;

  // name (§14)
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) errors.push('"name" is required (namespace.action, e.g. utility.summarize).');
  else if (!TOOL_NAME_RE.test(name)) errors.push(`"name" must match namespace.action with lowercase letters/digits/dots/dashes — got "${name}".`);

  // description
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (!description) errors.push('"description" is required so the CoreModule can match the tool.');

  // environment (default js-function)
  const environment = typeof obj.environment === 'string' && obj.environment ? obj.environment : 'js-function';
  if (!(IMPORTABLE_ENVIRONMENTS as readonly string[]).includes(environment)) {
    errors.push(`"environment" must be one of ${IMPORTABLE_ENVIRONMENTS.join(', ')} — got "${environment}". Read-only registry tools (builtin/virtual-env) cannot be imported; duplicate them into a function tool instead.`);
  }

  // function code — REQUIRED for all function environments (§12: source as text)
  const fnRaw = obj.functionSource ?? (obj as { function?: unknown }).function;
  const functionSource = typeof fnRaw === 'string' ? fnRaw : undefined;
  if (environment === 'js-function' || environment === 'nodejs' || environment === 'freedom-node') {
    if (!functionSource || !functionSource.trim()) {
      errors.push(`"functionSource" is required for ${environment} tools (the JavaScript source code as text).`);
    } else if (functionSource.length > 64_000) {
      errors.push(`"functionSource" exceeds the 64,000 character sandbox limit (${functionSource.length}).`);
    } else if (!/function\s+execute|execute\s*[:=]\s*(async\s*)?(function|\()|async\s+function\s+execute/.test(functionSource)) {
      warnings.push('The function source does not visibly define execute(params, context) — the sandbox calls execute().');
    }
  }

  // v1.0.5 §2.8 — structured metadata: flat string key/value pairs only.
  let metadata: Record<string, string> | undefined;
  if (obj.metadata !== undefined && obj.metadata !== null) {
    if (typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)) {
      const entries = Object.entries(obj.metadata as Record<string, unknown>);
      const bad = entries.find(([, v]) => typeof v !== 'string');
      if (bad) {
        errors.push(`"metadata["${bad[0]}"]" must be a string value — metadata is a flat string key/value record.`);
      } else if (entries.length > 50) {
        errors.push('"metadata" supports at most 50 key/value pairs.');
      } else {
        metadata = Object.fromEntries(entries) as Record<string, string>;
      }
    } else {
      errors.push('"metadata" must be a JSON object of string → string pairs.');
    }
  }

  // v1.0.6 §9.2/§23 — autoExecute round-trips; tools WITHOUT the field get the
  // documented default (false) at registration without invalidating the tool.
  const autoExecute = obj.autoExecute === undefined ? undefined : obj.autoExecute === true;

  // v1.0.7 §1 — tool-specific execution timeout: optional; when present it
  // must be an integer within [1000, 3600000] (default 10 s, max 1 hour).
  let timeoutMs: number | undefined;
  if (obj.timeoutMs !== undefined && obj.timeoutMs !== null) {
    const raw = typeof obj.timeoutMs === 'number' ? obj.timeoutMs : Number(obj.timeoutMs);
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1_000 || raw > 3_600_000) {
      errors.push('"timeoutMs" must be an integer between 1000 and 3600000 (default 10000 = 10 s, maximum 1 hour).');
    } else {
      timeoutMs = raw;
    }
  }

  // input schema — validate against the project's param rules (§14)
  let schema: ToolSchema | null = null;
  const schemaRaw = obj.schema ?? (obj as { inputSchema?: unknown }).inputSchema;
  if (schemaRaw === undefined) {
    errors.push('"schema" is required (the tool input schema: { type: "object", properties: [...] }).');
  } else {
    const parsed = validateSchemaJson(schemaRaw);
    if (typeof parsed === 'string') errors.push(parsed);
    else schema = parsed;
  }

  // dynamic handler fields
  let handlerKind: string | undefined;
  let handlerConfig: Record<string, unknown> | undefined;
  if (environment === 'dynamic') {
    handlerKind = typeof obj.handlerKind === 'string' ? obj.handlerKind : undefined;
    if (!handlerKind || !['echo', 'delay', 'http_get', 'uuid'].includes(handlerKind)) {
      errors.push('dynamic tools require "handlerKind" — one of echo, delay, http_get, uuid.');
    }
    if (obj.handlerConfig !== undefined) {
      if (obj.handlerConfig !== null && typeof obj.handlerConfig === 'object' && !Array.isArray(obj.handlerConfig)) {
        handlerConfig = obj.handlerConfig as Record<string, unknown>;
      } else {
        errors.push('"handlerConfig" must be a JSON object when present.');
      }
    }
  }

  const tool: PortableTool | null = errors.length === 0
    ? {
        name,
        description,
        ...(typeof obj.purpose === 'string' && obj.purpose.trim() ? { purpose: obj.purpose.trim() } : {}),
        category: typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : 'utility',
        environment,
        ...(typeof obj.toolVersion === 'string' && obj.toolVersion.trim() ? { toolVersion: obj.toolVersion.trim() } : {}),
        enabled: obj.enabled === undefined ? true : obj.enabled === true,
        schema: schema ?? { type: 'object', properties: [] },
        ...(environment !== 'dynamic' ? { functionSource } : {}),
        ...(handlerKind ? { handlerKind } : {}),
        ...(handlerConfig ? { handlerConfig } : {}),
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(autoExecute !== undefined ? { autoExecute } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }
    : null;

  return { ok: errors.length === 0, errors, warnings, tool };
}

/** Validate a schema value against the project's ToolParamDef rules. */
export function validateSchemaJson(raw: unknown): ToolSchema | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // Tolerate a bare array of param defs (the register dialog's format).
    if (Array.isArray(raw)) {
      return finishSchema(raw as unknown[]);
    }
    return '"schema" must be an object like { "type": "object", "properties": [...] }.';
  }
  const obj = raw as { type?: unknown; properties?: unknown };
  if (obj.type !== undefined && obj.type !== 'object') return '"schema.type" must be "object".';
  if (!Array.isArray(obj.properties)) return '"schema.properties" must be an array of param definitions.';
  return finishSchema(obj.properties);
}

function finishSchema(props: unknown[]): ToolSchema | string {
  const properties: ToolParamDef[] = [];
  for (const p of props) {
    if (p === null || typeof p !== 'object') return 'Every schema property must be an object with a "name".';
    const def = p as Record<string, unknown>;
    if (typeof def.name !== 'string' || !def.name.trim()) return 'Every schema property needs a non-empty "name".';
    if (!PARAM_TYPES.includes(String(def.type))) {
      return `Param "${def.name}": unsupported type "${String(def.type)}" (string|number|boolean|object|array).`;
    }
    if (def.enumValues !== undefined && !Array.isArray(def.enumValues)) {
      return `Param "${def.name}": enumValues must be an array.`;
    }
    properties.push({
      name: def.name.trim(),
      type: def.type as ToolParamDef['type'],
      required: def.required === true,
      description: typeof def.description === 'string' ? def.description : '',
      generation: def.generation as ToolParamDef['generation'],
      enumValues: def.enumValues as string[] | undefined,
      min: typeof def.min === 'number' ? def.min : undefined,
      max: typeof def.max === 'number' ? def.max : undefined,
      default: def.default,
    });
  }
  return { type: 'object', properties };
}

/**
 * Parse the CONTENTS of an imported JSON file (§13/§15). Accepts one tool
 * object; arrays and bundle wrappers are rejected with a pointed message
 * (multi-tool files are not part of the v1.0.4 import contract).
 */
export function parseToolImport(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON — ${err instanceof Error ? err.message : 'parse error'}` };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, error: 'The file contains an array — import one tool at a time (export a single tool to get the right format).' };
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { tools?: unknown }).tools)) {
    return { ok: false, error: 'The file looks like a multi-tool bundle — import one tool at a time.' };
  }
  return { ok: true, value: parsed };
}

/**
 * §16 — conflict resolution helper: propose a non-conflicting copy name
 * (base.copy, base.copy-2, base.copy-3, …).
 */
export function proposeCopyName(existing: Set<string>, original: string): string {
  const ns = original.includes('.') ? original.split('.')[0] : original;
  const base = `${ns}.copy`;
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

// ==================== v1.0.91 — bulk import (single object OR array) ====================

/**
 * Parse the CONTENTS of an imported JSON file for the v1.0.91 importer, which
 * accepts BOTH a single tool object AND an array of tool objects (the exact
 * shape `Export all tools (JSON)` produces — a complete round trip).
 *
 *  - JSON object        → { kind: 'single', value }   (one tool; validated next)
 *  - JSON array (n ≥ 1) → { kind: 'bulk', tools }     (bulk import; every item
 *                        is validated independently — nothing registers unless
 *                        the user confirms)
 *  - JSON array []      → { kind: 'bulk-empty' }      (surfaced honestly, the
 *                        import API is never called)
 *  - parse failure      → { ok: false, error }        (nothing is imported)
 *
 * The `{ tools: [...] }` bundle wrapper stays export-only (unchanged contract).
 * `parseToolImport` above keeps its single-tool semantics for compatibility.
 */
export type ParsedToolsImport =
  | { ok: true; kind: 'single'; value: unknown }
  | { ok: true; kind: 'bulk'; tools: unknown[] }
  | { ok: true; kind: 'bulk-empty' }
  | { ok: false; error: string };

export function parseToolsImport(text: string): ParsedToolsImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON file — ${err instanceof Error ? err.message : 'parse error'}` };
  }
  if (Array.isArray(parsed)) {
    return parsed.length === 0 ? { ok: true, kind: 'bulk-empty' } : { ok: true, kind: 'bulk', tools: parsed };
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { tools?: unknown }).tools)) {
    return { ok: false, error: 'The file looks like a multi-tool bundle — export a single tool or a plain JSON array of tools.' };
  }
  return { ok: true, kind: 'single', value: parsed };
}

/** One preview row of a bulk import (validation happens BEFORE registration). */
export interface BulkImportItem {
  /** 1-based position in the imported array (stable display order). */
  index: number;
  /** Best-effort name for the preview list, even when the item is invalid. */
  name: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** The normalized portable tool — set ONLY when valid. */
  tool: PortableTool | null;
}

/** How the user wants ONE conflicting bulk item handled. */
export type BulkConflictResolution = 'replace' | 'copy' | 'skip';

export interface BulkImportPlan {
  items: BulkImportItem[];
  validCount: number;
  invalidCount: number;
  /** Valid items whose name already exists in the live registry. */
  registryConflicts: { index: number; name: string }[];
  /** Names appearing 2+ times among the VALID items of this same file. */
  inFileDuplicates: { name: string; indices: number[] }[];
}

/** Best-effort display name for a raw import item (may be garbage). */
function rawItemName(raw: unknown, index: number): string {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const n = (raw as { name?: unknown }).name;
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  return `item #${index + 1}`;
}

/**
 * Validate EVERY item of a bulk import through the SAME pipeline as a
 * single-tool import (validateImportedTool) — before anything is registered.
 * Conflict/duplicate detection is computed here so the preview can show the
 * full picture up front:
 *
 *   Parse → Detect object vs array → Validate ALL → Preview → Resolve
 *   conflicts → User confirmation → Register
 *
 * An invalid item can therefore never become a registered tool by surprise.
 */
export function buildBulkImportPlan(raws: unknown[], existingNames: Iterable<string>): BulkImportPlan {
  const existing = new Set(existingNames);
  const items: BulkImportItem[] = raws.map((raw, i) => {
    const result = validateImportedTool(raw);
    return {
      index: i + 1,
      name: result.tool?.name ?? rawItemName(raw, i),
      valid: result.ok && result.tool !== null,
      errors: result.errors,
      warnings: result.warnings,
      tool: result.tool,
    };
  });

  const registryConflicts = items
    .filter((it) => it.valid && it.tool !== null && existing.has(it.tool.name))
    .map((it) => ({ index: it.index, name: it.tool!.name }));

  // Duplicate names INSIDE the same file (among valid items).
  const byName = new Map<string, number[]>();
  for (const it of items) {
    if (it.valid && it.tool) {
      const list = byName.get(it.tool.name) ?? [];
      list.push(it.index);
      byName.set(it.tool.name, list);
    }
  }
  const inFileDuplicates = [...byName.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([name, indices]) => ({ name, indices }));

  return {
    items,
    validCount: items.filter((it) => it.valid).length,
    invalidCount: items.filter((it) => !it.valid).length,
    registryConflicts,
    inFileDuplicates,
  };
}
