/**
 * NexTool Planner — decomposes a request into ordered, minimal steps.
 * LLM-driven with a deterministic fallback plan.
 */
import ZAI from 'z-ai-web-dev-sdk';
import type { PlanStep, ToolDefinition } from '../types';
import { emitEvent } from '../eventbus';

const PLANNER_TIMEOUT_MS = 25_000;
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

export async function buildPlan(
  request: string,
  goal: string,
  toolDefs: ToolDefinition[],
  reasoningLevel: number,
  taskId?: string,
  maxSteps: number = DEFAULT_PRE_PLAN_MAX_STEPS,
): Promise<Plan> {
  const effectiveMaxSteps = Math.min(Math.max(Math.round(Number(maxSteps) || DEFAULT_PRE_PLAN_MAX_STEPS), 1), 122);
  const started = Date.now();
  try {
    const zai = await ZAI.create();
    const system = [
      'You are the Planner of NexTool, a task-processing system (not a chatbot).',
      'Decompose the request into minimal ordered steps. Each step is one concrete operational action.',
      'Each step: {"title": short imperative objective, "detail": one sentence, "kind": "action"|"observation"|"verification", "parallelGroup": number}',
      'Mark truly independent steps with the same parallelGroup number (1,2,...). Dependent steps must NOT share a group.',
      `Maximum ${effectiveMaxSteps} steps. Output STRICT JSON only: {"goal":"<refined goal>", "steps":[...]}`,
    ].join('\n');
    const user = JSON.stringify({
      request,
      goal,
      availableTools: toolDefs.map((t) => ({ name: t.name, description: t.description, category: t.category })),
      reasoningLevel,
      maxSteps: effectiveMaxSteps,
    });

    const res = await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: 'assistant' as const, content: system },
          { role: 'user' as const, content: user },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Planner LLM call timed out')), PLANNER_TIMEOUT_MS),
      ),
    ]);

    const content = res?.choices?.[0]?.message?.content ?? '';
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
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
