'use client';

/**
 * NexTool v1.0.14 §23 — the PRODUCTION ASSISTANT page (chat experience).
 *
 * A user-facing application built ON TOP of the NexTool runtime — separate
 * from the operator console: glassmorphism chat, the cute robot centerpiece
 * whose expression reflects REAL task state, live progress derived from real
 * runtime events, and user↔AI conversation through EVENTS (§8 — every chat
 * message is a `user.message` event that wakes the Live AI IMMEDIATELY).
 *
 * Hidden on purpose (§23.5): source code, Monaco, raw JSON payloads, internal
 * planner/debug views. Conversation + robot + progress + result only.
 * Operators can still open the full Task Preview from the header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useNexoolStream } from '@/hooks/use-nexool-stream';
import {
  ApiClientError, answerChoice, answerConfirmation, answerPrompt, createTask, dismissAlert,
  getTaskDetail, getTaskEvents, listAlerts, listChoices, listConfirmations,
  listPrompts, sendTaskEvent, stopTask,
} from '@/lib/nexool/client';
import type { NexToolEvent } from '@/lib/nexool/types';
import type { TaskDetail } from '@/lib/nexool/api-contract';
import type { PendingAlertDTO, PendingChoiceDTO, PendingConfirmationDTO, PendingPromptDTO } from '@/lib/nexool/client';
import { NexToolRobot, RobotMoodLabel, type RobotMood } from '../nexool-robot';
import { PulsingDot, TimeAgo } from '../ui-bits';
import { useConsoleStore } from '../console-store';
import { Loader2, Plus, Send, Square, X } from 'lucide-react';

const STORE_KEY = 'nextool.assistant.taskId';

/** The safe production toolset the assistant conversation runs with. */
const ASSISTANT_TOOLS = [
  'ask.self', 'ask.user',
  'echo.echo', 'math.evaluate', 'system.info', 'text.analyze', 'time.now', 'uuid.generate',
  'memory.store', 'memory.recall', 'notification.send',
  'fs.list', 'fs.readfile', 'fs.writefile', 'fs.find', 'fs.infofile',
];

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: string;
}

const ACTIVE = new Set(['queued', 'running', 'waiting', 'awaiting_approval', 'paused']);

/** Find balanced {...} spans in text (string-aware). */
function extractJsonSpans(text: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; } else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push({ start, end: i + 1, body: text.slice(start, i + 1) });
        start = -1;
      }
    }
  }
  return out;
}

/** §23.5 — the chat NEVER shows raw JSON: tool observations are rewritten
 *  into their friendliest human field (opinion/answer/summary/echo/message). */
function humanizeObservation(raw: string): string {
  let text = raw;
  const spans = extractJsonSpans(text);
  for (const span of spans.reverse()) {
    try {
      const obj = JSON.parse(span.body) as Record<string, unknown>;
      let friendly: string | null = null;
      for (const key of ['opinion', 'answer', 'summary', 'message', 'echo', 'text']) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) { friendly = v; break; }
      }
      if (friendly === null && obj.echo !== undefined && typeof obj.echo !== 'object') {
        friendly = String(obj.echo);
      }
      if (friendly !== null) {
        text = text.slice(0, span.start) + friendly + text.slice(span.end);
      }
    } catch { /* not JSON — leave untouched */ }
  }
  // strip tool-lifecycle prefixes: "ask.self completed: " → ""
  text = text.replace(/\b[\w.]+\s+(completed|failed|timed out|was cancelled):\s*/g, '');
  return text.trim();
}

function deriveMood(detail: TaskDetail | null, events: NexToolEvent[], interactions: number): RobotMood {
  if (!detail) return 'idle';
  const status = detail.status;
  if (status === 'failed') return 'error';
  if (status === 'completed') return 'happy';
  if (status === 'stopped' || status === 'cancelled') return 'idle';
  if (interactions > 0) return 'asking';
  if (status === 'awaiting_approval') return 'asking';
  const now = Date.now();
  const recent = (type: RegExp, withinMs: number) =>
    events.some((e) => type.test(e.type) && now - new Date(e.createdAt).getTime() < withinMs);
  if (ACTIVE.has(status)) {
    if (recent(/^core\.decision$/, 20_000)) return 'thinking';
    if (recent(/^tool\./, 45_000)) return 'working';
    if (recent(/^observer\.|^planner\./, 60_000)) return 'working';
    return status === 'waiting' ? 'waiting' : 'working';
  }
  return 'idle';
}

/** Human-readable progress steps from REAL runtime events (no simulation). */
function deriveSteps(events: NexToolEvent[]): { label: string; state: 'done' | 'active' | 'failed' | 'pending' }[] {
  const steps: { label: string; state: 'done' | 'active' | 'failed' | 'pending' }[] = [];
  const byExecution = new Map<string, { label: string; state: 'done' | 'active' | 'failed' | 'pending' }>();
  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const execId = typeof data.executionId === 'string' ? data.executionId : null;
    if (e.type === 'tool.started' && execId) {
      byExecution.set(execId, { label: String(data.tool ?? 'tool'), state: 'active' });
    } else if (e.type === 'tool.completed' && execId) {
      byExecution.set(execId, { label: String(data.tool ?? 'tool'), state: 'done' });
    } else if ((e.type === 'tool.failed' || e.type === 'tool.timeout' || e.type === 'tool.cancelled') && execId) {
      byExecution.set(execId, { label: String(data.tool ?? 'tool'), state: 'failed' });
    }
  }
  for (const s of byExecution.values()) steps.push(s);
  return steps.slice(-6);
}

export default function AssistantView() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [historyEvents, setHistoryEvents] = useState<NexToolEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [alerts, setAlerts] = useState<PendingAlertDTO[]>([]);
  const [prompts, setPrompts] = useState<PendingPromptDTO[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmationDTO[]>([]);
  const [choices, setChoices] = useState<PendingChoiceDTO[]>([]);
  const [answer, setAnswer] = useState('');
  const [stopping, setStopping] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);

  const { events: streamEvents } = useNexoolStream({ taskId: taskId ?? undefined, max: 300 });

  // restore the persisted conversation task
  useEffect(() => {
    let alive = true;
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORE_KEY) : null;
    if (!stored) { setBootstrapping(false); return; }
    getTaskDetail(stored)
      .then((d) => { if (alive) { setTaskId(stored); setDetail(d); } })
      .catch(() => { if (alive) window.localStorage.removeItem(STORE_KEY); })
      .finally(() => { if (alive) setBootstrapping(false); });
    return () => { alive = false; };
  }, []);

  // backfill older events once per task (REST replay) + merge with the stream
  useEffect(() => {
    if (!taskId) { setHistoryEvents([]); return; }
    let alive = true;
    getTaskEvents(taskId, { limit: 200 })
      .then((rows) => { if (alive) setHistoryEvents(rows); })
      .catch(() => { /* stream still provides live events */ });
    return () => { alive = false; };
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    getTaskDetail(taskId).then((d) => { if (alive) setDetail(d); }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [taskId, streamEvents.length]);

  // pending interactions for THIS conversation (production chat answers here)
  const loadInteractions = useCallback(async () => {
    if (!taskId) return;
    const [a, p, c, ch] = await Promise.allSettled([listAlerts(taskId), listPrompts(taskId), listConfirmations(taskId), listChoices(taskId)]);
    if (a.status === 'fulfilled') setAlerts(a.value.alerts);
    if (p.status === 'fulfilled') setPrompts(p.value.prompts);
    if (c.status === 'fulfilled') setConfirmations(c.value.confirmations);
    if (ch.status === 'fulfilled') setChoices(ch.value.choices);
  }, [taskId]);

  useEffect(() => {
    if (!taskId) { setAlerts([]); setPrompts([]); setConfirmations([]); setChoices([]); return; }
    void loadInteractions();
    const t = setInterval(() => void loadInteractions(), 2500);
    return () => clearInterval(t);
  }, [taskId, loadInteractions]);

  const events = useMemo(() => {
    // No conversation yet → NO events at all: the global stream (taskId-less
    // subscription) must never leak other tasks' activity into the hero view.
    if (!taskId) return [];
    const merged = new Map<string, NexToolEvent>();
    for (const e of historyEvents) merged.set(e.id, e);
    for (const e of streamEvents) if (e.taskId === taskId) merged.set(e.id, e);
    return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [historyEvents, streamEvents, taskId]);

  const messages = useMemo<ChatMessage[]>(() => {
    const out: ChatMessage[] = [];
    if (detail) {
      out.push({ id: 'request', role: 'user', text: detail.request, at: detail.createdAt });
    }
    for (const e of events) {
      if (e.type === 'user.message') {
        const data = (e.data ?? {}) as Record<string, unknown>;
        const text = typeof data.message === 'string' && data.message.trim() ? data.message.trim() : e.message;
        out.push({ id: e.id, role: 'user', text, at: e.createdAt });
      } else if (e.type === 'observer.observed' && e.message.trim()) {
        out.push({ id: e.id, role: 'assistant', text: humanizeObservation(e.message), at: e.createdAt });
      }
    }
    if (detail?.finalResult?.result && ['completed', 'failed', 'stopped'].includes(detail.status)) {
      const summary = (detail.finalResult.result as { summary?: unknown } | null | undefined)?.summary;
      if (typeof summary === 'string' && summary.trim()) {
        out.push({ id: 'final', role: 'assistant', text: humanizeObservation(summary), at: detail.completedAt ?? detail.createdAt });
      }
    }
    return out;
  }, [detail, events]);

  const steps = useMemo(() => deriveSteps(events), [events]);
  const pendingCount = alerts.length + prompts.length + confirmations.length + choices.length;
  const mood = deriveMood(detail, events, pendingCount);
  const active = detail ? ACTIVE.has(detail.status) : false;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingCount]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (!taskId) {
        const t = await createTask({
          request: text,
          config: {
            name: 'Assistant chat',
            mode: 'live',
            plannerType: 'one-by-one',
            enabledTools: ASSISTANT_TOOLS,
            // conversation: user messages may arrive in bursts — queue them.
            allowMultipleEvents: true,
            // §23 production UX: sandboxed builtin tools execute without the
            // operator approval gate; true user interactions (ask.user prompts,
            // confirmations, choices) still surface as chat cards.
            autoExecuteTools: true,
            useMemory: true,
            learnFrom: { feedback: true, results: true },
            limitContinuations: 1,
          },
        });
        window.localStorage.setItem(STORE_KEY, t.id);
        setTaskId(t.id);
        setDetail(t);
      } else {
        await sendTaskEvent(taskId, { type: 'user.message', payload: { message: text } });
        if (detail && !ACTIVE.has(detail.status)) {
          // a terminal conversation cannot wake — surface honest feedback
          toast.info('The previous conversation has ended', { description: 'Start a new conversation to continue chatting with the assistant.' });
        }
      }
      setDraft('');
    } catch (e) {
      toast.error('Could not send', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setSending(false);
    }
  };

  const newConversation = () => {
    window.localStorage.removeItem(STORE_KEY);
    setTaskId(null);
    setDetail(null);
    setHistoryEvents([]);
    setDraft('');
    toast.success('Ready for a new conversation', { description: 'The previous task (if still active) keeps running in Live Monitor.' });
  };

  const doStop = async () => {
    if (!taskId) return;
    setStopping(true);
    try {
      await stopTask(taskId);
      toast.success('Assistant stopped');
    } catch (e) {
      toast.error('Stop failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setStopping(false);
    }
  };

  const busyInteraction = async (fn: () => Promise<unknown>) => {
    try { await fn(); await loadInteractions(); } catch (e) {
      toast.error('Response failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-13rem)] min-h-[420px] w-full max-w-3xl flex-col gap-3 sm:h-[calc(100dvh-11rem)]">
      {/* header — robot + live status */}
      <div className="glass-card flex items-center gap-4 rounded-2xl p-4">
        <NexToolRobot mood={mood} size={92} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-tech text-sm uppercase tracking-wider text-foreground">NexTool Assistant</h2>
            {detail ? (
              <Badge variant="outline" className="gap-1.5 border-sky-400/30 bg-sky-400/10 font-tech text-[9px] uppercase tracking-wider text-sky-300">
                <PulsingDot tone={active ? 'info' : 'muted'} /> {detail.status}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-white/[0.09] font-tech text-[9px] uppercase tracking-wider text-muted-foreground">new</Badge>
            )}
          </div>
          <RobotMoodLabel mood={mood} />
          {steps.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {steps.map((s, i) => (
                <span key={`${s.label}-${i}`} className="inline-flex items-center gap-1 text-[11px]">
                  {s.state === 'done' ? <span className="text-emerald-300">✓</span>
                    : s.state === 'active' ? <span className="text-sky-300">●</span>
                    : s.state === 'failed' ? <span className="text-rose-300">✕</span>
                    : <span className="text-slate-500">○</span>}
                  <span className={cn('font-mono', s.state === 'failed' ? 'text-rose-300/90' : 'text-muted-foreground')}>{s.label}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {detail ? (
          <div className="flex shrink-0 flex-col gap-1.5">
            <Button size="sm" variant="outline" onClick={() => openTaskPreview(detail.id)} className="min-h-9 border-white/[0.09] text-[11px] text-muted-foreground">Details</Button>
            {active ? (
              <Button size="sm" variant="outline" onClick={() => void doStop()} disabled={stopping} className="min-h-9 border-rose-400/30 text-[11px] text-rose-300 hover:bg-rose-500/10">
                {stopping ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Square className="size-3.5" aria-hidden />} Stop
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={newConversation} className="min-h-9 gap-1 border-white/[0.09] text-[11px] text-muted-foreground"><Plus className="size-3.5" aria-hidden /> New</Button>
            )}
          </div>
        ) : null}
      </div>

      {/* conversation */}
      <div ref={scrollRef} className="glass-card nextool-scroll flex-1 space-y-2.5 overflow-y-auto rounded-2xl p-4" aria-live="polite">
        {!detail && !bootstrapping ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-foreground/80">Say hello — the assistant listens through events and acts immediately.</p>
            <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
              Your message starts a Live conversation task. Every following message is an event the AI reacts to instantly — questions, corrections, instructions, anything.
            </p>
          </div>
        ) : null}
        {bootstrapping ? (
          <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-sky-300" aria-hidden /></div>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed sm:max-w-[75%]',
                m.role === 'user'
                  ? 'rounded-br-md bg-primary-gradient text-primary-foreground'
                  : 'rounded-bl-md border border-white/[0.07] bg-white/[0.04] text-foreground/90',
              )}
            >
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              <p className={cn('mt-1 text-right font-mono text-[9px]', m.role === 'user' ? 'text-white/60' : 'text-slate-500')}>
                <TimeAgo iso={m.at} />
              </p>
            </div>
          </div>
        ))}
        {pendingCount > 0 ? (
          <p className="pt-1 text-center font-tech text-[10px] uppercase tracking-wider text-amber-300">the assistant needs your answer below</p>
        ) : null}
      </div>

      {/* interactions + composer */}
      <div className="space-y-2">
        {alerts.map((a) => (
          <div key={a.alertId} className="glass-card rounded-xl p-3">
            <p className="font-tech text-[10px] uppercase tracking-wider text-sky-300">assistant alert</p>
            <p className="mt-1 break-words text-xs text-foreground">{a.message}</p>
            <Button size="sm" onClick={() => void busyInteraction(() => dismissAlert(a.alertId))} className="mt-2 min-h-9 border-sky-400/30 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20">OK</Button>
          </div>
        ))}
        {prompts.map((p) => (
          <div key={p.promptId} className="glass-card rounded-xl p-3">
            <p className="font-tech text-[10px] uppercase tracking-wider text-cyan-300">assistant question{p.inputType && p.inputType !== 'text' ? ` · ${p.inputType}` : ''}</p>
            <p className="mt-1 break-words text-xs text-foreground">{p.message}</p>
            <div className="mt-2 flex gap-2">
              <input
                type={p.inputType === 'number' || p.inputType === 'email' || p.inputType === 'password' || p.inputType === 'date' || p.inputType === 'time' || p.inputType === 'color' ? p.inputType : 'text'}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={p.placeholder ?? 'Your answer…'}
                className="h-9 min-h-9 flex-1 rounded-md border border-white/[0.09] bg-white/[0.04] px-3 text-xs text-foreground"
                aria-label={`Answer: ${p.message.slice(0, 60)}`}
              />
              <Button size="sm" onClick={() => void busyInteraction(() => answerPrompt(p.promptId, answer || null))} className="min-h-9 border-cyan-400/30 bg-cyan-400/10 text-cyan-200 hover:bg-cyan-400/20">Send</Button>
              <Button size="sm" variant="outline" onClick={() => void busyInteraction(() => answerPrompt(p.promptId, null))} className="min-h-9 border-white/[0.09] text-muted-foreground"><X className="size-3.5" aria-hidden /></Button>
            </div>
          </div>
        ))}
        {confirmations.map((c) => (
          <div key={c.confirmId} className="glass-card rounded-xl p-3">
            <p className="font-tech text-[10px] uppercase tracking-wider text-amber-300">assistant confirmation</p>
            <p className="mt-1 break-words text-xs text-foreground">{c.message}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void busyInteraction(() => answerConfirmation(c.confirmId, true))} className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20">Confirm</Button>
              <Button size="sm" variant="outline" onClick={() => void busyInteraction(() => answerConfirmation(c.confirmId, false))} className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-500/10">Cancel</Button>
            </div>
          </div>
        ))}
        {choices.map((ch) => (
          <div key={ch.choiceId} className="glass-card rounded-xl p-3">
            <p className="font-tech text-[10px] uppercase tracking-wider text-violet-300">assistant choice</p>
            <p className="mt-1 break-words text-xs text-foreground">{ch.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {ch.options.map((opt) => (
                <Button key={opt.value} size="sm" variant="outline" onClick={() => void busyInteraction(() => answerChoice(ch.choiceId, opt.value))} className="min-h-9 border-violet-400/30 text-violet-200 hover:bg-violet-400/10">{opt.label ?? opt.value}</Button>
              ))}
            </div>
          </div>
        ))}

        <div className="glass-card flex items-end gap-2 rounded-2xl p-2.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={detail ? 'Message the assistant — it reacts to events immediately…' : 'Say hello to your assistant…'}
            className="max-h-32 min-h-11 flex-1 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
            aria-label="Message the assistant"
          />
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            className="min-h-11 gap-1.5 bg-primary-gradient px-4 text-primary-foreground hover:opacity-90"
            aria-label="Send message"
          >
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            <span className="hidden min-[420px]:inline">Send</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
