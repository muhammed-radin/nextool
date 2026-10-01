/**
 * NexTool v1.0.2 — Tool IDE IntelliSense declarations (spec §19-22).
 *
 * ONE shared declaration source consumed by the Monaco editor's JS defaults
 * (extraLib) AND rendered as the "References" pane in the Tool IDE. It
 * documents exactly the runtime API that exists in js-runner.ts — nothing
 * fabricated (spec §21).
 *
 * Schema-driven typing: `buildParamsDeclaration(schema)` turns the tool's
 * ToolSchema into a concrete `params` interface so `params.serverId` etc. get
 * real completion + type hints (spec §20).
 */

import type { ToolSchema } from './types';

const RUNTIME_DECLARATIONS = `
/**
 * NexTool js-function tool runtime (v1.0.2).
 *
 * Signature: async function execute(params, context) { ... return value; }
 * The sandbox exposes ONLY what is documented here — no require, no process,
 * no fetch, no timers (documented limitation, see docs/tool-development.md).
 */

/** Parameters validated against the tool schema (see the References pane). */
declare function execute(params: ToolParams, context: ToolContext): Promise<ToolResult> | ToolResult;

/** Structured log line — visible in the Tool IDE test panel (max 100 lines). */
declare function log(...parts: unknown[]): void;

/** What a tool may return — must be JSON-serializable (max 64 KiB, depth 12). */
type ToolResult = unknown;

interface ToolContext {
  /** Unique id of this execution (e.g. "exec_...", "test_..."). */
  executionId: string;
  /** Owning task id — null during Tool IDE test runs. */
  taskId: string | null;
  /** "test" for Tool IDE test runs, "production" for real task executions. */
  mode: 'test' | 'production';
  /** ISO timestamp at invocation. */
  now: string;
  /** Log helper — collected and shown in the test panel. */
  log: (...parts: unknown[]) => void;
}

// ---- available ES builtins inside the sandbox ----
declare const JSON: JSON;
declare const Math: Math;
declare const Date: DateConstructor;
declare const Number: NumberConstructor;
declare const String: StringConstructor;
declare const Boolean: BooleanConstructor;
declare const Array: ArrayConstructor;
declare const Object: ObjectConstructor;
declare const RegExp: RegExpConstructor;
declare const Error: ErrorConstructor;
declare const Map: MapConstructor;
declare const Set: SetConstructor;
declare const isNaN: (n: number) => boolean;
declare const isFinite: (n: number) => boolean;
declare const parseFloat: (s: string) => number;
declare const parseInt: (s: string, radix?: number) => number;
`;

/** JSON-schema-ish ToolParamDef → TS type. */
function paramType(type: string): string {
  switch (type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'Record<string, unknown>';
    case 'array': return 'unknown[]';
    default: return 'unknown';
  }
}

/**
 * Build a concrete `interface ToolParams` from the tool's schema so the editor
 * understands `params.<name>` (spec §20). Enum values become union types.
 */
export function buildParamsDeclaration(schema: ToolSchema | undefined | null): string {
  const props = schema?.properties ?? [];
  if (props.length === 0) {
    return 'interface ToolParams extends Record<string, unknown> {}\n';
  }
  const lines: string[] = ['/** Typed from the tool schema (Schema pane). */', 'interface ToolParams {'];
  for (const p of props) {
    let t = paramType(p.type);
    if (p.type === 'string' && p.enumValues && p.enumValues.length > 0) {
      t = p.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
    }
    const doc = p.description ? `  /** ${p.description}${p.generation ? ` (${p.generation})` : ''} */\n` : '';
    lines.push(`${doc}  ${p.name}${p.required ? '' : '?'}: ${t};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Full extraLib text for a tool: runtime API + schema-driven params. */
export function buildToolExtraLib(schema: ToolSchema | undefined | null): string {
  return `${RUNTIME_DECLARATIONS}\n${buildParamsDeclaration(schema)}`;
}

/** Human-readable reference entries rendered in the Tool IDE References pane. */
export function getReferenceEntries(schema: ToolSchema | undefined | null): {
  name: string; type: string; description: string;
}[] {
  return [
    { name: 'params', type: 'ToolParams', description: 'Validated tool parameters — typed from your schema below.' },
    { name: 'context.executionId', type: 'string', description: 'Unique id of this execution run.' },
    { name: 'context.taskId', type: 'string | null', description: 'Owning task id; null during Tool IDE tests.' },
    { name: 'context.mode', type: '"test" | "production"', description: 'Distinguishes Tool IDE test runs from real task executions.' },
    { name: 'context.now', type: 'string', description: 'ISO timestamp captured at invocation.' },
    { name: 'context.log(...)', type: '(...parts: unknown[]) => void', description: 'Log lines (max 100) surfaced in the test panel.' },
    ...(() => {
      const props = schema?.properties ?? [];
      if (props.length === 0) return [];
      return [{
        name: 'params.*',
        type: props.map((p) => `${p.name}${p.required ? '' : '?'}:${paramType(p.type)}`).join(' · '),
        description: 'Schema-derived parameters (typed in IntelliSense).',
      }];
    })(),
  ];
}
