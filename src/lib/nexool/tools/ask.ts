/**
 * NexTool v1.0.14 — AskSelf (ask.self) + AskForUser (ask.user) builtin tools.
 *
 * AskSelf (§15): ask NexTool ITSELF to generate/derive content — reasoning,
 * explanations, self-description, choice generation, planning fragments —
 * instead of executing an external action. Returns `{ success, opinion }`.
 * Also usable as a SUBTOOL (`context.tools.call('ask.self', …)`): builtins
 * are allowed in the subtool API in both production and test runtimes.
 *
 * AskForUser (§16): ask the human OPERATOR for information NexTool does not
 * have or should not guess. Pauses THIS tool until the user answers through
 * the console/assistant interaction UI (or the 120s window expires — the
 * result is then `success: false`, never a fabricated answer).
 */

import { ToolFailure, type ToolHandler } from './handler';
import { getZai } from '../core/coremodule';
import { createRuntimeInteractions } from './sandbox-interactive';

const ASK_SELF_TIMEOUT_MS = 30_000;

const ASK_SELF_SYSTEM = [
  'You are NexTool — a self-hosted, local-first AI task-processing and automation runtime (single-user operator console).',
  'You are answering as YOURSELF (AskSelf): generate, explain, reason or describe — you are NOT executing an external action.',
  'Answer in the same language as the request. Be concrete, correct and concise.',
  'If a requested output pattern is given (e.g. "one choice per line"), follow it EXACTLY.',
].join(' ');

interface AskSelfParams {
  prompt: string;
  context?: string;
  memory?: string[];
  pattern?: string;
  history?: string[];
}

function coerceStringArray(value: unknown, max: number, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ToolFailure(`Parameter "${label}" must be an array of strings.`, 'INVALID_PARAMS');
  const out = value
    .map((v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)))
    .map((v) => v.slice(0, 1000))
    .filter((v) => v.trim().length > 0)
    .slice(0, max);
  return out.length > 0 ? out : undefined;
}

/** AskSelf — generate/derive content from NexTool itself. */
export const askSelf: ToolHandler = async (params) => {
  const promptText = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  if (!promptText) throw new ToolFailure('Missing required param: prompt', 'INVALID_PARAMS');
  if (promptText.length > 8000) throw new ToolFailure('Parameter "prompt" must be at most 8000 characters.', 'INVALID_PARAMS');

  const spec: AskSelfParams = {
    prompt: promptText,
    ...(typeof params.context === 'string' && params.context.trim() ? { context: params.context.slice(0, 4000) } : {}),
    ...{ memory: coerceStringArray(params.memory, 10, 'memory') },
    ...(typeof params.pattern === 'string' && params.pattern.trim() ? { pattern: params.pattern.slice(0, 300) } : {}),
    ...{ history: coerceStringArray(params.history, 12, 'history') },
  };

  try {
    const zai = await getZai();
    const res = await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: 'system' as const, content: ASK_SELF_SYSTEM },
          { role: 'user' as const, content: JSON.stringify(spec) },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AskSelf LLM call timed out')), ASK_SELF_TIMEOUT_MS),
      ),
    ]);
    const opinion = (res?.choices?.[0]?.message?.content ?? '').trim();
    if (!opinion) {
      return { success: false, opinion: '', error: 'AskSelf produced an empty response.' };
    }
    return { success: true, opinion };
  } catch (err) {
    return {
      success: false,
      opinion: '',
      error: `AskSelf failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/** AskForUser — pause until the operator answers (never fabricate an answer). */
export const askUser: ToolHandler = async (params, ctx) => {
  const message = typeof params.message === 'string' ? params.message.trim() : '';
  if (!message) throw new ToolFailure('Missing required param: message', 'INVALID_PARAMS');
  if (message.length > 2000) throw new ToolFailure('Parameter "message" must be at most 2000 characters.', 'INVALID_PARAMS');
  const placeholder = typeof params.placeholder === 'string' && params.placeholder.trim()
    ? params.placeholder.trim().slice(0, 200)
    : undefined;
  const defaultValue = typeof params.defaultValue === 'string' && params.defaultValue.length > 0
    ? params.defaultValue.slice(0, 4000)
    : undefined;

  const interactions = createRuntimeInteractions(ctx.taskId, ctx.executionId, 'ask.user');
  const answer = await interactions.prompt({
    message,
    type: 'text',
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  });

  if (answer === null) {
    return {
      success: false,
      question: message,
      answer: null,
      error: 'No user response (cancelled or the 120s window expired).',
    };
  }
  return {
    success: true,
    question: message,
    answer,
    answeredAt: new Date().toISOString(),
  };
};
