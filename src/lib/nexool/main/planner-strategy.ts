/**
 * NexTool v1.0.10 §2-§11 — Planner strategies.
 *
 *   PlannerStrategy
 *    ├── PrePlanPlanner  (existing complete-plan planner — planner.ts, unchanged semantics)
 *    └── OneByOnePlanner (this module — plans exactly ONE next step per call)
 *
 * The one-by-one planner never generates a hidden future list:
 *
 *   Goal → Understand → Plan exactly ONE next step → Execute → Observe
 *        → Verify goal → (complete | plan the next single step from the
 *          updated state)
 *
 * Shared components (goal understanding, tool definitions, state preparation,
 * LLM invocation, JSON parsing, sanitization, events) mirror the pre-plan
 * planner so both strategies stay consistent; only the planning semantics
 * differ. All pure helpers are exported for deterministic unit tests.
 */
import type { MainState, PlanStep, PlannerType, TaskMode, ToolDefinition } from '../types';
import { emitEvent } from '../eventbus';
// v1.0.11 §50 — shared cached client (one init per process).
import { getZai } from '../core/coremodule';
// v1.0.12 Phase 7 — custom task instructions (delimited user block).
import { appendInstructionsBlock } from '../instructions';

const PLANNER_TIMEOUT_MS = 25_000;

// ---------- strategy resolution (§12/§13) ----------

/**
 * Resolution precedence (§13): task plannerType → global default →
 * fallback 'pre-plan'. Pure — resolved at task creation/runtime config time;
 * a task never switches strategy because Settings changed afterwards.
 */
export function resolvePlannerType(
  taskPlannerType: PlannerType | undefined,
  globalDefault: PlannerType | undefined,
): PlannerType {
  if (taskPlannerType === 'pre-plan' || taskPlannerType === 'one-by-one') return taskPlannerType;
  if (globalDefault === 'one-by-one') return 'one-by-one';
  return 'pre-plan';
}

// ---------- one-by-one planning context (§5) ----------

/** Latest relevant task state handed to EVERY one-by-one planning call. */
export interface OneByOneContext {
  request: string;
  goal: string;
  taskMode: TaskMode;
  plannerType: 'one-by-one';
  reasoningLevel: number;
  state: Pick<
    MainState,
    'plan' | 'subgoals' | 'previousActions' | 'observations' | 'iterationCount' | 'toolCallCount' | 'lastObservation'
  >;
  /** Recent FAILED executions with their reasons — the planner must never
   *  blindly repeat an identical failed action (§10). */
  knownFailures: string[];
  /** Known constraints (enabled-tool restrictions, mode notes). */
  constraints: string[];
  /** v1.0.12 Phase 7 — combined custom task instructions (delimited user
   *  block appended BELOW the fixed system constraints). */
  instructions?: string;
  /** Extra situational note (e.g. the live tick / event that triggered planning). */
  note?: string;
}

export function buildOneByOneContext(input: {
  request: string;
  goal: string;
  taskMode: TaskMode;
  reasoningLevel: number;
  state: OneByOneContext['state'];
  knownFailures?: string[];
  constraints?: string[];
  instructions?: string;
  note?: string;
}): OneByOneContext {
  return {
    request: input.request,
    goal: input.goal,
    taskMode: input.taskMode,
    plannerType: 'one-by-one',
    reasoningLevel: input.reasoningLevel,
    state: input.state,
    knownFailures: input.knownFailures ?? [],
    constraints: input.constraints ?? [],
    instructions: input.instructions,
    note: input.note,
  };
}

// ---------- single-step contract (§6) ----------

interface RawStep {
  title?: unknown;
  detail?: unknown;
  kind?: unknown;
}

function stepId(i: number): string {
  return `step_${i + 1}`;
}

/** Sanitize ONE raw step. Returns null when no valid step can be extracted. */
export function sanitizeSingleStep(raw: RawStep, index: number): PlanStep | null {
  const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 200) : '';
  if (!title) return null;
  const kind = raw?.kind === 'observation' || raw?.kind === 'verification' ? raw.kind : 'action';
  return {
    id: stepId(index),
    title,
    detail: typeof raw?.detail === 'string' && raw.detail.trim() ? raw.detail.slice(0, 400) : undefined,
    status: 'pending',
    kind,
  };
}

/**
 * §6 — the one-by-one output contract is EXACTLY ONE executable step.
 * If the model accidentally returns multiple steps ({"steps":[...]}) the
 * sanitizer retains exactly one valid next step (the first) and DISCARDS the
 * rest — accidental multi-step planning never becomes multi-step execution.
 *
 * Returns the sanitized step plus how many extra steps were dropped.
 */
export function sanitizeOneStepResponse(parsed: unknown, startIndex = 0): { step: PlanStep; discarded: number } | null {
  let candidate: RawStep | undefined;
  let discarded = 0;

  if (Array.isArray(parsed)) {
    // raw array of steps → first valid wins
    for (const item of parsed) {
      const step = sanitizeSingleStep(item as RawStep, startIndex);
      if (step) return { step, discarded: parsed.length - 1 };
    }
    return null;
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.steps)) {
      // contract violation: multi-step plan → keep exactly one, discard the rest
      discarded = obj.steps.length - 1;
      for (const item of obj.steps) {
        const step = sanitizeSingleStep(item as RawStep, startIndex);
        if (step) return { step, discarded: Math.max(0, discarded) };
      }
      return null;
    }
    candidate = obj as RawStep;
    if (obj.step && typeof obj.step === 'object') candidate = obj.step as RawStep;
  }

  if (!candidate) return null;
  const step = sanitizeSingleStep(candidate, startIndex);
  return step ? { step, discarded: 0 } : null;
}

// ---------- deterministic fallback (§43) ----------

/**
 * §43 — safe deterministic fallback: ONE valid immediate step. Never returns
 * zero steps — the caller decides goal completion separately (the goal
 * verifier always runs BEFORE another plan is requested, §9).
 */
export function buildOneByOneFallbackStep(ctx: OneByOneContext, index: number): PlanStep {
  const lastObservation = ctx.state.lastObservation?.trim();
  const failed = ctx.knownFailures.length > 0;
  if (failed) {
    // §10 — a fallback after failure must acknowledge the failure instead of
    // blindly repeating the same action.
    return {
      id: stepId(index),
      title: 'Recover from the failed step using the failure context',
      detail: `Last failure: ${ctx.knownFailures[ctx.knownFailures.length - 1]?.slice(0, 300) ?? 'unknown'} — choose a different approach or verify the current state.`,
      status: 'pending',
      kind: 'action',
    };
  }
  if (lastObservation) {
    return {
      id: stepId(index),
      title: 'Fulfill the goal via the best available tool',
      detail: `Latest observation: ${lastObservation.slice(0, 300)}`,
      status: 'pending',
      kind: 'action',
    };
  }
  return {
    id: stepId(index),
    title: 'Fulfill request via best available tool',
    detail: ctx.request,
    status: 'pending',
    kind: 'action',
  };
}

// ---------- the one-by-one planner (§4-§6, §10, §21) ----------

export interface PlanNextResult {
  step: PlanStep;
  /** 'llm' = model-planned; 'deterministic-fallback' = safe fallback (§43). */
  source: 'llm' | 'deterministic-fallback';
  /** Number of extra steps the model tried to return and were discarded (§6). */
  discarded: number;
}

/**
 * Plan exactly ONE next step from the latest task state (§4/§5). The caller
 * MUST have verified the goal BEFORE calling this (§9) — planning after goal
 * completion is a contract violation.
 */
/**
 * Pure message builder for the one-by-one planner (exported for deterministic
 * unit tests — v1.0.12 Phase 7). FIXED system block FIRST; custom task
 * instructions are appended AFTER the user payload as a delimited block
 * (hierarchy: system > task config > user instructions > goal).
 */
export function buildOneByOneMessages(
  ctx: OneByOneContext,
  toolDefs: ToolDefinition[],
): { system: string; user: string } {
  const system = [
    'You are the One-by-one Planner of NexTool, a task-processing system (not a chatbot).',
    'You see the latest task state AFTER the previous step was executed and observed.',
    'Answer exactly one question: "What is the single best next step to move this task toward the goal?"',
    'Do NOT plan the whole task. Do NOT return a list of future steps.',
    'Output STRICT JSON only: {"title":"short imperative objective","detail":"one sentence","kind":"action"|"observation"|"verification"}',
    'If the latest observation already shows the goal was achieved, you must NOT be called — but if you see goal evidence anyway, return the single cheapest verification step, never work that is already done.',
    ctx.knownFailures.length > 0
      ? 'Known failures are listed. Never blindly repeat an identical failed action — choose a different approach or address the failure reason.'
      : '',
    ctx.note ? `Situational note: ${ctx.note}` : '',
  ].filter(Boolean).join('\n');

  const payload = JSON.stringify({
    request: ctx.request,
    goal: ctx.goal,
    taskMode: ctx.taskMode,
    plannerType: ctx.plannerType,
    reasoningLevel: ctx.reasoningLevel,
    constraints: ctx.constraints,
    knownFailures: ctx.knownFailures,
    previousSteps: ctx.state.plan.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    previousSubgoals: ctx.state.subgoals.slice(-6).map((s) => ({ title: s.title, status: s.status })),
    recentObservations: ctx.state.observations.slice(-6).map((o) => ({ at: o.at, message: o.message })),
    latestToolResult: ctx.state.lastObservation,
    executedActions: ctx.state.previousActions.slice(-8),
    iteration: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
    enabledTools: toolDefs.map((t) => ({ name: t.name, description: t.description, category: t.category })),
    answerFormat: 'exactly one step',
  });

  // v1.0.12 Phase 7 — custom task instructions travel BELOW the fixed
  // system constraints as a delimited user section.
  const user = appendInstructionsBlock(payload, ctx.instructions);
  return { system, user };
}

export async function planOneByOneStep(
  ctx: OneByOneContext,
  toolDefs: ToolDefinition[],
  taskId?: string,
): Promise<PlanNextResult> {
  const started = Date.now();
  const nextIndex = Math.max(ctx.state.plan.length, 0);

  try {
    const zai = await getZai();
    const { system, user } = buildOneByOneMessages(ctx, toolDefs);

    const res = await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: 'assistant' as const, content: system },
          { role: 'user' as const, content: user },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('One-by-one planner LLM call timed out')), PLANNER_TIMEOUT_MS),
      ),
    ]);

    const content = res?.choices?.[0]?.message?.content ?? '';
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx > startIdx) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
      } catch {
        parsed = null;
      }
      const sanitized = parsed ? sanitizeOneStepResponse(parsed, nextIndex) : null;
      if (sanitized) {
        void emitEvent({
          taskId,
          type: 'planner.one_by_one_step_planned',
          source: 'planner',
          message: `One-by-one step planned: ${sanitized.step.title} (llm, ${Date.now() - started}ms${sanitized.discarded > 0 ? `, ${sanitized.discarded} extra step(s) discarded` : ''})`,
          data: {
            plannerType: 'one-by-one',
            stepId: sanitized.step.id,
            stepTitle: sanitized.step.title,
            source: 'llm',
            discarded: sanitized.discarded,
          },
          priority: 6,
        });
        return { step: sanitized.step, source: 'llm', discarded: sanitized.discarded };
      }
    }
  } catch (err) {
    console.error('[planner-strategy] one-by-one LLM planning failed, using deterministic fallback:', err);
  }

  // §43 — equivalent safe fallback: ONE valid immediate step, never zero.
  const step = buildOneByOneFallbackStep(ctx, nextIndex);
  void emitEvent({
    taskId,
    type: 'planner.one_by_one_step_planned',
    source: 'planner',
    message: `One-by-one step planned: ${step.title} (deterministic fallback, ${Date.now() - started}ms)`,
    data: { plannerType: 'one-by-one', stepId: step.id, stepTitle: step.title, source: 'deterministic-fallback' },
    priority: 6,
  });
  return { step, source: 'deterministic-fallback', discarded: 0 };
}
