/**
 * NexTool CoreModule — LLM-powered tool matching + parameter generation.
 * Falls back to the deterministic heuristic matcher on any SDK error.
 */
import ZAI from 'z-ai-web-dev-sdk';
import type { CoreModuleOutput, ToolDefinition } from '../types';
import { recordCoreDecision } from '../eventbus';
import { heuristicDecide } from './heuristic';
import { coerceParams } from '../tools/executor';

const CORE_TIMEOUT_MS = 25_000;

export interface CoreContextBundle {
  memory?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
  stateSummary?: string;
  lastObservation?: string;
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

function buildUserMessage(input: DecideInput): string {
  const tools = input.toolDefs.map((t) => ({
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

  const ctx = input.contextBundle ?? {};
  return JSON.stringify({
    objective: input.objective,
    request: input.request,
    goal: input.goal,
    subgoal: input.activeSubgoal?.title,
    TOOLS: tools,
    CONTEXT: {
      memory: (ctx.memory ?? []).slice(0, 5),
      history: (ctx.history ?? []).slice(-5),
      state: ctx.stateSummary,
      lastObservation: ctx.lastObservation,
    },
    reasoningLevel: input.reasoningLevel,
  });
}

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

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
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
    const tool = String(raw.tool ?? '');
    const def = input.toolDefs.find((t) => t.name === tool);
    if (!def) return null;
    const params = (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params))
      ? raw.params as Record<string, unknown>
      : {};
    out.tool = tool;
    out.params = coerceParams(params, def.schema);
  }
  return out;
}

/** CoreModule decision entry point. Never throws. */
export async function decide(input: DecideInput): Promise<CoreModuleOutput> {
  const started = Date.now();
  let output: CoreModuleOutput | null = null;

  try {
    const zai = await getZai();
    const messages = [
      { role: 'assistant' as const, content: getSystemPrompt() },
      { role: 'user' as const, content: buildUserMessage(input) },
    ];

    let content: string | undefined;
    const callOnce = async (): Promise<string | undefined> => {
      const res = await Promise.race([
        zai.chat.completions.create({ messages, thinking: { type: 'disabled' } }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CoreModule LLM call timed out')), CORE_TIMEOUT_MS),
        ),
      ]);
      return res?.choices?.[0]?.message?.content ?? undefined;
    };

    content = await callOnce();
    let raw = content ? extractJson(content) : null;
    if (!raw) {
      // one retry with a stricter instruction
      content = await callOnce().catch(() => undefined);
      const retryContent = content ? `${content}\nReturn ONLY the JSON object.` : '';
      raw = extractJson(retryContent);
    }
    if (raw) output = validateOutput(raw, input);
  } catch (err) {
    console.error('[coremodule] LLM decision failed, using heuristic fallback:', err);
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
      };
    }
  }

  output.latencyMs = Date.now() - started;
  recordCoreDecision(output.latencyMs);
  return output;
}
