/**
 * NexTool v1.0.12 — MCP ⇄ NexTool schema conversion (spec §1.13).
 *
 * Imported MCP tools must present their FULL input schema to the CoreModule
 * in NexTool's native shape — properties, types, required flags, descriptions,
 * enums, nested objects, array items and defaults are preserved, never
 * discarded. MCP inputSchemas are standard JSON Schema (draft 2020-12); the
 * top-level properties map onto NexTool `ToolParamDef`s one-to-one, and every
 * piece of JSON Schema that has no first-class NexTool slot (nested
 * `properties`, `items`, `format`, `additionalProperties`, …) round-trips
 * losslessly inside the per-param `jsonSchema` block (added in types.ts in
 * v1.0.12, ignored by runtimes that do not know it).
 *
 * Pure, dependency-free module — shared by the connector manager, the UI and
 * the unit tests.
 */

import crypto from 'node:crypto';
import type { ToolParamDef, ToolParamType, ToolSchema } from '../types';

/** A raw MCP tool as returned by `client.listTools()`. */
export interface McpToolDescription {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema object describing the tool's input arguments. */
  inputSchema?: unknown;
  /** Opaque server hints (e.g. _meta) — carried through untouched. */
  [key: string]: unknown;
}

const NEXOOL_TYPES: ToolParamType[] = ['string', 'number', 'boolean', 'object', 'array'];

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Map one JSON Schema type to the NexTool param type (unknown → string). */
export function jsonSchemaTypeToNexoolType(type: unknown): ToolParamType {
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'object';
  if (type === 'array') return 'array';
  return 'string';
}

/**
 * Convert ONE JSON Schema property into a NexTool ToolParamDef.
 * Everything not expressible natively is preserved in `jsonSchema`.
 */
export function jsonSchemaPropertyToParamDef(name: string, schema: unknown, required: boolean): ToolParamDef {
  const s = asObject(schema) ?? {};
  const type = jsonSchemaTypeToNexoolType(s.type);
  const def: ToolParamDef = {
    name,
    type,
    required,
    description: typeof s.description === 'string' ? s.description : '',
  };
  if (Array.isArray(s.enum)) {
    // enumValues is string[] — non-string enum members are stringified so the
    // values remain visible to the CoreModule and the UI.
    def.enumValues = s.enum.map((v) => (typeof v === 'string' ? v : String(v)));
  }
  if (typeof s.minimum === 'number') def.min = s.minimum;
  if (typeof s.maximum === 'number') def.max = s.maximum;
  if (s.default !== undefined) def.default = s.default;

  // Preserve the FULL original JSON Schema for this property (nested objects,
  // array items, formats, patterns, additionalProperties, …). The original
  // object is kept verbatim — information loss is not acceptable (§1.13).
  def.jsonSchema = s;

  return def;
}

/**
 * Convert an MCP tool `inputSchema` into NexTool's ToolSchema.
 * Accepts any input: non-object schemas yield an empty properties list (an
 * MCP tool without arguments is legitimate), broken property shapes are
 * skipped individually so one malformed property cannot hide the rest.
 */
export function mcpInputSchemaToNexoolSchema(inputSchema: unknown): ToolSchema {
  const s = asObject(inputSchema);
  if (!s) return { type: 'object', properties: [] };
  const props = asObject(s.properties);
  if (!props) return { type: 'object', properties: [] };
  const required = new Set(Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
  const properties: ToolParamDef[] = [];
  for (const [name, propSchema] of Object.entries(props)) {
    properties.push(jsonSchemaPropertyToParamDef(name, propSchema, required.has(name)));
  }
  return { type: 'object', properties };
}

/**
 * Deterministic hash of a remote tool schema — used by Refresh tools (§1.16)
 * to detect whether the server-side schema actually changed. Hash covers the
 * FULL inputSchema (stable key ordering) so nested changes are detected too.
 */
export function hashInputSchema(inputSchema: unknown): string {
  const stable = stableStringify(inputSchema ?? null);
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

/** Stable JSON stringify (sorted object keys, arrays in order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Refresh diff (§1.16): compare a stored param list against the re-converted
 * one. Returns a human-readable change list — the caller decides how to merge
 * while PRESERVING local metadata.
 */
export interface SchemaRefreshDiff {
  changed: boolean;
  added: string[];
  removed: string[];
  changedParams: string[];
  summary: string;
}

export function diffNexoolSchemas(before: ToolSchema, after: ToolSchema): SchemaRefreshDiff {
  const beforeMap = new Map(before.properties.map((p) => [p.name, p]));
  const afterMap = new Map(after.properties.map((p) => [p.name, p]));
  const added = after.properties.filter((p) => !beforeMap.has(p.name)).map((p) => p.name);
  const removed = before.properties.filter((p) => !afterMap.has(p.name)).map((p) => p.name);
  const changedParams: string[] = [];
  for (const [name, beforeDef] of beforeMap) {
    const afterDef = afterMap.get(name);
    if (!afterDef) continue;
    // Compare the meaningful projection (the full jsonSchema block covers
    // nested changes; hash the stable projection of both defs).
    const projBefore = stableStringify(projectForCompare(beforeDef));
    const projAfter = stableStringify(projectForCompare(afterDef));
    if (projBefore !== projAfter) changedParams.push(name);
  }
  const changed = added.length > 0 || removed.length > 0 || changedParams.length > 0;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added: ${added.join(', ')}`);
  if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`);
  if (changedParams.length > 0) parts.push(`changed: ${changedParams.join(', ')}`);
  return { changed, added, removed, changedParams, summary: changed ? parts.join(' · ') : 'schema unchanged' };
}

/** The projection compared on refresh (excludes volatile presentation noise). */
function projectForCompare(def: ToolParamDef): unknown {
  return {
    name: def.name,
    type: def.type,
    required: def.required,
    description: def.description,
    enumValues: def.enumValues,
    min: def.min,
    max: def.max,
    default: def.default === undefined ? null : def.default,
    jsonSchema: def.jsonSchema ?? null,
  };
}
