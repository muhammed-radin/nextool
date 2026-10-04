/**
 * NexTool Observer — interprets tool executions and checks goal completion.
 */
import type { ToolExecution } from '../types';
import { emitEvent } from '../eventbus';
// v1.0.11 §50 — the shared cached client (one init per process, every path).
import { getZai } from '../core/coremodule';
// v1.0.12 Phase 7 — custom task instructions (delimited user block).
import { appendInstructionsBlock } from '../instructions';

const VERIFY_TIMEOUT_MS = 6_000;

/** Produce a concise operational observation from a tool execution. */
export function interpret(
  toolName: string,
  execution: ToolExecution,
  state?: { goal?: string; lastObservation?: string },
): string {
  if (execution.status === 'timeout') {
    return `${toolName} timed out after ${execution.durationMs ?? 0}ms — no result observed.`;
  }
  if (execution.status === 'cancelled') {
    return `${toolName} execution was cancelled.`;
  }
  if (execution.status === 'failed') {
    return `${toolName} failed: ${execution.error?.message ?? 'unknown error'}.`;
  }

  const result = execution.result as Record<string, unknown> | undefined;
  if (result && typeof result === 'object') {
    // domain-aware summaries
    if (typeof result.health === 'string' && 'serverId' in result) {
      return `Server ${String(result.serverId)} health: ${result.health} (cpu ${String(result.cpu)}%, mem ${String(result.memory)}%).`;
    }
    if (result.environment === 'virtual-env' && Array.isArray(result.servers)) {
      const servers = result.servers as { id: string; health: string }[];
      return `Environment overview: ${servers.map((s) => `${s.id}=${s.health}`).join(', ')}.`;
    }
    if (result.status === 'restart_initiated') {
      return `${String(result.serverId ?? 'server')} restart initiated; expected healthy in ~${String(result.healthyAfterMs ?? 2500)}ms.`;
    }
    if ('echo' in result) return `Echo result: ${String(result.echo).slice(0, 160)}.`;
    if ('waitedMs' in result) return `Waited ${String(result.waitedMs)}ms.`;
    if ('result' in result && 'expression' in result) return `Math result: ${String(result.expression)} = ${String(result.result)}.`;
    if ('imagePath' in result) return `Image generated and saved at ${String(result.imagePath)}.`;
    if ('id' in result && 'level' in result && 'title' in result) return `Notification [${String(result.level)}] sent: ${String(result.title)}.`;
    if ('found' in result) {
      return result.found ? `Memory recalled: ${JSON.stringify(result.value ?? result.matches ?? {}).slice(0, 160)}.` : `Memory recall found nothing${result.key ? ` for key ${String(result.key)}` : ''}.`;
    }
    if ('key' in result && 'value' in result) return `Memory stored under key "${String(result.key)}".`;
    if ('hostname' in result && 'platform' in result) {
      return `Host ${String(result.hostname)}: ${String(result.platform)}/${String(result.arch)}, ${String(result.cpus)} CPUs, load ${JSON.stringify(result.loadavg)}.`;
    }
    if ('iso' in result && 'formatted' in result) return `Current time: ${String(result.formatted)}.`;
    if ('count' in result && 'uuids' in result) return `Generated ${String(result.count)} UUID(s).`;
    if ('chars' in result && 'words' in result) return `Text stats: ${String(result.words)} words, ${String(result.chars)} chars, ${String(result.sentences)} sentences.`;
    if ('status' in result && 'body' in result) return `HTTP GET returned status ${String(result.status)}.`;
    return `${toolName} completed: ${JSON.stringify(result).slice(0, 220)}.`;
  }
  return `${toolName} completed successfully.`;
}

const SUCCESS_MARKERS = [
  'healthy', 'completed successfully', 'generated and saved', 'sent:', 'recalled', 'stored under key',
  'math result', 'current time', 'generated', 'http get returned status 2',
];

export interface GoalCheck {
  complete: boolean;
  reason: string;
  engine: 'llm-core' | 'heuristic-fallback';
}

/**
 * Pure message builder for the goal-completion check (exported for
 * deterministic unit tests — v1.0.12 Phase 7). FIXED system block FIRST;
 * custom task instructions are appended AFTER the user payload as a delimited
 * block (hierarchy: system > task config > user instructions > goal).
 */
export function buildGoalCheckMessages(
  goal: string,
  observation: string,
  instructions?: string | null,
): { system: string; user: string } {
  const system = [
    'You are the Observer of NexTool. Given the goal and the latest observation, decide whether the goal is now achieved based on actual observed state.',
    'Output STRICT JSON only: {"complete": true|false, "reason": "one concise sentence"}',
  ].join('\n');
  const payload = JSON.stringify({ goal, observation });
  // v1.0.12 Phase 7 — instructions travel BELOW the system constraints.
  const user = appendInstructionsBlock(payload, instructions);
  return { system, user };
}

/** Decide whether the goal is achieved based on the latest observation.
 *  v1.0.12 Phase 7 — `instructions` (combined custom task instructions) is
 *  appended to the USER message as a delimited block BELOW the fixed system
 *  constraints, so success/failure handling and verification requirements
 *  defined by the user reach the Observer. */
export async function checkGoalComplete(
  goal: string,
  observation: string,
  reasoningLevel: number,
  taskId?: string,
  instructions?: string | null,
): Promise<GoalCheck> {
  if (reasoningLevel <= 2) {
    const obsLower = observation.toLowerCase();
    const positive = SUCCESS_MARKERS.some((m) => obsLower.includes(m));
    const negative = obsLower.includes('failed') || obsLower.includes('timed out') || obsLower.includes('unhealthy') || obsLower.includes('nothing');
    return {
      complete: positive && !negative,
      reason: positive && !negative
        ? 'Observation contains success markers (heuristic verification).'
        : 'Observation does not yet indicate goal completion (heuristic verification).',
      engine: 'heuristic-fallback',
    };
  }

  try {
    const zai = await getZai();
    const { system, user } = buildGoalCheckMessages(goal, observation, instructions);
    const res = await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: 'assistant' as const, content: system },
          { role: 'user' as const, content: user },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Observer verify timed out')), VERIFY_TIMEOUT_MS),
      ),
    ]);
    const content = res?.choices?.[0]?.message?.content ?? '';
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { complete?: unknown; reason?: unknown };
      const complete = parsed.complete === true;
      const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : 'Observer verification.';
      return { complete, reason, engine: 'llm-core' };
    }
  } catch (err) {
    console.error('[observer] LLM verify failed, falling back to heuristic:', err);
    void emitEvent({
      taskId,
      type: 'observer.verify_fallback',
      source: 'observer',
      message: 'LLM verification unavailable — heuristic completion check used.',
      priority: 8,
    });
  }
  return { complete: false, reason: 'Verification unavailable — assuming goal not yet complete.', engine: 'heuristic-fallback' };
}

// ---------- v1.0.11 — pre-plan recovery assessment ----------

export interface RecoveryAssessment {
  /** The failed condition has been resolved (step objective satisfied or the
   *  blocking condition removed). */
  resolved: boolean;
  /** The main goal can safely continue. false ONLY when the Observer
   *  determines the situation cannot safely proceed (end immediately). */
  recoverable: boolean;
  reason: string;
  engine: 'llm-core' | 'heuristic-fallback';
}

/**
 * v1.0.11 §10/§12 — Observer authority for recovery outcomes. Recovery
 * succeeds when the failed condition is resolved OR the main goal can safely
 * continue; recoverable=false ends the task immediately (no wasted retries).
 *
 * Heuristic fallback is deliberately CONSERVATIVE: resolved=false +
 * recoverable=true — the failed step is re-queued and its real re-execution
 * (verified by the normal flow) becomes the verification. A merely-completed
 * recovery step status is never treated as sufficient proof on its own.
 */
export async function assessRecovery(
  input: {
    stepTitle: string;
    stepDetail?: string;
    failure: string;
    recoverySteps: { title: string; status: string }[];
    observations: string[];
  },
  reasoningLevel: number,
  taskId?: string,
): Promise<RecoveryAssessment> {
  if (reasoningLevel > 2) {
    try {
      const zai = await getZai();
      const res = await Promise.race([
        zai.chat.completions.create({
          messages: [
            {
              role: 'assistant' as const,
              content: [
                'You are the Observer of NexTool, assessing a FAILED plan step after a recovery attempt.',
                'Decide:',
                '- "resolved": the failed condition is now resolved (the step objective is satisfied by the recovery actions, or the blocking condition was removed).',
                '- "recoverable": the main goal can safely continue. Use false ONLY when the situation clearly cannot proceed (required capability missing, unrecoverable environment).',
                'Output STRICT JSON only: {"resolved": true|false, "recoverable": true|false, "reason": "one concise sentence"}',
              ].join('\n'),
            },
            { role: 'user' as const, content: JSON.stringify(input) },
          ],
          thinking: { type: 'disabled' },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Recovery assessment timed out')), VERIFY_TIMEOUT_MS),
        ),
      ]);
      const content = res?.choices?.[0]?.message?.content ?? '';
      const cleaned = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { resolved?: unknown; recoverable?: unknown; reason?: unknown };
        const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : 'Observer recovery assessment.';
        return {
          resolved: parsed.resolved === true,
          recoverable: parsed.recoverable !== false,
          reason,
          engine: 'llm-core',
        };
      }
    } catch (err) {
      console.error('[observer] recovery assessment failed, conservative fallback:', err);
      void emitEvent({
        taskId,
        type: 'observer.verify_fallback',
        source: 'observer',
        message: 'LLM recovery assessment unavailable — conservative fallback used (step re-queued for real verification).',
        priority: 8,
      });
    }
  }
  return {
    resolved: false,
    recoverable: true,
    reason: 'Assessment unavailable — the failed step is re-queued; its re-execution provides the verification.',
    engine: 'heuristic-fallback',
  };
}
