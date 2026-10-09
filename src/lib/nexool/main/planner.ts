/**
 * NexTool Planner — decomposes a request into ordered, minimal steps.
 * LLM-driven with a deterministic fallback plan.
 *
 * v1.1.0 (§11.5): the hidden 25-second PLANNER_TIMEOUT_MS is GONE — the
 * deadline is the separate, configurable `planner.llmTimeoutMs` central
 * limit (null = no application-level timeout), intentionally distinct from
 * coreModule.llmTimeoutMs / task.taskTimeoutMs / tool timeouts. Planner
 * calls accept the task's AbortSignal so a force-stop unblocks them.
 */
import type { PlanStep, ToolDefinition } from '../types';
import { emitEvent } from '../eventbus';
// v1.1.0 — shared provider-call layer (configurable timeout, abort).
import { callLlm } from '../core/llm-call';
import { getResolvedLimits } from '../config-limits';
// v1.0.12 Phase 7 — custom task instructions (delimited user block).
import { appendInstructionsBlock } from '../instructions';
/**
 * v1.0.10 §16 — the pre-plan maximum is now CONFIGURABLE (central limits
 * task.prePlanMaxSteps: default 10, hard maximum 122) instead of the old
 * hard-coded 8. The caller passes the resolved value; the shipped default
 * keeps pre-plan behavior intact for existing installations.
 */
export const DEFAULT_PRE_PLAN_MAX_STEPS = 10;

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

interface RawStep {
  title?: unknown;
  detail?: unknown;
  kind?: unknown;
  parallelGroup?: unknown;
}

function fallbackPlan(request: string, goal: string): Plan {
  return {
    goal,
    steps: [
      {
        id: 'step_1',
        title: 'Fulfill request via best available tool',
        detail: request,
        status: 'pending',
        kind: 'action',
      },
      {
        id: 'step_2',
        title: 'Verify outcome and observe result',
        status: 'pending',
        kind: 'verification',
      },
    ],
  };
}

function stepId(i: number): string {
  return `step_${i + 1}`;
}

function sanitizeSteps(raw: RawStep[], maxSteps: number): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const s of raw.slice(0, Math.max(1, maxSteps))) {
    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 200) : '';
    if (!title) continue;
    const kind = s.kind === 'observation' || s.kind === 'verification' ? s.kind : 'action';
    const group = Number(s.parallelGroup);
    steps.push({
      id: stepId(steps.length),
      title,
      detail: typeof s.detail === 'string' ? s.detail.slice(0, 400) : undefined,
      status: 'pending',
      kind,
      parallelGroup: Number.isFinite(group) && group > 0 ? Math.round(group) : undefined,
    });
  }
  return steps;
}

/**
 * Pure message builder for the pre-plan planner (exported for deterministic
 * unit tests — v1.0.12 Phase 7). The FIXED system block always comes FIRST;
 * user task instructions (spec §7.6/§7.7) are appended AFTER the user payload
 * as a clearly delimited block, so they can never replace or override the
 * system constraints.
 */
export function buildPlannerMessages(
  request: string,
  goal: string,
  toolDefs: ToolDefinition[],
  reasoningLevel: number,
  maxSteps: number,
  instructions?: string | null,
): { system: string; user: string } {
  const system = [
    'You are the Planner of NexTool, a task-processing system (not a chatbot).',
    'Decompose the request into minimal ordered steps. Each step is one concrete operational action.',
    'Each step: {"title": short imperative objective, "detail": one sentence, "kind": "action"|"observation"|"verification", "parallelGroup": number}',
    'Mark truly independent steps with the same parallelGroup number (1,2,...). Dependent steps must NOT share a group.',
    `Maximum ${maxSteps} steps. Output STRICT JSON only: {"goal":"<refined goal>", "steps":[...]}`,
  ].join('\n');
  const payload = JSON.stringify({
    request,
    goal,
    availableTools: toolDefs.map((t) => ({ name: t.name, description: t.description, category: t.category })),
    reasoningLevel,
    maxSteps,
  });
  // v1.0.12 Phase 7 — custom task instructions travel BELOW the system
  // constraints as a delimited user section (hierarchy: system > task config
  // > user instructions > goal).
  const user = appendInstructionsBlock(payload, instructions);
  return { system, user };
}

export async function buildPlan(
  request: string,
  goal: string,
  toolDefs: ToolDefinition[],
  reasoningLevel: number,
  taskId?: string,
  maxSteps: number = DEFAULT_PRE_PLAN_MAX_STEPS,
  instructions?: string | null,
  signal?: AbortSignal,
): Promise<Plan> {
  const effectiveMaxSteps = Math.min(Math.max(Math.round(Number(maxSteps) || DEFAULT_PRE_PLAN_MAX_STEPS), 1), 122);
  const started = Date.now();
  let configuredTimeoutMs: number | null = 60_000;
  try {
    configuredTimeoutMs = getResolvedLimits().planner.llmTimeoutMs;
  } catch {
    /* limits file problem — keep the documented 60-second default */
  }
  try {
    const { system, user } = buildPlannerMessages(request, goal, toolDefs, reasoningLevel, effectiveMaxSteps, instructions);

    const { content } = await callLlm({
      messages: [
        { role: 'assistant', content: system },
        { role: 'user', content: user },
      ],
      timeoutMs: configuredTimeoutMs,
      signal,
    });

    const cleaned = (content ?? '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx > startIdx) {
      const parsed = JSON.parse(cleaned.slice(startIdx, endIdx + 1)) as { goal?: unknown; steps?: unknown };
      const refinedGoal = typeof parsed.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim().slice(0, 300) : goal;
      const steps = Array.isArray(parsed.steps) ? sanitizeSteps(parsed.steps as RawStep[], effectiveMaxSteps) : [];
      if (steps.length > 0) {
        void emitEvent({
          taskId,
          type: 'planner.plan_built',
          source: 'planner',
          message: `Plan built with ${steps.length} step(s) (llm, ${Date.now() - started}ms)`,
          data: { goal: refinedGoal, steps },
          priority: 6,
        });
        return { goal: refinedGoal, steps };
      }
    }
  } catch (err) {
    console.error('[planner] LLM planning failed, using deterministic fallback:', err);
  }

  const plan = fallbackPlan(request, goal);
  void emitEvent({
    taskId,
    type: 'planner.plan_built',
    source: 'planner',
    message: `Plan built with ${plan.steps.length} step(s) (deterministic fallback, ${Date.now() - started}ms)`,
    data: { goal, steps: plan.steps },
    priority: 6,
  });
  return plan;
}
