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
  environment: 'js-function' | 'dynamic' | string;
  toolVersion?: string;
  enabled?: boolean;
  /** The project's actual tool input schema (ToolParamDef[] wrapped). */
  schema: ToolSchema;
  /** The EXACT JavaScript function source, preserved as text. */
  functionSource?: string;
  /** dynamic handler tools only. */
  handlerKind?: string;
  handlerConfig?: Record<string, unknown>;
}

// ---------- export ----------

/** Build the portable JSON for ONE tool from its live registry entry. */
export function exportToolJson(entry: ToolEntry, appVersion?: string): PortableTool {
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
  };
}

/** Build the portable JSON for MANY tools (an array of single-tool objects). */
export function exportToolsJson(entries: ToolEntry[], appVersion?: string): PortableTool[] {
  return entries.map((e) => exportToolJson(e, appVersion));
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
  if (!['js-function', 'dynamic'].includes(environment)) {
    errors.push(`"environment" must be "js-function" or "dynamic" — got "${environment}". Read-only registry tools (builtin/virtual-env) cannot be imported; duplicate them into a js-function tool instead.`);
  }

  // function code — REQUIRED for js-function (§12: source preserved as text)
  const fnRaw = obj.functionSource ?? (obj as { function?: unknown }).function;
  const functionSource = typeof fnRaw === 'string' ? fnRaw : undefined;
  if (environment === 'js-function') {
    if (!functionSource || !functionSource.trim()) {
      errors.push('"functionSource" is required for js-function tools (the JavaScript source code as text).');
    } else if (functionSource.length > 64_000) {
      errors.push(`"functionSource" exceeds the 64,000 character sandbox limit (${functionSource.length}).`);
    } else if (!/function\s+execute|execute\s*[:=]\s*(async\s*)?(function|\()|async\s+function\s+execute/.test(functionSource)) {
      warnings.push('The function source does not visibly define execute(params, context) — the sandbox calls execute().');
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
        ...(environment === 'js-function' ? { functionSource } : {}),
        ...(handlerKind ? { handlerKind } : {}),
        ...(handlerConfig ? { handlerConfig } : {}),
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
