/**
 * NexTool Q1 v1.0.1 — centralized request validation schemas (zod).
 *
 * ONE validation surface shared by all mutating API routes (spec §53/§54):
 * clear, structured validation errors; server-side clamping mirrors the
 * settings/runtime limits; nothing from the frontend is trusted implicitly.
 *
 * Error codes are kept backwards compatible with the v1.0.0 contract:
 * INVALID_REQUEST (tasks) / INVALID_PARAMS (everything else) / INVALID_MANIFEST.
 */

import { z } from 'zod';

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
    maxSubtoolCalls: z.number().int().min(1).max(200),
    safetyLimit: z.number().int().min(1).max(500),
    maxIterations: z.number().int().min(1).max(200),
    taskTimeoutMs: z.number().int().min(5_000).max(3_600_000),
    toolTimeoutMs: z.number().int().min(1_000).max(300_000),
    liveIntervalMs: z.number().int().min(1_000).max(3_600_000),
    parallelToolCalls: z.boolean().optional(),
    maxParallelToolCalls: z.number().int().min(1).max(8).optional(),
    sessionId: z.string().trim().max(200).optional(),
    context: jsonObject.optional(),
  })
  .partial()
  .strict();

/** POST /api/tasks — accepts { request, config? }; legacy flat mode/reasoningLevel still tolerated. */
export const createTaskSchema = z
  .object({
    request: nonEmpty(8000),
    config: taskConfigSchema.optional(),
    mode: z.enum(['goal', 'live']).optional(),
    reasoningLevel: z.number().int().min(1).max(6).optional(),
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
    // v1.0.5: nodejs joins the set (rejected by registerDynamicTool with a
    // pointed message — nodejs tools register via /api/tools/js instead).
    environment: z.enum(['builtin', 'virtual-env', 'dynamic', 'js-function', 'nodejs']),
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
    request: nonEmpty(8000),
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
    maxSubtoolCalls: z.number().int().min(1).max(200),
    safetyLimit: z.number().int().min(1).max(500),
    maxIterations: z.number().int().min(1).max(200),
    taskTimeoutMs: z.number().int().min(5_000).max(3_600_000),
    toolTimeoutMs: z.number().int().min(1_000).max(300_000),
    liveIntervalMs: z.number().int().min(1_000).max(3_600_000),
    useMemory: z.boolean(),
    parallelToolCalls: z.boolean(),
    maxParallelToolCalls: z.number().int().min(1).max(8),
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
    environment: z.enum(['js-function', 'nodejs']).optional(),
    schema: z.object({ type: z.literal('object'), properties: z.array(toolParamDefSchema).max(40) }),
    functionSource: z.string().min(1).max(64_000),
    metadata: metadataRecordSchema.optional(),
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
    /** v1.0.5: js-function ⇄ nodejs switch for user function tools. */
    environment: z.enum(['js-function', 'nodejs']).optional(),
    schema: z.object({ type: z.literal('object'), properties: z.array(toolParamDefSchema).max(40) }).optional(),
    functionSource: z.string().min(1).max(64_000).optional(),
    metadata: metadataRecordSchema.optional(),
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
    functionSource: z.string().max(64_000).optional(),
    /** v1.0.5 §1.2/§4.5: which sandbox executes an UNSAVED editor source. */
    environment: z.enum(['js-function', 'nodejs']).optional(),
    params: jsonObject.optional(),
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
