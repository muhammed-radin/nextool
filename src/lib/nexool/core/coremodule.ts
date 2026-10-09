/**
 * NexTool CoreModule — LLM-powered tool matching + parameter generation.
 * Falls back to the deterministic heuristic matcher on any SDK error.
 *
 * v1.1.0 (§1/§11): the hidden 25-second CORE_TIMEOUT_MS is GONE — the
 * deadline is the configurable `coreModule.llmTimeoutMs` central limit
 * (default 5 minutes, `null` = no application-level timeout). When the
 * provider supports it the decision call now genuinely STREAMS (`stream:
 * true`): deltas are forwarded to the CoreModule Live Output registry and
 * broadcast over the dedicated /api/core/stream SSE channel while the full
 * answer is still parsed/validated by the same pipeline as before.
 */
import ZAI from 'z-ai-web-dev-sdk';
import type { CoreModuleOutput, ToolDefinition } from '../types';
import { emitEvent, recordCoreDecision } from '../eventbus';
import { getResolvedLimits } from '../config-limits';
import { heuristicDecide } from './heuristic';
import { coerceParams } from '../tools/executor';
// v1.1.0 — shared provider-call layer (configurable timeout, abort, streaming).
import { callLlm, LlmCallCancelledError } from './llm-call';
// v1.1.0 — CoreModule Live Output registry (§1).
import {
  appendCoreOutput,
  cancelCoreOutput,
  completeCoreOutput,
  failCoreOutput,
  startCoreOutput,
  type CoreOutputRecord,
} from './live-output';
// v1.0.12 Phase 7 — custom task instructions (delimited user block).
import { appendInstructionsBlock } from '../instructions';
// v1.0.15 — the ACTIVE TRAINED CHECKPOINT (model v1.0.4) participates in
// every decision: as a hint inside the LLM prompt and as the FIRST fallback
// when the LLM call fails (the heuristic matcher stays last).
import { suggestToolFromTrainedModel } from '../training/current-model';

export interface CoreContextBundle {
  memory?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
  stateSummary?: string;
  lastObservation?: string;
  /** v1.0.14 §14 — structured Live-cycle trigger: `{ type: 'interval' }` for
   *  a message-less scheduled check, or `{ type: 'event', event: { id, type,
   *  source, message, data, priority, createdAt } }` when an event woke the
   *  Live loop. The AI sees WHAT happened, not just that it was woken. */
  trigger?: Record<string, unknown>;
}

export interface DecideInput {
  objective: string;
  request: string;
  goal: string;
  activeSubgoal?: { title: string; reason?: string };
  toolDefs: ToolDefinition[];
  contextBundle?: CoreContextBundle;
  reasoningLevel: number;
  allowedTools?: string[];
  /** v1.0.12 Phase 7 — combined custom task instructions; appended to the
   *  USER message as a delimited block BELOW the fixed system prompt. */
  instructions?: string | null;
  /** v1.0.15 — tool suggestion from the active trained checkpoint (model
   *  v1.0.4). Included in the CONTEXT payload so the LLM sees what the
   *  learned classifier thinks BEFORE deciding; consumed directly on
   *  LLM failure as the structured fallback. */
  classifierHint?: { tool: string; confidence: number; modelVersion: string } | null;
  /** v1.1.0 — owning task id for the CoreModule Live Output channel and
   *  persisted core.output.* lifecycle events. */
  taskId?: string;
  /** v1.1.0 — cancellation signal (task force-stop). When fired mid-call
   *  the decision is abandoned with failureStage 'cancelled'. */
  signal?: AbortSignal;
  /** v1.1.0 — disable Live Output streaming for this call (rare internal
   *  callers that must stay silent). Streaming remains available by default. */
  liveOutputDisabled?: boolean;
}

function buildSystemPrompt(): string {
  return [
    'You are CoreModule, the tool-matching and parameter generation unit of NexTool, a task-processing system (not a chatbot).',
    'Given an objective and available tool schemas (dynamic), decide ONE structured action.',
    'Rules:',
    '1. Extractive parameters (generation "extractive") MUST be copied verbatim from the objective/request/context — never invent them.',
    '2. Constructive parameters (generation "constructive") MUST be enriched and regenerated from intent, tool description, schema and context — never copy the raw sentence. Enriched values must add concrete detail (e.g. for image prompts: lighting, composition, atmosphere, style, quality descriptors).',
    '3. Validate parameters mentally against the schema: correct type, enum membership, min/max. Coerce when safe (e.g. string "5" for a number param).',
    '4. If a required parameter is genuinely missing and cannot be derived, return status "clarification_required" with the missing param names.',
    '5. If no tool matches, return status "no_tool". If the matched tool is unsuitable for safety reasons, return "cannot_execute". Return "stop" only if the objective itself is a stop request.',
    '6. Choose ONE tool only. Never chain multiple tools.',
    'Output STRICT JSON only, no markdown, no commentary:',
    '{"status":"tool_call|no_tool|clarification_required|cannot_execute|stop","tool":"<tool name or omitted>","params":{...},"confidence":0.0-1.0,"reason":"one concise operational sentence (no chain-of-thought)","missing":["<param>", ...]}',
    'Examples:',
    'Objective: "Check the weather in Kochi" | Tool weather.get {location extractive} → {"status":"tool_call","tool":"weather.get","params":{"location":"Kochi"},"confidence":0.95,"reason":"Location extracted verbatim; weather.get matches the request."}',
    'Objective: "Create an image of a car on a city street at night" | Tool image.generate {prompt constructive, size enum, style constructive} → {"status":"tool_call","tool":"image.generate","params":{"prompt":"A cinematic, highly detailed modern car parked on a city street at night, illuminated by street lamps, realistic urban architecture, atmospheric lighting, reflections on wet asphalt, realistic photography","size":"1024x1024","style":"photorealistic"},"confidence":0.97,"reason":"Constructive prompt enriched from intent; enum size defaulted."}',
    'Objective: "Explain quantum physics" | No matching tool → {"status":"no_tool","confidence":0.8,"reason":"No registered tool provides explanatory text generation."}',
  ].join('\n');
}

/**
 * v1.0.16 §6.3 — the TOOLS block only depends on the toolDefs array identity
 * (static during a task run): cache the serialized JSON per reference instead
 * of re-serializing every schema on every decision.
 */
const toolsBlockCache = new WeakMap<ToolDefinition[], string>();
function serializeToolsBlock(toolDefs: ToolDefinition[]): string {
  const hit = toolsBlockCache.get(toolDefs);
  if (hit) return hit;
  const tools = toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    purpose: t.purpose,
    category: t.category,
    schema: {
      properties: t.schema.properties.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        generation: p.generation,
        enum: p.enumValues,
        min: p.min,
        max: p.max,
      })),
    },
  }));
  const block = JSON.stringify(tools);
  toolsBlockCache.set(toolDefs, block);
  return block;
}

function buildUserMessage(input: DecideInput): string {
  const toolsBlock = serializeToolsBlock(input.toolDefs);

  const ctx = input.contextBundle ?? {};
  const payload = `{"objective":${JSON.stringify(input.objective)},"request":${JSON.stringify(input.request)},"goal":${JSON.stringify(input.goal)},"subgoal":${JSON.stringify(input.activeSubgoal?.title)},"TOOLS":${toolsBlock},"CONTEXT":${JSON.stringify({
    memory: (ctx.memory ?? []).slice(0, 5),
    history: (ctx.history ?? []).slice(-5),
    state: ctx.stateSummary,
    lastObservation: ctx.lastObservation,
    // v1.0.14 §14 — the Live trigger (interval vs full event body).
    trigger: ctx.trigger,
  })},"reasoningLevel":${JSON.stringify(input.reasoningLevel)}}`;

  // v1.0.12 Phase 7 — custom task instructions travel BELOW the fixed system
  // prompt (which stays FIRST) as a delimited user section. Exported pure for
  // deterministic hierarchy tests.
  return appendInstructionsBlock(payload, input.instructions);
}

export { buildUserMessage as buildCoreUserMessage };

/**
 * v1.0.11 §50 — inference-path optimization. The system prompt is CONSTANT:
 * build it once (module-level) instead of per call. The ZAI client is cached
 * process-wide (a stateless HTTP wrapper) with a mutex so concurrent
 * decisions share one initialization; a failed creation clears the cache so
 * the next call retries honestly.
 */
let cachedSystemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (cachedSystemPrompt === null) cachedSystemPrompt = buildSystemPrompt();
  return cachedSystemPrompt;
}

const gZai = globalThis as unknown as { __nextoolZai?: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null };
/**
 * v1.0.11 §50 — the shared, cached ZAI client for EVERY inference path
 * (CoreModule decisions, Observer verifications, recovery assessments,
 * planner subgoal proposals). One initialization per process instead of one
 * per call; a failed init clears the cache so the next call retries.
 */
export async function getZai(): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  const existing = gZai.__nextoolZai;
  if (existing) {
    try {
      return await existing;
    } catch {
      gZai.__nextoolZai = null; // previous init failed — retry below
    }
  }
  const creating = ZAI.create()
    .then((client) => client)
    .catch((err) => {
      gZai.__nextoolZai = null;
      throw err;
    });
  gZai.__nextoolZai = creating;
  return creating;
}

/**
 * v1.0.16 §7.3 — safe parse/repair for the LLM's structured output.
 * Handles: markdown fences, leading/trailing commentary, and (better than
 * first-{…last-}) finds the first BALANCED {...} block so trailing prose with
 * braces cannot corrupt the slice. A minor recoverable formatting issue must
 * not silently discard a useful decision (that was a top fallback trigger).
 */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as Record<string, unknown>;
        } catch {
          try {
            // one repair pass: trailing commas before } or ]
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/**
 * v1.0.16 §7.2/§7.3 — tool-identifier repair. The LLM occasionally returns
 * near-miss identifiers (display names, underscores/spaces instead of dots,
 * casing drift). A SAFE normalization (lowercase + separators → dots + a
 * unique prefix/substring match against the ACTUAL toolDefs) recovers the
 * decision instead of dropping it to the heuristic fallback. Returns the
 * matched definition or null (never guesses between ambiguous candidates).
 */
export function repairToolName(rawTool: string, toolDefs: ToolDefinition[]): ToolDefinition | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[\\s_\-.]+/g, '.').replace(/^\.|\.$/g, '');
  const wanted = normalize(rawTool);
  if (!wanted) return null;
  const exact = toolDefs.find((t) => normalize(t.name) === wanted);
  if (exact) return exact;
  const candidates = toolDefs.filter((t) => {
    const n = normalize(t.name);
    return n === wanted || n.endsWith(`.${wanted}`) || wanted.endsWith(`.${n}`) || n.replace(/\./g, '') === wanted.replace(/\./g, '');
  });
  return candidates.length === 1 ? candidates[0] : null;
}

const VALID_STATUSES = new Set(['tool_call', 'no_tool', 'clarification_required', 'cannot_execute', 'stop']);

function validateOutput(raw: Record<string, unknown>, input: DecideInput): CoreModuleOutput | null {
  const status = String(raw.status ?? '');
  if (!VALID_STATUSES.has(status)) return null;
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5;
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 300) : 'CoreModule decision.';
  const missing = Array.isArray(raw.missing) ? raw.missing.map(String) : [];

  const out: CoreModuleOutput = {
    status: status as CoreModuleOutput['status'],
    confidence,
    reason,
    missing: missing.length ? missing : undefined,
    engine: 'llm-core',
    latencyMs: 0,
  };

  if (status === 'tool_call') {
    const rawTool = String(raw.tool ?? '');
    // v1.0.16 §7.3 — repair near-miss tool identifiers before giving up.
    const def = input.toolDefs.find((t) => t.name === rawTool) ?? repairToolName(rawTool, input.toolDefs);
    if (!def) return null;
    const params = (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params))
      ? raw.params as Record<string, unknown>
      : {};
    out.tool = def.name;
    out.params = coerceParams(params, def.schema);
  }
  return out;
}

/** CoreModule decision entry point. Never throws. */
export async function decide(input: DecideInput): Promise<CoreModuleOutput> {
  const started = Date.now();
  let output: CoreModuleOutput | null = null;
  const toolCandidateCount = input.toolDefs.length;

  // v1.1.0 §11.1 — the deadline comes from the central configuration
  // (coreModule.llmTimeoutMs; null = no application-level timeout). The
  // configured value is reported in diagnostics, and a reached deadline is
  // recorded honestly as 'provider timeout (configured deadline)' — slow
  // generation is never silently relabeled as an unrelated model error.
  let configuredTimeoutMs: number | null = 300_000;
  try {
    configuredTimeoutMs = getResolvedLimits().coreModule.llmTimeoutMs;
  } catch {
    /* limits file problem — keep the documented 5-minute default */
  }

  // v1.1.0 §1 — one Live Output record per LLM pass. The record accumulates
  // REAL provider deltas (when streaming is available) and is announced on
  // the /api/core/stream SSE channel; lifecycle events are persisted.
  const startLive = (label: string): CoreOutputRecord | null => {
    if (input.liveOutputDisabled || !input.taskId) return null;
    const rec = startCoreOutput({ taskId: input.taskId, label });
    void emitEvent({
      taskId: input.taskId,
      type: 'core.output.started',
      source: 'core',
      message: `CoreModule LLM request ${rec.requestId} started (${label})`,
      data: { requestId: rec.requestId, label, requestedEngine: rec.requestedEngine, configuredTimeoutMs },
      priority: 6,
    });
    return rec;
  };

  // v1.0.16 §6.3/§7.1 — the trained-checkpoint hint now runs CONCURRENTLY
  // with the LLM call instead of blocking every decision before it (the old
  // serial await added its full latency to the happy path). The hint is
  // consumed ONLY on the fallback path (by then it has long resolved).
  const hintPromise = (async () => {
    try {
      const suggestion = await suggestToolFromTrainedModel(`${input.objective}\n${input.request}`);
      if (suggestion && input.toolDefs.some((t) => t.name === suggestion.tool)) {
        return { tool: suggestion.tool, confidence: suggestion.confidence, modelVersion: suggestion.modelVersion };
      }
    } catch { /* classifier hint is advisory only */ }
    return null;
  })();

  const buildMessages = () => [
    { role: 'assistant' as const, content: getSystemPrompt() },
    { role: 'user' as const, content: buildUserMessage(input) },
  ];

  let failureStage = 'unknown';
  try {
    // One streaming pass. Deltas flow into the Live Output registry as they
    // arrive from the provider; the returned content is the same full text
    // the non-streaming path would have produced (the pipeline is unchanged).
    const runPass = async (label: string): Promise<string | undefined> => {
      const rec = startLive(label);
      try {
        const result = await callLlm({
          messages: buildMessages(),
          timeoutMs: configuredTimeoutMs,
          signal: input.signal,
          ...(rec
            ? {
                onDelta: (delta: string) => appendCoreOutput(rec, delta),
                onNonStreamed: () => {
                  // The provider answered without a stream body — report
                  // honestly instead of fabricating a token stream (§1.3).
                  rec.streaming = false;
                },
              }
            : {}),
        });
        if (rec) {
          completeCoreOutput(rec, { streamed: result.streamed, configuredTimeoutMs });
        }
        return result.content;
      } catch (err) {
        if (err instanceof LlmCallCancelledError || input.signal?.aborted) {
          if (rec) cancelCoreOutput(rec);
        } else if (rec) {
          failCoreOutput(rec, err instanceof Error ? err.message : String(err), { configuredTimeoutMs });
        }
        throw err;
      }
    };

    let content = await runPass('decision');
    let raw = content ? extractJson(content) : null;
    if (!raw) {
      failureStage = 'invalid structured output (first pass)';
      // one retry with a stricter instruction — a second REAL LLM pass with
      // its own Live Output record (never a fabricated continuation).
      const retryContent = await runPass('decision (strict retry)').catch(() => undefined);
      const retry = retryContent ? `${retryContent}\nReturn ONLY the JSON object.` : '';
      raw = extractJson(retry);
      if (!raw) failureStage = 'invalid structured output (strict retry too)';
      else failureStage = 'unknown';
    }
    if (raw) {
      output = validateOutput(raw, input);
      if (!output) failureStage = 'validation rejected the structured result';
    }
  } catch (err) {
    if (err instanceof LlmCallCancelledError || input.signal?.aborted) {
      failureStage = 'cancelled';
    } else {
      failureStage =
        err instanceof Error && err.message.includes('timed out')
          ? 'provider timeout (configured deadline reached)'
          : 'provider failure';
      console.error('[coremodule] LLM decision failed, using fallback ladder:', err);
    }
  }

  if (!output) {
    // v1.0.15→v1.0.16 fallback ladder: the LLM failed → 1) the trained
    // v1.0.5 classifier's suggestion (when it is reasonably confident), then
    // 2) the deterministic heuristic matcher. Every fallback records WHY
    // (§7.4 observability) — a valid no_tool from llm-core is NOT a fallback.
    const classifierHint = await hintPromise;
    if (classifierHint && classifierHint.confidence >= 0.45) {
      const def = input.toolDefs.find((t) => t.name === classifierHint.tool);
      if (def) {
        output = {
          status: 'tool_call',
          tool: def.name,
          params: {},
          confidence: classifierHint.confidence,
          reason: `Trained classifier v${classifierHint.modelVersion} selected ${def.name} (LLM unavailable) — parameters follow the schema defaults.`,
          engine: `trained-classifier:v${classifierHint.modelVersion}`,
          latencyMs: Date.now() - started,
          fallbackReason: `llm-core unavailable: ${failureStage}`,
          requestedEngine: 'llm-core',
          toolCandidateCount,
        };
      }
    }
  }
  if (!output) {
    output = heuristicDecide({
      objective: input.objective,
      request: input.request,
      toolDefs: input.toolDefs,
      lastObservation: input.contextBundle?.lastObservation,
    });
  }

  // allowed-tools / enabled filtering
  if (output.status === 'tool_call' && output.tool) {
    const chosenTool: string = output.tool;
    const def = input.toolDefs.find((t) => t.name === chosenTool);
    const allowed = !input.allowedTools || input.allowedTools.length === 0 || input.allowedTools.includes(chosenTool);
    if (!def || !allowed) {
      output = {
        status: 'cannot_execute',
        confidence: output.confidence,
        reason: !def
          ? `Selected tool ${chosenTool} is not in the provided tool set.`
          : `Selected tool ${chosenTool} is disabled or excluded by the task configuration.`,
        engine: output.engine,
        latencyMs: Date.now() - started,
        fallbackReason: output.fallbackReason,
        requestedEngine: 'llm-core',
        toolCandidateCount,
      };
    }
  }

  // §7.4 — annotate every NON-llm-core decision with the diagnostics fields
  // (the heuristic path reaches here without them).
  if (output.engine !== 'llm-core') {
    output.fallbackReason ??= `llm-core unavailable: ${failureStage}`;
    output.requestedEngine ??= 'llm-core';
  }
  output.toolCandidateCount ??= toolCandidateCount;
  output.latencyMs = Date.now() - started;
  // v1.1.0 — surface the configured deadline + failure stage in diagnostics.
  output.coreTimeoutMs = configuredTimeoutMs;
  output.failureStage = failureStage;
  recordCoreDecision(output.latencyMs);
  return output;
}
