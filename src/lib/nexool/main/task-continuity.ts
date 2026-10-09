/**
 * NexTool v1.1.0 §2/§3 — TASK CONTINUITY (Continue Task + fork-from-recent).
 *
 * A terminal task (completed/stopped/failed) can seed a NEW task with its
 * most relevant context. The old task is NEVER mutated and its history is
 * NEVER dumped wholesale into the new prompt: this builder selects the
 * relevant classes (per the operator's contextOptions) and renders a BOUNDED
 * block (continuity.maxContextChars) that runTask prepends to the new task's
 * instructions as a delimited prior-task-context section.
 *
 * Selected skills are inherited from the source task by default (§12.3):
 * the caller reads them from the persisted skills.selected event and passes
 * them as the new task's manual skills — the operator can still change them.
 */

import { db } from '@/lib/db';
import { getResolvedLimits } from '../config-limits';
import type { TaskConfig } from '../types';

export interface PriorContextOptions {
  result?: boolean;
  plan?: boolean;
  executions?: boolean;
  memory?: boolean;
  skills?: boolean;
}

export interface PriorContext {
  sourceTaskId: string;
  sourceStatus: string;
  sourceRequest: string;
  sourceName?: string;
  block: string;
  selectedSkills: string[];
  truncated: boolean;
}

function clip(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build the prior-task context block. Never throws — a missing source or a
 * read failure yields an honest "(unavailable)" note instead of breaking
 * task creation.
 */
export async function buildPriorContext(
  sourceTaskId: string,
  opts: PriorContextOptions,
): Promise<PriorContext | null> {
  let limits: { maxContextChars: number; maxExecutionRows: number; maxObservations: number };
  try {
    const r = getResolvedLimits().continuity;
    limits = { maxContextChars: r.maxContextChars, maxExecutionRows: r.maxExecutionRows, maxObservations: r.maxObservations };
  } catch {
    limits = { maxContextChars: 12_000, maxExecutionRows: 12, maxObservations: 8 };
  }

  let row: {
    id: string; name: string | null; request: string; goal: string | null; status: string;
    statusDetail: string | null; finalResult: string | null; state: string | null; plan: string | null;
  } | null = null;
  try {
    row = await db.task.findUnique({
      where: { id: sourceTaskId },
      select: { id: true, name: true, request: true, goal: true, status: true, statusDetail: true, finalResult: true, state: true, plan: true },
    });
  } catch {
    row = null;
  }
  if (!row) return null;

  const sections: string[] = [];
  const header = [
    `<prior-task-context source="${row.id}" status="${row.status}">`,
    `Prior task: ${row.name ? `${row.name} — ` : ''}${clip(row.request, 300)}`,
  ];
  if (row.statusDetail) header.push(`Prior outcome: ${clip(row.statusDetail, 200)}`);

  const parsed = <T,>(raw: string | null): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  // result + last observations (§2.2 "final output/result", "last observations")
  if (opts.result !== false) {
    const finalResult = parsed<{ result?: { summary?: string }; status?: string }>(row.finalResult);
    const state = parsed<{ observations?: { at: string; message: string }[]; lastObservation?: string }>(row.state);
    const lines: string[] = [];
    if (finalResult?.result?.summary) lines.push(`- Final result: ${clip(finalResult.result.summary, 600)}`);
    const observations = (state?.observations ?? []).slice(-Math.max(0, limits.maxObservations));
    for (const o of observations) lines.push(`- Observation: ${clip(o.message, 240)}`);
    if (lines.length > 0) sections.push('Result & recent observations:\n' + lines.join('\n'));
  }

  // plan steps with their real statuses ("relevant plan steps")
  if (opts.plan) {
    const plan = parsed<{ id: string; title: string; status: string }[]>(row.plan);
    if (plan && plan.length > 0) {
      const lines = plan.slice(0, 30).map((s) => `- [${s.status}] ${clip(s.title, 160)}`);
      sections.push('Plan (status per step):\n' + lines.join('\n'));
    }
  }

  // recent tool executions ("tool execution results") — summaries, not payloads
  if (opts.executions !== false && limits.maxExecutionRows > 0) {
    try {
      const history = await db.historyEntry.findMany({
        where: { taskId: row.id },
        orderBy: { timestamp: 'desc' as const },
        take: limits.maxExecutionRows,
        select: { action: true, status: true, params: true, result: true },
      });
      if (history.length > 0) {
        const lines = history.map((h) => {
          let detail = '';
          try {
            const p = typeof h.params === 'string' ? (JSON.parse(h.params) as Record<string, unknown>) : (h.params as Record<string, unknown> | null);
            const firstVal = p ? Object.values(p)[0] : undefined;
            if (typeof firstVal === 'string' || typeof firstVal === 'number') detail = ` (${clip(String(firstVal), 80)})`;
          } catch { /* no params detail */ }
          return `- ${h.action} → ${h.status}${detail}`;
        });
        sections.push('Recent tool executions (newest first — do NOT re-run these automatically):\n' + lines.join('\n'));
      }
    } catch { /* history read failed — skip the section */ }
  }

  // cross-task memory references
  if (opts.memory) {
    try {
      const memories = await db.memoryEntry.findMany({ orderBy: { createdAt: 'desc' as const }, take: 5, select: { key: true, value: true } });
      if (memories.length > 0) {
        const lines = memories.map((m) => `- ${m.key}: ${clip(typeof m.value === 'string' ? m.value : JSON.stringify(m.value), 160)}`);
        sections.push('Relevant memory entries:\n' + lines.join('\n'));
      }
    } catch { /* skip */ }
  }

  // inherited selected skills (persisted on the SOURCE task's skills.selected event)
  let selectedSkills: string[] = [];
  if (opts.skills !== false) {
    try {
      const skillEvents = await db.taskEvent.findMany({
        where: { taskId: row.id, type: 'skills.selected' },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { data: true },
      });
      const data = skillEvents[0]?.data ? (JSON.parse(skillEvents[0].data) as { selected?: string[] }) : null;
      if (Array.isArray(data?.selected)) selectedSkills = data!.selected!.slice(0, 12);
    } catch { /* skip */ }
  }
  if (selectedSkills.length > 0 && opts.skills !== false) {
    sections.push(`Skills the prior task used (inherited — can be changed): ${selectedSkills.join(', ')}`);
  }

  let block = [...header, ...sections, '</prior-task-context>'].join('\n');
  let truncated = false;
  if (block.length > limits.maxContextChars) {
    block = `${block.slice(0, limits.maxContextChars - 40)}\n…[prior-task context truncated at ${limits.maxContextChars} chars — continuity.maxContextChars]</prior-task-context>`;
    truncated = true;
  }

  return {
    sourceTaskId: row.id,
    sourceStatus: row.status,
    sourceRequest: row.request,
    sourceName: row.name ?? undefined,
    block,
    selectedSkills,
    truncated,
  };
}

/** Carry continuation/fork/skills/executeAll fields into the persisted config. */
export function continuityFieldsFromConfig(cfg: TaskConfig): Partial<TaskConfig> {
  const out: Partial<TaskConfig> = {};
  if (cfg.continuationOfTaskId) out.continuationOfTaskId = cfg.continuationOfTaskId;
  if (cfg.forkedFromTaskId) out.forkedFromTaskId = cfg.forkedFromTaskId;
  if (cfg.contextOptions) out.contextOptions = cfg.contextOptions;
  if (cfg.skills) out.skills = cfg.skills;
  if (cfg.skillsMode) out.skillsMode = cfg.skillsMode;
  if (typeof cfg.executeAllPlannedSteps === 'boolean') out.executeAllPlannedSteps = cfg.executeAllPlannedSteps;
  return out;
}
