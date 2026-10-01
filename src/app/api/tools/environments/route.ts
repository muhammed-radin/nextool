/**
 * GET /api/tools/environments — the REAL tool-environment configuration
 * (v1.0.5 §2.5/§3.6). The Tool IDE selector, handler-kind UI, Node.js
 * reference panel and IntelliSense all read THIS endpoint — there is no
 * hardcoded frontend copy of the runtime capabilities.
 *
 * Response shape (ToolEnvironmentInfo in client.ts):
 * {
 *   environments: [{ id, label, description, authorable, execution }],
 *   handlerKinds: [{ kind, label, description, configFields[] }],  // real registry
 *   functionSandbox: { timeoutMs, syncTimeoutMs, maxSourceChars, maxResultBytes, maxLogLines },
 *   node: {
 *     modules: { name: { description, methods[] } },   // the allowlist itself
 *     blocked: { name: reason },                        // §3.3 deliberate denials
 *     globals: [{ name, type, description }],
 *     limits: { timeoutMs, syncTimeoutMs, memoryLimitMb, maxSourceChars, maxResultBytes, maxLogLines, moduleAllowlist[] },
 *   },
 * }
 */
import { ok } from '@/lib/nexool/api-helpers';
import { HANDLER_KIND_INFO } from '@/lib/nexool/tools/registry';
import {
  NODE_MODULE_ALLOWLIST, NODE_BLOCKED_MODULES, NODE_SANDBOX_GLOBALS, NODE_EXECUTION_LIMITS,
} from '@/lib/nexool/tools/node-runner';
import { JS_TOOL_TIMEOUT_MS, MAX_FUNCTION_SOURCE_LENGTH, MAX_RESULT_BYTES } from '@/lib/nexool/tools/js-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return ok({
    environments: [
      {
        id: 'js-function',
        label: 'JavaScript sandbox',
        description: 'Restricted node:vm sandbox — async function execute(params, context). No require/import/process/timers.',
        authorable: true,
        execution: 'js-vm',
      },
      {
        id: 'nodejs',
        label: 'Node.js sandbox',
        description: 'Restricted Node.js environment — same execute contract plus require()/import() for the allowlisted modules only.',
        authorable: true,
        execution: 'node-vm',
      },
      {
        id: 'dynamic',
        label: 'Dynamic handler',
        description: 'Registered handler kind (echo/delay/http_get/uuid) with structured configuration — no custom code.',
        authorable: true,
        execution: 'handler',
      },
      {
        id: 'builtin',
        label: 'Built-in',
        description: 'Seeded runtime tools. Read-only — duplicate into a function tool to customize.',
        authorable: false,
        execution: 'handler',
      },
      {
        id: 'virtual-env',
        label: 'Virtual environment',
        description: 'Virtual server-fleet operations tools. Read-only.',
        authorable: false,
        execution: 'handler',
      },
    ],
    handlerKinds: HANDLER_KIND_INFO,
    functionSandbox: {
      timeoutMs: JS_TOOL_TIMEOUT_MS,
      syncTimeoutMs: 4000,
      maxSourceChars: MAX_FUNCTION_SOURCE_LENGTH,
      maxResultBytes: MAX_RESULT_BYTES,
      maxLogLines: 100,
    },
    node: {
      modules: NODE_MODULE_ALLOWLIST,
      blocked: NODE_BLOCKED_MODULES,
      globals: NODE_SANDBOX_GLOBALS,
      limits: NODE_EXECUTION_LIMITS,
    },
  });
}
