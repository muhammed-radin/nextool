/**
 * NexTool Observer — interprets tool executions and checks goal completion.
 */
import ZAI from 'z-ai-web-dev-sdk';
import type { ToolExecution } from '../types';
import { emitEvent } from '../eventbus';

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

/** Decide whether the goal is achieved based on the latest observation. */
export async function checkGoalComplete(
  goal: string,
  observation: string,
  reasoningLevel: number,
  taskId?: string,
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
    const zai = await ZAI.create();
    const res = await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: 'assistant' as const,
            content: [
              'You are the Observer of NexTool. Given the goal and the latest observation, decide whether the goal is now achieved based on actual observed state.',
              'Output STRICT JSON only: {"complete": true|false, "reason": "one concise sentence"}',
            ].join('\n'),
          },
          { role: 'user' as const, content: JSON.stringify({ goal, observation }) },
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
