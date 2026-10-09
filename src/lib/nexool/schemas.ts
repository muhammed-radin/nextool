/**
 * NexTool Q1 v1.0.1 — centralized request validation schemas (zod).
 *
 * ONE validation surface shared by all mutating API routes (spec §53/§54):
 * clear, structured validation errors; server-side clamping mirrors the
 * settings/runtime limits; nothing from the frontend is trusted implicitly.
 *
 * v1.0.8 (§8.4/§9.2/§10.1): every NUMERIC min/max is derived from the CENTRAL
 * configuration limits (config/configuration-limits.json) — backend validation
 * uses the same resolved limits as the Settings UI and the runtime (spec §8.5:
 * frontend, backend and runtime must all agree). No hard-coded limit copies.
 *
 * Error codes are kept backwards compatible with the v1.0.0 contract:
 * INVALID_REQUEST (tasks) / INVALID_PARAMS (everything else) / INVALID_MANIFEST.
 */

import { z } from 'zod';
import { getLimitProperty } from './config-limits';

/** Numeric bounds for one property, resolved from the central limits.
 *  Falls back to the shipped values only when the limits file cannot be read
 *  at module-load time (the loader fails clearly on invalid files). */
function limitBounds(section: string, key: string, fallbackMin: number, fallbackMax: number): { min: number; max: number } {
  try {
    const prop = getLimitProperty(section, key);
    return {
      min: typeof prop.min === 'number' ? prop.min : fallbackMin,
      max: typeof prop.max === 'number' ? prop.max : fallbackMax,
    };
  } catch {
    return { min: fallbackMin, max: fallbackMax };
  }
}

/** Integer zod validator bounded by the central limits (task.* by default). */
function intLimit(key: string, fallbackMin: number, fallbackMax: number, section = 'task') {
  const { min, max } = limitBounds(section, key, fallbackMin, fallbackMax);
  return z.number().int().min(min).max(max);
}

/** Function-source length cap (execution.maxSourceChars). */
function maxSourceChars(): number {
  return limitBounds('execution', 'maxSourceChars', 1000, 200_000).max;
}

/** Tool-specific execution timeout bounds: min from task.toolTimeoutMs,
 *  max from execution.timeoutMs (the runtime hard ceiling). */
function toolTimeoutValidator() {
  const min = limitBounds('task', 'toolTimeoutMs', 1_000, 3_600_000).min;
  const max = limitBounds('execution', 'timeoutMs', 1_000, 3_600_000).max;
  return z.number().int().min(min).max(max);
}

/** v1.0.9 §14.8 — Network Policy request-timeout bounds: min/max resolve from
 *  the central network.timeoutMs metadata so the frontend schema, the backend
 *  API and the runtime clamp agree on the SAME limits (no frontend-only max). */
function networkTimeoutValidator() {
  const { min, max } = limitBounds('network', 'timeoutMs', 1_000, 3_600_000);
  return z.number().int().min(min).max(max);
}

/** Collect "field: message" pairs from a zod error into one readable string. */
export function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
}

// ---------- primitives ----------

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const eventType = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/, 'must start with a letter and contain only letters, digits, dot, underscore or dash');

const jsonObject = z.record(z.string(), z.unknown());

// ---------- tasks ----------

export const taskConfigSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    mode: z.enum(['goal', 'live']),
    reasoningLevel: z.number().int().min(1).max(6),
    // v1.0.4 §23/§24 — when tools are provided they must be a NON-empty list:
    // an explicit empty selection (`enabledTools: []`) is rejected so neither
    // the console nor a raw API call can bypass tool selection.
    enabledTools: z.array(z.string().trim().min(1).max(160)).min(1).max(200).optional(),
    useMemory: z.boolean().optional(),
    learnFrom: z
      .object({ feedback: z.boolean().optional(), results: z.boolean().optional() })
      .optional(),
    autoExecuteSubtools: z.boolean().optional(),
    maxSubtoolCalls: intLimit('maxSubtoolCalls', 1, 200),
    safetyLimit: intLimit('safetyLimit', 1, 500),
    maxIterations: intLimit('maxIterations', 1, 200),
    taskTimeoutMs: intLimit('taskTimeoutMs', 5_000, 3_600_000),
    // v1.0.7 §1 — task-level tool timeout default, ceiling = execution.timeoutMs.max.
    toolTimeoutMs: toolTimeoutValidator(),
    // v1.0.9 §14 — task-level Network Policy request timeout (undefined =
    // inherit tool policy → global Settings → shipped default).
    networkTimeoutMs: networkTimeoutValidator().optional(),
    liveIntervalMs: intLimit('liveIntervalMs', 1_000, 3_600_000),
    parallelToolCalls: z.boolean().optional(),
    maxParallelToolCalls: intLimit('maxParallelToolCalls', 1, 8).optional(),
    // v1.0.6 §13 — task-level overrides (undefined = inherit global → tool)
    autoExecuteTools: z.boolean().optional(),
    allowMultipleEvents: z.boolean().optional(),
    // v1.0.10 §13/§19 — per-task planner override + pre-plan step limit.
    // Server-side validation enforces plannerType ∈ {pre-plan, one-by-one}
    // and prePlanMaxSteps within the central task.prePlanMaxSteps bounds
    // (shipped 1..122). Invalid values are REJECTED (never clamped here).
    plannerType: z.enum(['pre-plan', 'one-by-one']).optional(),
    prePlanMaxSteps: intLimit('prePlanMaxSteps', 1, 122).optional(),
    // v1.0.11 §8 — per-task recovery attempt cap, bounded by the central
    // task.recoveryMaxAttempts limits (shipped 2..4). REJECTED (not clamped)
    // when out of range — same contract as prePlanMaxSteps.
    recoveryMaxAttempts: intLimit('recoveryMaxAttempts', 2, 4).optional(),
    // v1.0.13 — per-task safety-limit continuation cap (0..5, default 1;
    // 0 disables the continuation question for this task). REJECTED (not
    // clamped) when out of range — same contract as recoveryMaxAttempts.
    limitContinuations: intLimit('limitContinuations', 0, 5).optional(),
    sessionId: z.string().trim().max(200).optional(),
    context: jsonObject.optional(),
    // v1.1.0 §2 — Continue Task: the NEW task's id relationship to the
    // ORIGINAL terminal task (never mutated). Stored in config so the
    // Task Preview can show the lineage.
    continuationOfTaskId: z.string().trim().regex(/^task_[a-z0-9]+$/).optional(),
    // v1.1.0 §3 — fork-from-recent: the SOURCE task a new independent task
    // was branched from (old tool calls are never replayed).
    forkedFromTaskId: z.string().trim().regex(/^task_[a-z0-9]+$/).optional(),
    // v1.1.0 §3.2 — which context classes to reuse from the source task.
    contextOptions: z
      .object({
        result: z.boolean().optional(),
        plan: z.boolean().optional(),
        executions: z.boolean().optional(),
        memory: z.boolean().optional(),
        skills: z.boolean().optional(),
      })
      .partial()
      .strict()
      .optional(),
    // v1.1.0 §8 — manual skill selection + selection mode.
    skills: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
    skillsMode: z.enum(['auto', 'manual', 'auto+manual']).optional(),
    // v1.1.0 §10 — pre-plan only: keep executing remaining planned steps
    // after the goal is verified (default false = normal early completion).
    executeAllPlannedSteps: z.boolean().optional(),
  })
  .partial()
  .strict();

/** POST /api/tasks — accepts { request, config? }; legacy flat mode/reasoningLevel still tolerated. */
export const createTaskSchema = z
  .object({
    // v1.0.11 §45 — large task descriptions: the cap moves 8 000 → 32 000
    // chars so Markdown-heavy, multi-section requests are not truncated.
    request: nonEmpty(32000),
    config: taskConfigSchema.optional(),
    mode: z.enum(['goal', 'live']).optional(),
    reasoningLevel: z.number().int().min(1).max(6).optional(),
    // v1.0.12 Phase 7 — custom task instructions from the Task Console:
    // `uploadedMarkdown` = content of an uploaded/drag-dropped .md file,
    // `text` = free-form textarea content. Both optional; when both are
    // present they are COMBINED deterministically server-side (spec §7.4) —
    // neither source is silently discarded. Markdown is instruction/context
    // content only and is never executed (spec §7.2).
    instructions: z
      .object({
        uploadedMarkdown: z.string().max(120_000).optional(),
        text: z.string().max(60_000).optional(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

/** POST /api/tasks/:id/event */
export const taskEventSchema = z
  .object({
    type: eventType,
    payload: jsonObject.optional(),
    priority: z.number().int().min(1).max(9).optional(),
    source: z
      .enum(['runtime', 'planner', 'observer', 'core', 'tool', 'environment', 'user', 'system'])
      .optional(),
  })
  .strict();

/** POST /api/tasks/:id/feedback */
export const taskFeedbackSchema = z
  .object({
    message: nonEmpty(4000),
    correctAction: z.string().trim().max(2000).optional(),
  })
  .strict();

// ---------- environment ----------

/** POST /api/env/event */
export const envEventSchema = z
  .object({
    type: z.enum(['server.crash', 'server.degrade', 'server.recover']),
    serverId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

// ---------- tools ----------

export const toolParamDefSchema = z
  .object({
    name: nonEmpty(80),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    required: z.boolean(),
    description: nonEmpty(500),
    generation: z.enum(['extractive', 'constructive']).optional(),
    enumValues: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.unknown().optional(),
  })
  .strict();

export const toolDefinitionSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'must look like namespace.action (letters, digits, dot, dash, underscore)'),
    description: nonEmpty(1000),
    purpose: z.string().trim().max(1000).optional(),
    category: nonEmpty(60),
    // v1.0.11 — freedom-node joins the environment set (rejected by
    // registerDynamicTool with a pointed message — freedom-node tools
    // register via /api/tools/js like the other function environments).
    environment: z.enum(['builtin', 'virtual-env', 'dynamic', 'js-function', 'nodejs', 'freedom-node']),
    schema: z.object({ type: z.literal('object'), properties: z.array(toolParamDefSchema).max(40) }).strict(),
  })
  .strict();

/** POST /api/tools/register (also POST /api/tools alias) */
export const registerToolSchema = z
  .object({
    definition: toolDefinitionSchema,
    handlerKind: z.enum(['echo', 'delay', 'http_get', 'uuid']).optional(),
    handlerConfig: jsonObject.optional(),
  })
  .strict();

/** POST /api/tools/:name/toggle */
export const toggleToolSchema = z.object({ enabled: z.boolean() }).strict();

// ---------- memory ----------

/** POST /api/memory */
export const memorySchema = z
  .object({
    key: nonEmpty(200),
    value: z.unknown(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    source: z.string().trim().max(64).optional(),
  })
  .strict();

// ---------- datasets ----------

export const datasetExampleSchema = z
  .object({
    category: nonEmpty(80),
    // v1.0.11 §46 — training examples may carry large Markdown documents:
    // cap moves 8 000 → 32 000 chars (mirrors the task request cap).
    request: nonEmpty(32000),
    expectedTool: z.string().trim().max(160).optional(),
    expectedParams: jsonObject.optional(),
    split: z.enum(['train', 'validation', 'test']).optional(),
  })
  .strict();

/** POST /api/datasets/import */
export const datasetImportSchema = z
  .object({
    name: nonEmpty(120),
    version: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^\d+\.\d+\.\d+/, 'must be semver-like (e.g. 1.0.0)'),
    examples: z.array(datasetExampleSchema).min(1).max(5000),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

// ---------- models ----------

/** POST /api/models/load — shape check; .nextool semantic validation stays in the route. */
export const modelLoadSchema = z
  .object({
    manifest: z
      .object({
        name: z.string().trim().min(1).max(160).optional(),
        version: z.string().trim().max(32).optional(),
        format: z.unknown().optional(),
        architecture: z.unknown().optional(),
        compatibility: z.unknown().optional(),
      })
      .passthrough(),
  })
  .strict();

// ---------- settings ----------

/** PUT /api/settings — mirrors updateSettings clamps. */
export const settingsSchema = z
  .object({
    defaultMode: z.enum(['goal', 'live']),
    defaultReasoningLevel: z.number().int().min(1).max(6),
    maxSubtoolCalls: intLimit('maxSubtoolCalls', 1, 200),
    safetyLimit: intLimit('safetyLimit', 1, 500),
    maxIterations: intLimit('maxIterations', 1, 200),
    taskTimeoutMs: intLimit('taskTimeoutMs', 5_000, 3_600_000),
    // v1.0.7 §1 — global tool timeout: default 10000 ms, max = the configured
    // execution.timeoutMs.max (shipped 1 hour). Values above the ceiling are
    // REJECTED here (API validation), never silently clamped.
    toolTimeoutMs: toolTimeoutValidator(),
    // v1.0.9 §14.1/§14.8 — Network Policy "Network Request Timeout": validated
    // here (API) with the same central limits the runtime enforces.
    networkRequestTimeoutMs: networkTimeoutValidator(),
    liveIntervalMs: intLimit('liveIntervalMs', 1_000, 3_600_000),
    useMemory: z.boolean(),
    parallelToolCalls: z.boolean(),
    maxParallelToolCalls: intLimit('maxParallelToolCalls', 1, 8),
    // v1.0.6 §9.3/§10 — global Auto-Execute + Multi-Event switches (default false)
    autoExecuteTools: z.boolean(),
    allowMultipleEvents: z.boolean(),
    // v1.0.10 §12.1/§16 — global default planner strategy + pre-plan max steps
    defaultPlannerType: z.enum(['pre-plan', 'one-by-one']),
    prePlanMaxSteps: intLimit('prePlanMaxSteps', 1, 122),
    // v1.0.11 — global default recovery attempt cap (2..4, default 4)
    recoveryMaxAttempts: intLimit('recoveryMaxAttempts', 2, 4),
    // v1.0.13 — safety-limit continuation policy (default ON) + per-continuation
    // budget granted to both limits (central bounds 1..500, default 25)
    safetyLimitContinuation: z.boolean(),
    safetyLimitContinuationExtra: intLimit('limitContinuationExtra', 1, 500),
    logLevel: z.enum(['info', 'debug', 'error']),
    realTimeTransport: z.literal('sse'),
  })
  .partial()
  .strict();

// ==================== v1.0.2 ====================

// ---------- Tool IDE ----------

/** Structured metadata record (v1.0.5 §2.7) — flat string key/value pairs. */
export const metadataRecordSchema = z
  .record(z.string().trim().min(1).max(120), z.string().max(2000))
  .refine((v) => Object.keys(v).length <= 50, { message: 'metadata supports at most 50 key/value pairs' });

/** POST /api/tools/js — register a function tool (js-function | nodejs, Tool IDE "Save") */
export const registerJsToolSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$/, 'must look like namespace.action (lowercase)'),
    description: z.string().trim().max(1000).optional(),
    purpose: z.string().trim().max(1000).optional(),
    category: z.string().trim().max(60).optional(),
    toolVersion: z.string().trim().max(40).optional(),
    // v1.0.5 §3: the restricted Node.js environment registers through the same
    // endpoint — one registration system, two function sandboxes.
    // v1.0.11: freedom-node (INTENTIONALLY unrestricted) registers here too;
    // runtime execution is gated server-side by the central fs config.
    environment: z.enum(['js-function', 'nodejs', 'freedom-node']).optional(),
    schema: z.object({ type: z.literal('object'), properties: z.array(toolParamDefSchema).max(40) }),
    functionSource: z.string().min(1).max(maxSourceChars()),
    metadata: metadataRecordSchema.optional(),
    // v1.0.6 §9.2 — per-tool auto-execute (default false = approval required)
    autoExecute: z.boolean().optional(),
    // v1.0.13 — verification latch: completed executions wait for operator verification
    verificationLatch: z.boolean().optional(),
    // v1.0.7 §1 — tool-specific execution timeout (default: global 10000 ms,
    // ceiling = the configured execution.timeoutMs.max). Values above the
    // ceiling are rejected at registration.
    timeoutMs: toolTimeoutValidator().optional(),
    /** v1.0.9 §14 — tool-specific Network Policy request timeout. */
    networkTimeoutMs: networkTimeoutValidator().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** PUT /api/tools/:name — partial update of a user-editable tool */
export const updateToolSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$/, 'must look like namespace.action (lowercase)')
      .optional(),
    description: z.string().trim().max(1000).optional(),
    purpose: z.string().trim().max(1000).optional(),
    category: z.string().trim().max(60).optional(),
    toolVersion: z.string().trim().max(40).optional(),
    /** v1.0.5: js-function ⇄ nodejs switch for user function tools.
     *  v1.0.11: ⇄ freedom-node switch too (see /api/tools/js). */
    environment: z.enum(['js-function', 'nodejs', 'freedom-node']).optional(),
    schema: z.object({ type: z.literal('object'), properties: z.array(toolParamDefSchema).max(40) }).optional(),
    functionSource: z.string().min(1).max(maxSourceChars()).optional(),
    metadata: metadataRecordSchema.optional(),
    // v1.0.6 §9.2 — per-tool auto-execute switch
    autoExecute: z.boolean().optional(),
    // v1.0.13 — per-tool verification latch switch
    verificationLatch: z.boolean().optional(),
    // v1.0.7 §1 — per-tool execution timeout (undefined keeps stored value).
    timeoutMs: toolTimeoutValidator().optional(),
    /** v1.0.9 §14 — per-tool Network Policy request timeout (undefined keeps stored value). */
    networkTimeoutMs: networkTimeoutValidator().optional(),
    /** v1.0.5: dynamic tools only — validated against the real handler registry. */
    handlerKind: z.enum(['echo', 'delay', 'http_get', 'uuid']).optional(),
    handlerConfig: jsonObject.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'body must contain at least one field' });

/** POST /api/tools/test — run a tool in the controlled test context (v1.0.5: environment-aware) */
export const testToolSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    functionSource: z.string().max(maxSourceChars()).optional(),
    /** v1.0.5 §1.2/§4.5: which sandbox executes an UNSAVED editor source.
     *  v1.0.11: freedom-node test runs go through the freedom runner with the
     *  same server-side fs gate as production. */
    environment: z.enum(['js-function', 'nodejs', 'freedom-node']).optional(),
    params: jsonObject.optional(),
    /** v1.0.7 §1 — effective execution timeout for the test run (ms). */
    timeoutMs: toolTimeoutValidator().optional(),
    /** v1.0.9 §14 — Network Policy request timeout for the test run (ms). */
    networkTimeoutMs: networkTimeoutValidator().optional(),
  })
  .refine((v) => !!v.name !== !!v.functionSource, {
    message: 'provide either a registered tool name or an unsaved functionSource — not both',
  });

// ---------- Training ----------

export const trainingConfigSchema = z
  .object({
    epochs: z.number().int().min(1).max(100).default(20),
    batchSize: z.number().int().min(1).max(128).default(8),
    learningRate: z.number().min(0.0001).max(1).default(0.01),
    validationSplit: z.number().min(0).max(0.5).default(0.2),
    shuffle: z.boolean().default(true),
    earlyStoppingPatience: z.number().int().min(0).max(50).optional(),
    vocabSize: z.number().int().min(16).max(1024).optional(),
    // v1.0.10 §29 — semantic version stamped onto the produced checkpoint
    // (e.g. "1.0.1"). Optional; legacy tc-<job> version kept when absent.
    modelVersion: z
      .string()
      .trim()
      .max(32)
      .regex(/^\d+\.\d+\.\d+/, 'must be semver-like (e.g. 1.0.1)')
      .optional(),
  })
  .strict();

export const createTrainingJobSchema = z
  .object({
    datasetId: z.string().trim().min(1).max(100),
    config: trainingConfigSchema.optional(),
  })
  .strict();

// ---------- Benchmark ----------

export const createBenchmarkRunSchema = z
  .object({
    modelKey: z.enum(['llm-core', 'heuristic-fallback']).or(z.string().trim().min(1).max(160)),
    datasetId: z.string().trim().min(1).max(100),
    suite: z.literal('tool-selection'),
    limit: z.number().int().min(1).max(500).optional(),
    timeoutPerCaseMs: z.number().int().min(1000).max(120_000).optional(),
    label: z.string().trim().max(80).optional(),
  })
  .strict();

// ==================== v1.0.7 ====================

// ---------- Application reset (spec §3) ----------

/**
 * POST /api/settings/reset — the typed confirmation phrase is REQUIRED.
 * Anything except the exact phrase "RESET" is rejected before any store is
 * touched (spec §3.3: no single accidental click, no implicit trigger).
 */
export const resetApplicationSchema = z
  .object({
    confirm: z.literal('RESET', {
      message: 'Type RESET to confirm the application data reset.',
    }),
  })
  .strict();

// ---------- Maintenance cleanup (spec §4/§5) ----------

/** GET/POST /api/maintenance/cleanup — POST body (dry-run analysis by default). */
export const maintenanceCleanupSchema = z
  .object({
    /** false (default) = analyze + delete confirmed orphans; true = report only. */
    dryRun: z.boolean().optional(),
  })
  .strict();

// ==================== v1.0.12: MCP connectors ====================

/** POST /api/connectors — create a connector instance of a registry provider. */
export const createConnectorSchema = z
  .object({
    providerId: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be the kebab-case id of a provider from config/mcp-servers.json'),
    name: z.string().trim().min(1).max(80).optional(),
    config: z.record(z.string(), z.union([z.string().max(2000), z.number()])).optional(),
  })
  .strict();

/** PATCH /api/connectors/:id */
export const updateConnectorSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    config: z.record(z.string(), z.union([z.string().max(2000), z.number()])).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** POST /api/connectors/:id/connection */
export const connectorConnectionSchema = z
  .object({
    action: z.enum(['connect', 'disconnect', 'reconnect']),
  })
  .strict();

/**
 * PUT /api/connectors/:id/credentials — values are stored SERVER-SIDE ONLY
 * and are never returned by any response (only field NAMES are echoed back).
 */
export const connectorCredentialsSchema = z
  .object({
    type: z.string().trim().max(40).optional(),
    // v1.0.13 §5 — values may be empty/omitted when only declaring the auth
    // method ('none', or 'oauth2' where tokens arrive from the redirect flow).
    values: z.record(z.string().trim().min(1).max(120), z.string().max(8000)).optional(),
    authMethod: z.enum(['none', 'bearer', 'token_pair', 'oauth2']).optional(),
  })
  .strict();

/** POST /api/connectors/:id/tools — import / refresh / toggle / remove. */
export const connectorToolsActionSchema = z
  .object({
    action: z.enum(['import', 'refresh', 'toggle', 'remove']),
    /** import: remote tool names selected in the discovery list. */
    names: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(),
    /** refresh/toggle/remove: one imported tool's REMOTE tool name (refresh
     *  also accepts names omitted = refresh ALL imported tools). */
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
