/**
 * GET /api/tools/environments — the REAL tool-environment configuration
 * (v1.0.5 §2.5/§3.6 · v1.0.6 §1.8/§5.1/§8). The Tool IDE selector, handler-kind
 * UI, capability matrix, Node.js reference panel and IntelliSense all read
 * THIS endpoint — there is no hardcoded frontend copy of the runtime
 * capabilities ("The reference must reflect the actual runtime").
 *
 * Response shape (ToolEnvironmentInfo in client.ts):
 * {
 *   environments: [{ id, label, description, authorable, execution }],
 *   handlerKinds: [{ kind, label, description, configFields[] }],  // real registry
 *   functionSandbox: { timeoutMs, syncTimeoutMs, maxSourceChars, maxResultBytes, maxLogLines },
 *   network: { allowedProtocols, requestTimeoutMs, maxResponseBytes, maxRedirects, maxRequestsPerExecution, urlImportsEnabled },
 *   vfs: { limits, workspaceDirectories },
 *   childProcess: { limits, virtualCommands },
 *   capabilities: [ { capability, jsFunction, nodejs } ],   // §8 capability matrix
 *   node: {
 *     modules: { name: { description, methods[], virtual? } },   // the allowlist itself
 *     blocked: { name: reason },                        // deliberate denials
 *     globals: [{ name, type, description }],
 *     limits: { timeoutMs, syncTimeoutMs, memoryLimitMb, maxSourceChars, maxResultBytes, maxLogLines, moduleAllowlist[], childProcess, virtualCommands[] },
 *   },
 * }
 */
import { ok } from '@/lib/nexool/api-helpers';
import { HANDLER_KIND_INFO } from '@/lib/nexool/tools/registry';
import {
  NODE_MODULE_ALLOWLIST, NODE_BLOCKED_MODULES, NODE_SANDBOX_GLOBALS, NODE_EXECUTION_LIMITS,
} from '@/lib/nexool/tools/node-runner';
import { syncTimeoutMs, maxFunctionSourceChars, maxResultBytes, maxLogLines } from '@/lib/nexool/tools/js-runner';
import { getNetworkPolicy } from '@/lib/nexool/tools/sandbox-net';
import { getVfsLimits, VFS_WORKSPACE_DIRECTORIES } from '@/lib/nexool/tools/vfs';
import { getChildProcessLimits, VIRTUAL_COMMANDS } from '@/lib/nexool/tools/virtual-child-process';
import { getLimitProperty, getResolvedLimits, getFreedomFsConfig } from '@/lib/nexool/config-limits';
import { isFreedomNodeAuthorized } from '@/lib/nexool/tools/freedom-node-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // v1.0.8 — every value below is resolved LIVE from the central limits
  // (config/configuration-limits.json). The UI reference panels can never show
  // stale hard-coded limits (spec §9.3/§9.5).
  const network = getNetworkPolicy();
  const vfs = getVfsLimits();
  const cp = getChildProcessLimits();
  const exec = getResolvedLimits().execution;
  return ok({
    environments: [
      {
        id: 'js-function',
        label: 'JavaScript sandbox',
        description: 'Restricted node:vm sandbox — async function execute(params, context). v1.0.6: fetch, XMLHttpRequest, async alert/prompt and timers included; require() resolves virtual-workspace modules only.',
        authorable: true,
        execution: 'js-vm',
      },
      {
        id: 'nodejs',
        label: 'Node.js sandbox',
        description: 'Restricted Node.js environment — same execute contract plus the Virtual FS, controlled http/https, a virtual child_process layer and require()/import() through the centralized import resolver.',
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
        // v1.0.11 §20/§22/§29 — the INTENTIONALLY UNRESTRICTED environment.
        id: 'freedom-node',
        label: 'Freedom Node (unrestricted)',
        description: 'Full host Node.js access. File system, network, processes, and host-level capabilities may be available. Requires the configuration-file fs gate (the Settings UI cannot grant it).',
        authorable: true,
        execution: 'freedom-node',
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
      timeoutMs: exec.timeoutMs,
      /** v1.0.8 §9.5 — the tool-editor timeout input derives its ceiling from
       *  the central limits (execution.timeoutMs.max — raiseable by admins). */
      timeoutMaxMs: getLimitProperty('execution', 'timeoutMs').max ?? 3_600_000,
      timeoutDefaultMs: getResolvedLimits().task.toolTimeoutMs,
      syncTimeoutMs: syncTimeoutMs(),
      maxSourceChars: maxFunctionSourceChars(),
      maxResultBytes: maxResultBytes(),
      maxLogLines: maxLogLines(),
    },
    // v1.0.8 §4 — the live network policy enforced by policyFetch (central limits).
    network: {
      allowedProtocols: network.allowedProtocols,
      requestTimeoutMs: network.timeoutMs,
      requestTimeoutNote: 'Default 60s (network.timeoutMs) — the effective request timeout follows the tool execution timeout (global → tool-specific, capped at the configured maximum).',
      maxResponseBytes: network.maxResponseBytes,
      maxRedirects: network.maxRedirects,
      maxRequestsPerExecution: network.maxRequestsPerExecution,
      urlImportsEnabled: network.urlImportsEnabled,
      // v1.0.91 — relative fetch URLs resolve against the application origin.
      selfOriginAccess: network.selfOriginAccess,
    },
    // v1.0.8 §5 — Virtual FS workspace + live limits (2 MiB / 700 MiB / 4000 / 56 shipped)
    vfs: {
      limits: vfs,
      workspaceDirectories: VFS_WORKSPACE_DIRECTORIES,
    },
    // v1.0.8 §3 — virtual child_process policy (expanded command set)
    childProcess: {
      limits: cp,
      virtualCommands: VIRTUAL_COMMANDS,
    },
    // v1.0.6 §8 + v1.0.8 — capability matrix, generated from the real runtime config.
    // v1.0.11 — the freedomNode column is the honest runtime state of the
    // unrestricted environment (gate state included; §29/§64).
    capabilities: [
      { capability: 'JavaScript standard APIs', jsFunction: 'Yes', nodejs: 'Yes', freedomNode: 'Yes' },
      { capability: 'fetch', jsFunction: 'Yes (policy-controlled)', nodejs: 'Yes (policy-controlled)', freedomNode: 'Yes (REAL network — no policy caps)' },
      { capability: 'XMLHttpRequest', jsFunction: 'Yes (async, policy-controlled)', nodejs: 'Yes (async, policy-controlled)', freedomNode: 'No (use fetch)' },
      { capability: 'async alert', jsFunction: 'Yes (runtime event)', nodejs: 'Yes (runtime event)', freedomNode: 'Yes (runtime event)' },
      { capability: 'async prompt', jsFunction: 'Yes (pauses the tool only)', nodejs: 'Yes (pauses the tool only)', freedomNode: 'Yes (pauses the tool only)' },
      { capability: 'async confirm', jsFunction: 'Yes (v1.0.8 — boolean result, pauses the tool)', nodejs: 'Yes (v1.0.8 — boolean result, pauses the tool)', freedomNode: 'Yes (boolean result, pauses the tool)' },
      { capability: 'Timers (setTimeout/setInterval)', jsFunction: 'Yes (deadline-bounded)', nodejs: 'Yes (deadline-bounded)', freedomNode: 'Yes (deadline-bounded — task lifecycle)' },
      { capability: 'Virtual FS', jsFunction: 'VFS modules via require()/import() only', nodejs: 'Full VFS API (fs module)', freedomNode: 'No — freedom-node uses the REAL filesystem' },
      { capability: 'require()', jsFunction: 'Restricted (VFS modules only)', nodejs: 'Yes — allowlist + virtual modules', freedomNode: 'Yes — REAL Node builtins + npm packages' },
      { capability: 'Dynamic import()', jsFunction: 'Yes (v1.0.8 — URL via network policy + VFS)', nodejs: 'Yes — allowlist + VFS + URL (policy)', freedomNode: 'Yes — REAL ESM import (no URL restrictions)' },
      { capability: 'URL imports', jsFunction: 'Yes (policy-controlled, enabled by default)', nodejs: 'Yes (policy-controlled, enabled by default)', freedomNode: 'Yes — unrestricted' },
      { capability: 'Node APIs', jsFunction: 'None', nodejs: 'Expanded safe set', freedomNode: 'ALL (host runtime)' },
      { capability: 'fs', jsFunction: 'No', nodejs: 'Virtual FS only', freedomNode: 'REAL host filesystem (fs config gate)' },
      { capability: 'http / https', jsFunction: 'No (use fetch)', nodejs: 'Controlled network layer', freedomNode: 'Yes — real modules, unrestricted' },
      { capability: 'child_process', jsFunction: 'No', nodejs: 'Restricted virtual commands + node + npm', freedomNode: 'Yes — REAL host processes' },
      { capability: 'node', jsFunction: 'No', nodejs: 'Yes (v1.0.8 — sandboxed program execution inside the VFS)', freedomNode: 'Yes — real node' },
      { capability: 'npm', jsFunction: 'No', nodejs: 'Yes (v1.0.8 — init/install/uninstall/run/ls inside the VFS workspace)', freedomNode: 'Yes — real npm packages' },
      { capability: 'Host filesystem', jsFunction: 'No', nodejs: 'No', freedomNode: 'Yes — by design (fs gate)' },
      { capability: 'process', jsFunction: 'No', nodejs: 'No', freedomNode: 'Yes — real process (incl. env)' },
      { capability: 'net / dgram / dns', jsFunction: 'No', nodejs: 'No', freedomNode: 'Yes — real modules' },
      { capability: 'cluster / vm / worker_threads', jsFunction: 'No', nodejs: 'No', freedomNode: 'Yes — real modules' },
    ],
    // v1.0.11 — freedom-node runtime reference (§29: the IDE reference reflects
    // the ACTUAL runtime, including the honest gate state).
    freedomNode: {
      enabled: isFreedomNodeAuthorized(),
      fsConfig: getFreedomFsConfig(),
      note: 'Intentionally unrestricted. Authorized ONLY by the fs section of config/configuration-limits.json (configuration-file gate — the Settings UI cannot enable it; fail closed).',
      preservedLimits: {
        timeoutMs: exec.timeoutMs,
        timeoutMaxMs: getLimitProperty('execution', 'timeoutMs').max ?? 3_600_000,
        syncTimeoutMs: syncTimeoutMs(),
        maxSourceChars: maxFunctionSourceChars(),
        maxResultTransportBytes: 5 * 1024 * 1024,
        maxLogLines: maxLogLines(),
        note: 'Task-lifecycle bounds only (deadline, vm sync cap, result transport, log caps) — the Network Policy/VFS/request restrictions do NOT apply.',
      },
    },
    node: {
      modules: NODE_MODULE_ALLOWLIST,
      blocked: NODE_BLOCKED_MODULES,
      globals: NODE_SANDBOX_GLOBALS,
      limits: NODE_EXECUTION_LIMITS,
    },
  });
}
