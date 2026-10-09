/**
 * NexTool LIMITATION PRESETS (v1.0.14 §18, extended by v1.1.0 §7).
 *
 * Two first-class presets for the Limitations page:
 *
 *  - "Standard / Default" — the SHIPPED configuration-limits JSON (snapshot
 *    below mirrors config/configuration-limits.json defaults as released in
 *    v1.0.14, extended with the v1.1.0 sections: coreModule, planner,
 *    terminal, vfsTerminal, skills, events, continuity).
 *
 *  - "Complete Unrestricted" — EVERY non-nullable numeric limit raised to
 *    its shipped maximum, every NULLABLE numeric limit set to null
 *    (documented "unlimited" semantics), every nullable list allowlist set
 *    to null (unrestricted) and every capability boolean opened. WARNING
 *    (rendered in the UI with a persistent warning): this removes runtime
 *    safety margins and should only be used intentionally in a trusted
 *    self-hosted environment. The preset writes REAL runtime configuration
 *    — it is not a visual-only toggle.
 *
 * SECURITY INVARIANT (unchanged): the preset can never weaken the actual
 * security boundaries — VFS sandbox isolation, the network host policy and
 * the sandbox escape guards are code-level and stay in force. `max` values
 * in the shipped file are the hard ceiling of the unrestricted preset.
 */

import type { ConfigurationLimits, LimitSection } from './config-limits';

/** The shipped standard/default configuration (authoritative snapshot). */
export const STANDARD_LIMITS_JSON = `{
  "version": 1,
  "$meta": {
    "name": "NexTool Q1 configuration limits",
    "description": "Single authoritative source for every configurable NexTool limit. A self-hosted administrator can customize the allowed range, default, type, unit and nullability of each setting by editing THIS file — no source-code modification or rebuild is required. The application validates min <= default <= max for every numeric property at startup and fails clearly when the file is invalid. Changing a limit requires no rebuild: new values are picked up after a reload/restart (see docs/configuration.md).",
    "notes": [
      "null means 'no explicit limit' ONLY for properties explicitly marked nullable — each nullable property documents exactly what null does. null is never interpreted as unlimited automatically.",
      "The security boundaries (virtual filesystem isolation, network host policy, sandbox escapes) are NOT controlled by this file and can never be weakened by raising a limit.",
      "Timeouts are intentionally separate properties: execution.timeoutMs governs the whole tool execution; network.timeoutMs governs one network request; childProcess.timeoutMs is the per-command default ceiling (the effective tool execution timeout raises it); task.toolTimeoutMs is the global tool default; task.taskTimeoutMs governs the whole task; coreModule.llmTimeoutMs governs one CoreModule LLM call; planner.llmTimeoutMs governs one Planner/Observer LLM call; terminal.execTimeoutMs governs one real-FS terminal command. Tool approval (300000 ms) and interactive prompts (120000 ms) are fixed runtime semantics, not configurable here.",
      "vfsTerminal.allowedCommands is a CAP list for the VFS shell only. null = every IMPLEMENTED VFS-shell command is permitted; an array = exactly those commands. It never weakens the VFS root boundary, which is code-enforced."
    ]
  },
  "network": {
    "timeoutMs": {"type": "integer", "nullable": false, "default": 60000, "min": 1000, "max": 3600000, "unit": "ms", "category": "network", "description": "Per-request network timeout for fetch/XHR/http(s)/URL imports/npm registry access. Default 60 seconds; the shipped maximum is 1 hour. The per-execution request timeout never exceeds the owning tool execution timeout."},
    "maxResponseBytes": {"type": "integer", "nullable": false, "default": 5242880, "min": 1024, "max": 734003200, "unit": "bytes", "category": "network", "description": "Maximum response body size (5 MiB default). Applies to fetch, XMLHttpRequest, virtual http/https, URL-imported modules and npm tarballs. The body download is aborted as soon as the cap is exceeded."},
    "maxRedirects": {"type": "integer", "nullable": false, "default": 56, "min": 0, "max": 56, "unit": "count", "category": "network", "description": "Maximum HTTP redirect hops per request (default 56). Every hop is re-validated against the protocol/host policy."},
    "maxRequestsPerExecution": {"type": "integer", "nullable": false, "default": 56, "min": 1, "max": 56, "unit": "count", "category": "network", "description": "Maximum network requests per tool execution (default 56). Counts fetch, XMLHttpRequest, virtual http/https requests, URL imports and npm registry/tarball downloads — every request goes through the same accounting."},
    "allowUrlImports": {"type": "boolean", "nullable": false, "default": true, "category": "network", "description": "Enable dynamic import() of http(s) URLs inside both tool environments (v1.0.8). Imported modules pass through the full network policy and run inside the same sandbox as the importing tool. Set false to disable URL imports without changing source code."},
    "selfOriginAccess": {"type": "boolean", "nullable": false, "default": true, "category": "network", "description": "Allow tool functions to call the NexTool application itself (v1.0.91): relative fetch URLs such as /api/tools/test resolve against the application origin, and requests to that exact origin are exempt from the local-host block ONLY. Every other policy limit (protocol, timeout, response size, redirects, per-execution request count) still applies, and all other local/private hosts stay blocked."}
  },
  "vfs": {
    "maxFileBytes": {"type": "integer", "nullable": false, "default": 2097152, "min": 1024, "max": 734003200, "unit": "bytes", "category": "vfs", "description": "Maximum size of ONE file in a tool's Virtual FS workspace (default 2 MiB). Also caps single reads/writes. Files that already exceed a lowered limit are preserved — new violating operations fail clearly."},
    "maxTotalBytes": {"type": "integer", "nullable": false, "default": 734003200, "min": 65536, "max": 734003200, "unit": "bytes", "category": "vfs", "description": "Maximum TOTAL size of one tool workspace, all files combined (default 700 MiB)."},
    "maxEntries": {"type": "integer", "nullable": false, "default": 4000, "min": 8, "max": 50000, "unit": "count", "category": "vfs", "description": "Maximum number of stored entries (files + directories) per tool workspace (default 4000)."},
    "maxDepth": {"type": "integer", "nullable": false, "default": 56, "min": 1, "max": 128, "unit": "levels", "category": "vfs", "description": "Maximum directory nesting depth (default 56 levels)."},
    "maxPathLength": {"type": "integer", "nullable": false, "default": 512, "min": 64, "max": 4096, "unit": "chars", "category": "vfs", "description": "Maximum length of a normalized virtual path in characters (default 512)."}
  },
  "execution": {
    "timeoutMs": {"type": "integer", "nullable": false, "default": 10000, "min": 250, "max": 3600000, "unit": "ms", "category": "execution", "description": "Tool execution timeout — default 10 seconds. Tool-specific timeoutMs overrides the global default; the max here (1 hour shipped) is the hard runtime ceiling no tool may bypass. Self-hosted administrators may raise the ceiling by editing THIS file."},
    "syncTimeoutMs": {"type": "integer", "nullable": false, "default": 4000, "min": 100, "max": 1800000, "unit": "ms", "category": "execution", "description": "Synchronous (non-awaiting) execution cap inside the sandbox — protects the server event loop from runaway synchronous loops (default 4 s, maximum 30 minutes)."},
    "heapSentinelBytes": {"type": "integer", "nullable": false, "default": 268435456, "min": 16777216, "max": 763363328, "unit": "bytes", "category": "execution", "description": "Heap-growth sentinel for nodejs tool executions (default 256 MiB, shipped maximum 728 MiB). This is a MONITOR, not an operating-system memory limit: it aborts the tool result when observed heap growth exceeds the value — memory already allocated is not revoked."},
    "maxSourceChars": {"type": "integer", "nullable": false, "default": 64000, "min": 1000, "max": 200000, "unit": "chars", "category": "execution", "description": "Maximum tool function source length in characters, applied to js-function and nodejs sources (default 64000, shipped maximum 200000)."},
    "maxResultBytes": {"type": "integer", "nullable": false, "default": 65536, "min": 1024, "max": 1048576, "unit": "bytes", "category": "execution", "description": "Maximum serialized JSON result size (default 64 KiB). Results above the cap are reported as NOT_SERIALIZABLE failures, never truncated silently."},
    "maxLogs": {"type": "integer", "nullable": false, "default": 100, "min": 10, "max": 1000, "unit": "lines", "category": "execution", "description": "Maximum captured console log lines per tool execution (default 100, shipped maximum 1000)."},
    "maxLogLineChars": {"type": "integer", "nullable": false, "default": 2000, "min": 200, "max": 8000, "unit": "chars", "category": "execution", "description": "Maximum characters of one captured log line (default 2000). Longer lines are truncated."}
  },
  "childProcess": {
    "timeoutMs": {"type": "integer", "nullable": false, "default": 8000, "min": 1000, "max": 3600000, "unit": "ms", "category": "child-process", "description": "Default per-command ceiling for virtual child_process commands (default 8 s). The effective tool execution timeout RAISES this ceiling for the execution (never shorter than this default); an explicit per-command timeout is clamped into [1, ceiling]."},
    "maxOutputBytes": {"type": "integer", "nullable": false, "default": 65536, "min": 1024, "max": 1048576, "unit": "bytes", "category": "child-process", "description": "Maximum combined stdout+stderr output of one virtual command (default 64 KiB). Excess output is discarded with a policy error."},
    "maxProcessesPerExecution": {"type": "integer", "nullable": false, "default": 64, "min": 1, "max": 512, "unit": "count", "category": "child-process", "description": "Maximum virtual command invocations (pipe stages count individually) per tool execution (default 64 — realistic multi-command workflows like npm init/install/run need far more than one digit; v1.0.6 shipped 4)."},
    "maxPipeStages": {"type": "integer", "nullable": false, "default": 3, "min": 1, "max": 16, "unit": "count", "category": "child-process", "description": "Maximum pipe stages in one virtual command line (default 3)."},
    "maxArgs": {"type": "integer", "nullable": false, "default": 32, "min": 4, "max": 512, "unit": "count", "category": "child-process", "description": "Maximum arguments of one virtual command stage (default 32)."},
    "npmMaxPackages": {"type": "integer", "nullable": false, "default": 25, "min": 1, "max": 200, "unit": "count", "category": "child-process", "description": "Maximum packages (including transitive dependencies) installed by one virtual npm install run (default 25). VFS limits still apply to the installed bytes."}
  },
  "task": {
    "maxIterations": {"type": "integer", "nullable": false, "default": 30, "min": 1, "max": 200, "unit": "count", "category": "task", "description": "Maximum planner iterations per task (default 30). Bounds both the Settings default and per-task configuration."},
    "maxSubtoolCalls": {"type": "integer", "nullable": false, "default": 20, "min": 1, "max": 200, "unit": "count", "category": "task", "description": "Maximum sub-tool calls per task (default 20)."},
    "safetyLimit": {"type": "integer", "nullable": false, "default": 100, "min": 1, "max": 500, "unit": "count", "category": "task", "description": "Task safety limit — total observed runtime actions before the task is force-stopped (default 100)."},
    "taskTimeoutMs": {"type": "integer", "nullable": false, "default": 120000, "min": 5000, "max": 3600000, "unit": "ms", "category": "task", "description": "Whole-task timeout (default 2 minutes). Intentionally separate from the tool execution timeout."},
    "toolTimeoutMs": {"type": "integer", "nullable": false, "default": 10000, "min": 1000, "max": 3600000, "unit": "ms", "category": "task", "description": "Global DEFAULT tool execution timeout applied when a tool does not define its own timeoutMs (default 10 s). The hard ceiling is execution.timeoutMs.max."},
    "liveIntervalMs": {"type": "integer", "nullable": false, "default": 60000, "min": 1000, "max": 3600000, "unit": "ms", "category": "task", "description": "Live Mode scheduler interval (default 60 s)."},
    "maxParallelToolCalls": {"type": "integer", "nullable": false, "default": 4, "min": 1, "max": 8, "unit": "count", "category": "task", "description": "Maximum tools executed concurrently in a parallel batch (default 4)."},
    "eventQueueCap": {"type": "integer", "nullable": false, "default": 50, "min": 1, "max": 500, "unit": "count", "category": "task", "description": "Maximum queued live events per task in multi-event mode (default 50). When full, the lowest-priority queued event is dropped (never silently)."},
    "prePlanMaxSteps": {"type": "integer", "nullable": false, "default": 10, "min": 1, "max": 122, "unit": "count", "category": "task", "description": "v1.0.10 — Maximum number of steps the pre-plan planner may generate (default 10, hard maximum 122). Bounds the Settings default and per-task configuration. Relevant to pre-plan planning only — one-by-one planning generates exactly one step per call."},
    "recoveryMaxAttempts": {"type": "integer", "nullable": false, "default": 4, "min": 2, "max": 4, "unit": "count", "category": "task", "description": "v1.0.11 — Maximum recovery attempts per failed pre-plan step (default 4, allowed range 2..4). One attempt = observe failure → recovery subgoal → recovery pre-plan → execute recovery steps → verify. Exhausted recovery ends the task honestly; one-by-one planning replans by design and does not consume recovery attempts."},
    "limitContinuations": {"type": "integer", "nullable": false, "default": 1, "min": 0, "max": 5, "unit": "count", "category": "task", "description": "v1.0.13 - Maximum safety-limit CONTINUATIONS per task (default 1, allowed range 0..5). When the task hits maxIterations/safetyLimit the runtime ASKS the operator instead of failing silently: continue = both limits grow by task.limitContinuationExtra and the task proceeds; deny/timeout = the task ends as limit_reached exactly as before. 0 disables the continuation question entirely."},
    "limitContinuationExtra": {"type": "integer", "nullable": false, "default": 25, "min": 1, "max": 500, "unit": "count", "category": "task", "description": "v1.0.13 - Budget granted to BOTH maxIterations and safetyLimit per granted safety-limit continuation (default 25, allowed range 1..500). Applied on top of the task's configured limits when the operator accepts a continuation."}
  },
  "coreModule": {
    "llmTimeoutMs": {"type": "integer", "nullable": true, "default": 300000, "min": 1000, "max": 3600000, "unit": "ms", "category": "core-module", "description": "v1.1.0 — Deadline for ONE CoreModule LLM decision call (default 5 minutes, replacing the removed hard-coded 25-second timeout). null = NO application-level timeout: the call runs until the provider answers or fails on its own. The configured deadline is reported in core diagnostics; slow generation is never treated as a provider failure before this deadline."},
    "liveOutputBufferBytes": {"type": "integer", "nullable": false, "default": 65536, "min": 4096, "max": 1048576, "unit": "bytes", "category": "core-module", "description": "v1.1.0 — Maximum retained bytes of streamed CoreModule Live Output per request (default 64 KiB). The buffer powers SSE replay after reconnect; older bytes past the cap are dropped from the replay window only — the final parsed decision is unaffected."}
  },
  "planner": {
    "llmTimeoutMs": {"type": "integer", "nullable": true, "default": 60000, "min": 1000, "max": 3600000, "unit": "ms", "category": "planner", "description": "v1.1.0 — Deadline for ONE Planner LLM call (pre-plan plan build or one-by-one step), replacing the removed hard-coded 25-second timeout. Intentionally separate from coreModule.llmTimeoutMs, task.taskTimeoutMs and tool timeouts. null = no application-level timeout."},
    "verifyTimeoutMs": {"type": "integer", "nullable": true, "default": 6000, "min": 500, "max": 3600000, "unit": "ms", "category": "planner", "description": "v1.1.0 — Deadline for the goal-verification LLM call (previously the hard-coded 6-second VERIFY_TIMEOUT_MS). null = no application-level timeout. When the deadline fires, verification falls back to the deterministic heuristic — it never aborts the task."},
    "recoveryMaxPlanSteps": {"type": "integer", "nullable": false, "default": 4, "min": 1, "max": 16, "unit": "count", "category": "planner", "description": "v1.1.0 — Maximum steps in one recovery pre-plan (previously the hard-coded RECOVERY_PLAN_MAX_STEPS = 4)."}
  },
  "terminal": {
    "maxSessions": {"type": "integer", "nullable": false, "default": 4, "min": 1, "max": 16, "unit": "count", "category": "terminal", "description": "v1.1.0 — Maximum concurrent real-FS terminal sessions (previously the hard-coded MAX_SESSIONS = 4)."},
    "execTimeoutMs": {"type": "integer", "nullable": true, "default": 300000, "min": 1000, "max": 3600000, "unit": "ms", "category": "terminal", "description": "v1.1.0 — Default timeout for ONE real-FS terminal command (default 5 minutes). null = no automatic timeout: commands run until they exit or the operator interrupts them. A timed-out command is terminated SIGTERM-first, then SIGKILL."},
    "maxOutputBytes": {"type": "integer", "nullable": false, "default": 1048576, "min": 65536, "max": 33554432, "unit": "bytes", "category": "terminal", "description": "v1.1.0 — Maximum combined stdout+stderr bytes retained per terminal command (default 1 MiB). Excess output is discarded and flagged in the command result — the process itself keeps running."},
    "historyLimit": {"type": "integer", "nullable": false, "default": 100, "min": 10, "max": 1000, "unit": "count", "category": "terminal", "description": "v1.1.0 — Maximum retained command-history entries per terminal session (navigable with Up/Down)."}
  },
  "vfsTerminal": {
    "allowedCommands": {"type": "array", "items": "string", "nullable": true, "default": ["pwd", "help", "clear", "ls", "cd", "cat", "mkdir", "touch", "rm", "cp", "mv", "find", "echo"], "category": "vfs", "description": "v1.1.0 — Commands the VFS shell accepts (enforced SERVER-SIDE against this list on every execution). null = every IMPLEMENTED VFS-shell command is permitted; an array = exactly those commands (unknown commands are rejected with a clear configuration error). This is an application cap for the shell UX — it never weakens the VFS root boundary, symlink refusal or path normalization, which are code-enforced."}
  },
  "skills": {
    "maxLoadedPerTask": {"type": "integer", "nullable": false, "default": 4, "min": 0, "max": 12, "unit": "count", "category": "skills", "description": "v1.1.0 — Maximum skills whose full instructions are loaded into one task prompt (previously the hard-coded cap of 4; 0 disables skill loading entirely)."},
    "maxInstructionChars": {"type": "integer", "nullable": false, "default": 6000, "min": 500, "max": 100000, "unit": "chars", "category": "skills", "description": "v1.1.0 — Maximum characters of one skill's instructions injected into a task prompt (previously the hard-coded 6000). Longer bodies are truncated with a visible marker."},
    "maxResourceBytes": {"type": "integer", "nullable": false, "default": 262144, "min": 1024, "max": 10485760, "unit": "bytes", "category": "skills", "description": "v1.1.0 — Maximum size of one skill resource file that may be read through the confined resource path (previously the hard-coded 256 KiB)."},
    "maxZipBytes": {"type": "integer", "nullable": false, "default": 8388608, "min": 10240, "max": 52428800, "unit": "bytes", "category": "skills", "description": "v1.1.0 — Maximum size of an uploaded skill ZIP import (previously the hard-coded 8 MiB)."}
  },
  "events": {
    "recentRingSize": {"type": "integer", "nullable": false, "default": 500, "min": 50, "max": 5000, "unit": "count", "category": "events", "description": "v1.1.0 — Size of the in-memory recent-events ring used for SSE replay after reconnect (previously the hard-coded 500)."},
    "maxDataBytes": {"type": "integer", "nullable": false, "default": 16384, "min": 1024, "max": 1048576, "unit": "bytes", "category": "events", "description": "v1.1.0 — Maximum serialized JSON payload of one event's data field (previously the hard-coded 16 KiB cap in the task loop). Larger payloads are trimmed with an explicit marker."}
  },
  "continuity": {
    "maxContextChars": {"type": "integer", "nullable": false, "default": 12000, "min": 2000, "max": 200000, "unit": "chars", "category": "continuity", "description": "v1.1.0 — Maximum characters of the prior-task context block injected into a Continue Task or forked task prompt. The block is built from the source task's result, observations, plan and history — never the unbounded raw history."},
    "maxExecutionRows": {"type": "integer", "nullable": false, "default": 12, "min": 0, "max": 100, "unit": "count", "category": "continuity", "description": "v1.1.0 — Maximum recent tool-execution rows summarized into a continuation/fork context block."},
    "maxObservations": {"type": "integer", "nullable": false, "default": 8, "min": 0, "max": 50, "unit": "count", "category": "continuity", "description": "v1.1.0 — Maximum recent observations carried into a continuation/fork context block."}
  },
  "fs": {
    "enabled": {"type": "boolean", "nullable": false, "default": true, "category": "freedom-node", "description": "v1.0.11 — Authorizes the freedom-node environment's unrestricted host capabilities (real filesystem, real network, child processes, process env). Configuration-file ONLY: the Settings UI deliberately exposes no control for this switch (fail closed when false — freedom-node executions are rejected)."},
    "restricted": {"type": "boolean", "nullable": false, "default": false, "category": "freedom-node", "description": "v1.0.11 — Marks the freedom-node filesystem mode as restricted or not. false (default) = freedom-node uses the REAL host filesystem and is never redirected into the restricted tool VFS; true would re-enable restrictions. Distinct from the vfs.* section, which governs the restricted virtual filesystem used by js-function/nodejs tools."}
  }
}
`;

/** Parse the shipped standard preset (throws when the snapshot itself breaks). */
export function standardPreset(): ConfigurationLimits {
  return JSON.parse(STANDARD_LIMITS_JSON) as ConfigurationLimits;
}

const OPENABLE_BOOLEANS = new Set([
  'network.allowUrlImports',
  'network.selfOriginAccess',
  'fs.enabled',
  'fs.restricted',
]);

/**
 * Build the "Complete Unrestricted" preset FROM a base limits object:
 * every non-nullable numeric `default` → its shipped `max`, every NULLABLE
 * numeric default → null (the documented unlimited semantics), every
 * nullable array allowlist → null (unrestricted), openable booleans → true
 * (`fs.restricted` → false = unrestricted real-fs profile). Sections/keys
 * unknown to the preset logic are preserved untouched.
 */
export function unrestrictedPreset(base?: ConfigurationLimits): ConfigurationLimits {
  const src: ConfigurationLimits = base ?? standardPreset();
  const out: ConfigurationLimits = JSON.parse(JSON.stringify(src)) as ConfigurationLimits;
  for (const [section, value] of Object.entries(out)) {
    if (section === 'version' || section === '$meta') continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const props = value as LimitSection;
    for (const [key, prop] of Object.entries(props)) {
      if (typeof prop !== 'object' || prop === null || Array.isArray(prop)) continue;
      const p = prop as unknown as Record<string, unknown>;
      if (p.type === 'integer' || p.type === 'number') {
        if (p.nullable === true) {
          p.default = null; // documented unlimited semantics
        } else if (typeof p.max === 'number' && typeof p.default === 'number') {
          p.default = p.max;
        }
      } else if (p.type === 'array' && p.nullable === true) {
        p.default = null; // unrestricted list (e.g. vfsTerminal.allowedCommands)
      } else if (p.type === 'boolean' && OPENABLE_BOOLEANS.has(`${section}.${key}`)) {
        p.default = key === 'restricted' ? false : true;
      }
    }
  }
  // mark the preset honestly in the metadata
  const meta = (out.$meta ??= {}) as { name?: string; notes?: string[] };
  meta.name = 'NexTool Q1 configuration limits — COMPLETE UNRESTRICTED (warning)';
  meta.notes = [
    ...(Array.isArray(meta.notes) ? meta.notes : []),
    'COMPLETE UNRESTRICTED preset: every non-nullable numeric limit is at its shipped maximum, nullable limits are null (unlimited), list allowlists are null (unrestricted) and capability booleans are fully open. This removes runtime safety margins — use ONLY intentionally in a trusted self-hosted environment.',
  ];
  return out;
}
