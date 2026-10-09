/**
 * NexTool v1.1.0 — the shared provider-call layer for EVERY LLM inference
 * path (CoreModule decisions, Planner plans, Observer verifications,
 * subgoal proposals, AskSelf). One place owns:
 *
 *  - the CONFIGURABLE timeout (no hidden hard-coded 20–30 s wrapper):
 *    callers pass the resolved limit (coreModule.llmTimeoutMs /
 *    planner.llmTimeoutMs / planner.verifyTimeoutMs); `null` = no
 *    application-level timeout — the call runs until the provider answers
 *    or fails on its own (spec §11.1);
 *  - CANCELLATION: an AbortSignal (task force-stop, §9) unblocks the caller
 *    immediately; when a stream is being consumed the reader stops and the
 *    record is cancelled;
 *  - ACTUAL STREAMING (spec §1.3): when `stream: true` is requested and the
 *    provider answers with an SSE body, deltas are forwarded to the caller
 *    as they arrive — the full text is still assembled and returned for the
 *    normal parse/validate pipeline. If the provider answers with a plain
 *    JSON body instead (no streaming support for that call), the response is
 *    used as-is and `streamed: false` is reported honestly — never fake
 *    token chunks.
 */

import { getZai } from './coremodule';

export class LlmCallCancelledError extends Error {
  constructor() {
    super('LLM call cancelled');
    this.name = 'LlmCallCancelledError';
  }
}

export interface LlmCallInput {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** Configured deadline in ms, or null = unlimited. */
  timeoutMs: number | null;
  signal?: AbortSignal;
  /** Forward provider deltas as they arrive (real streaming). */
  onDelta?: (delta: string, fullText: string) => void;
  /** Called when the provider answered without a stream body. */
  onNonStreamed?: () => void;
  thinking?: { type: 'enabled' | 'disabled' };
}

export interface LlmCallResult {
  content: string | undefined;
  streamed: boolean;
}

interface SseDeltaFrame {
  choices?: { delta?: { content?: string }; message?: { content?: string }; finish_reason?: string | null }[];
}

function extractDelta(frame: SseDeltaFrame): string {
  const choice = frame.choices?.[0];
  return choice?.delta?.content ?? '';
}

/** Consume an OpenAI-compatible SSE body, forwarding deltas as they land. */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string, fullText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new LlmCallCancelledError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const frame = JSON.parse(payload) as SseDeltaFrame;
          const delta = extractDelta(frame);
          if (delta) {
            full += delta;
            onDelta(delta, full);
          }
        } catch {
          /* keepalive/comment frames that are not JSON — ignore */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* reader already closed */
    }
  }
  return full;
}

/**
 * One provider chat completion with the shared timeout/abort/streaming
 * semantics. Never throws for "provider said no" style failures other than
 * cancellation — network/HTTP failures propagate to the caller's existing
 * failure handling (they already label them honestly).
 */
export async function callLlm(input: LlmCallInput): Promise<LlmCallResult> {
  const zai = await getZai();
  const { messages, timeoutMs, signal, onDelta, onNonStreamed } = input;

  // Manual timer + listener management — a completed call must not leave a
  // dangling setTimeout or an abort listener on the (long-lived) task signal.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise =
    timeoutMs !== null
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('LLM call timed out (configured deadline reached)')),
            timeoutMs,
          );
        })
      : null;

  const onAbort = () => rejectAbort(new LlmCallCancelledError());
  let abortReject: ((err: Error) => void) | null = null;
  function rejectAbort(err: Error): void {
    abortReject?.(err);
  }
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortReject = reject;
        if (signal.aborted) reject(new LlmCallCancelledError());
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  const races: Promise<unknown>[] = [];
  if (abortPromise) races.push(abortPromise);
  if (timeoutPromise) races.push(timeoutPromise);

  const run = (async (): Promise<LlmCallResult> => {
    try {
      const wantsStream = typeof onDelta === 'function';
      const res = await zai.chat.completions.create({
        messages,
        thinking: input.thinking ?? { type: 'disabled' },
        ...(wantsStream ? { stream: true } : {}),
      });

      // Streaming path — the SDK returns the raw web ReadableStream when the
      // provider answered with an SSE/text body and stream was requested.
      if (wantsStream && res && typeof (res as { getReader?: unknown }).getReader === 'function') {
        const text = await consumeStream(res as ReadableStream<Uint8Array>, onDelta!, signal);
        return { content: text || undefined, streamed: true };
      }

      // Non-streamed answer (either streaming was not requested or the
      // provider ignored the flag and answered JSON) — honest reporting.
      if (wantsStream) onNonStreamed?.();
      const content = (res as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
      return { content: content ?? undefined, streamed: false };
    } finally {
      cleanup();
    }
  })();

  try {
    if (races.length === 0) return await run;
    return (await Promise.race([run, ...races])) as LlmCallResult;
  } catch (err) {
    cleanup();
    throw err;
  }
}
