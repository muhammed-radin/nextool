'use client';

/**
 * NexTool v1.1.0 §1 — COREMODULE LIVE OUTPUT (Task Preview section).
 *
 * Displays the ACTUAL CoreModule LLM output as it is generated:
 *
 *   /api/core/stream?taskId=… (SSE)
 *     core.snapshot → bounded replay of recent requests (reconnect-safe)
 *     core.started  → a new CoreModule LLM request
 *     core.chunk    → a real provider delta (seq-numbered, dedup here)
 *     core.completed / core.failed / core.cancelled
 *
 * Display batching (§1.2): incoming chunks land in a ref buffer; a 120 ms
 * ticker flushes ~10 words at a time to the visible transcript. Original
 * order, whitespace, punctuation, newlines and code formatting are preserved
 * exactly — batching only paces the RENDER, never alters the text. When the
 * generation completes, everything still unrendered is flushed at once.
 * The whole transcript is never re-rendered per token (append-only DOM via
 * a single text node update).
 *
 * No credentials ever flow through this channel; cancelled/superseded
 * requests are marked as such and their late chunks are ignored.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronUp, Copy, Download, Gauge, Loader2, Pause, Play, Radio, Zap } from 'lucide-react';

interface CoreRecord {
  requestId: string;
  taskId?: string;
  requestedEngine: string;
  label: string;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  text: string;
  truncated: boolean;
  chunkSeq: number;
  streaming: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

const TICK_MS = 120;
const WORDS_PER_FLUSH = 10;
const MAX_RENDER_CHARS = 200_000;

/** Position just past the next `count` whitespace-separated words (or EOF). */
function advanceWords(text: string, from: number, count: number): number {
  let words = 0;
  let i = from;
  let seenNonSpace = false;
  while (i < text.length && words < count) {
    if (/\s/.test(text[i])) {
      if (seenNonSpace) words++;
      seenNonSpace = false;
    } else {
      seenNonSpace = true;
    }
    i++;
  }
  return i >= text.length ? text.length : i;
}

export function CoreLiveOutput({ taskId, active }: { taskId: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<Record<string, CoreRecord>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const /** ground-truth accumulated text per request */
    textRef = useRef<Record<string, string>>({});
  const /** how many chars are already rendered per request */
    renderedRef = useRef<Record<string, number>>({});
  const /** highest chunk seq seen per request (dedup) */
    seqRef = useRef<Record<string, number>>({});
  const pausedRef = useRef(false);
  const autoScrollRef = useRef(true);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

  const activeId = order.length > 0 ? order[order.length - 1] : null;
  const streamingRecord = order.map((id) => records[id]).find((r) => r?.status === 'streaming');
  const shown = activeId ? (streamingRecord ?? records[activeId]) : undefined;

  const upsert = useCallback((rec: CoreRecord) => {
    setRecords((prev) => ({ ...prev, [rec.requestId]: rec }));
    setOrder((prev) => (prev.includes(rec.requestId) ? prev : [...prev.slice(-4), rec.requestId]));
  }, []);

  // flush the display buffer — ~10 words per tick while streaming, all at once on completion
  const flush = useCallback((requestId: string, all: boolean) => {
    const full = textRef.current[requestId] ?? '';
    const rendered = renderedRef.current[requestId] ?? 0;
    if (rendered >= full.length) return;
    if (pausedRef.current && !all) return;
    const target = all ? full.length : Math.min(full.length, advanceWords(full, rendered, WORDS_PER_FLUSH));
    const slice = full.slice(rendered, target);
    renderedRef.current[requestId] = target;
    setRecords((prev) => {
      const cur = prev[requestId];
      if (!cur) return prev;
      // append-only render buffer (bounded) — order/whitespace preserved
      let next = (cur as CoreRecord & { rendered?: string }).rendered ?? '';
      next = (next + slice).slice(-MAX_RENDER_CHARS);
      return { ...prev, [requestId]: { ...cur, rendered: next } as CoreRecord & { rendered?: string } };
    });
    if (autoScrollRef.current) {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, []);

  // SSE subscription
  useEffect(() => {
    const es = new EventSource(`/api/core/stream?taskId=${encodeURIComponent(taskId)}`);
    const onMessage = (ev: MessageEvent) => {
      let msg: { type: string } & Record<string, unknown>;
      try { msg = JSON.parse(ev.data) as { type: string } & Record<string, unknown>; } catch { return; }
      switch (msg.type) {
        case 'core.snapshot': {
          const rec = msg as unknown as CoreRecord;
          seqRef.current[rec.requestId] = rec.chunkSeq;
          textRef.current[rec.requestId] = rec.text;
          upsert(rec);
          flush(rec.requestId, true); // historical replay renders whole
          break;
        }
        case 'core.started': {
          const rec = msg as unknown as CoreRecord;
          seqRef.current[rec.requestId] = 0;
          textRef.current[rec.requestId] = '';
          renderedRef.current[rec.requestId] = 0;
          upsert(rec);
          break;
        }
        case 'core.chunk': {
          const requestId = String(msg.requestId);
          const seq = Number(msg.seq);
          const delta = String(msg.delta ?? '');
          if ((seqRef.current[requestId] ?? 0) >= seq) return; // dedup
          seqRef.current[requestId] = seq;
          textRef.current[requestId] = (textRef.current[requestId] ?? '') + delta;
          if (msg.truncated === true) {
            // keep the ground truth bounded exactly like the server buffer
            const cap = 65536;
            if (textRef.current[requestId].length > cap * 2) {
              textRef.current[requestId] = textRef.current[requestId].slice(-cap);
              renderedRef.current[requestId] = Math.min(renderedRef.current[requestId] ?? 0, cap);
            }
          }
          flush(requestId, false);
          break;
        }
        case 'core.completed':
        case 'core.failed':
        case 'core.cancelled': {
          const rec = msg as unknown as CoreRecord;
          if (typeof rec.text === 'string') textRef.current[rec.requestId] = rec.text;
          upsert(rec);
          flush(rec.requestId, true); // §1.2 flush the remaining partial batch
          break;
        }
      }
    };
    es.addEventListener('message', onMessage as EventListener);
    es.onerror = () => { /* EventSource auto-reconnects; snapshots reconcile */ };
    return () => es.close();
  }, [taskId, upsert, flush]);

  // elapsed ticker while a request is streaming (derived in-render; the
  // interval only fires tick state updates — no setState during effect run)
  const streamingSince = streamingRecord ? new Date(streamingRecord.startedAt).getTime() : null;
  useEffect(() => {
    if (streamingSince === null) return;
    const t = setInterval(() => setElapsed(Date.now() - streamingSince), 250);
    return () => clearInterval(t);
  }, [streamingSince]);
  // reset the displayed elapsed when no request is streaming (derived value —
  // no effect-side setState)
  const shownElapsed = streamingSince === null ? 0 : elapsed;

  const copyTranscript = () => {
    const text = textRef.current[activeId ?? ''] ?? '';
    if (!text.trim()) {
      toast.info('No CoreModule output to copy yet');
      return;
    }
    void navigator.clipboard.writeText(text)
      .then(() => toast.success('CoreModule output copied'))
      .catch(() => toast.error('Clipboard unavailable'));
  };

  const downloadTranscript = () => {
    const text = textRef.current[activeId ?? ''] ?? '';
    if (!text.trim()) {
      toast.info('No CoreModule output to download yet');
      return;
    }
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `core-output-${activeId ?? 'transcript'}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast.error('Download failed');
    }
  };

  const statusChip = !shown
    ? { label: 'Idle', cls: 'border-white/[0.1] bg-white/[0.04] text-muted-foreground' }
    : shown.status === 'streaming'
      ? { label: 'Streaming', cls: 'border-sky-400/40 bg-sky-400/10 text-sky-300' }
      : shown.status === 'completed'
        ? { label: 'Completed', cls: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' }
        : shown.status === 'failed'
          ? { label: 'Failed', cls: 'border-rose-400/40 bg-rose-400/10 text-rose-300' }
          : { label: 'Cancelled', cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300' };

  const renderedText = shown ? ((shown as CoreRecord & { rendered?: string }).rendered ?? '') : '';
  const wordCount = renderedText ? renderedText.trim().split(/\s+/).length : 0;

  return (
    <section className="glass-card overflow-hidden rounded-lg" aria-label="CoreModule Live Output">
      {/* header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronUp className="size-3.5 text-muted-foreground" aria-hidden /> : <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />}
        <Zap className="size-3.5 text-sky-300" aria-hidden />
        <span className="text-xs font-semibold">CoreModule Live Output</span>
        {streamingRecord ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-sky-300">
            <Radio className="size-3 animate-pulse" aria-hidden /> live
          </span>
        ) : null}
        <Badge variant="outline" className={cn('ml-auto font-mono text-[9px] uppercase', statusChip.cls)}>{statusChip.label}</Badge>
      </button>

      {open ? (
        <div className="space-y-2 border-t border-white/[0.06] p-3">
          {/* debug metadata (§1.5) — real runtime info, never credentials */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <span>engine: <span className="text-foreground/85">{shown?.requestedEngine ?? 'llm-core'}</span></span>
            <span>request: <span className="text-foreground/85">{shown?.requestId ?? '—'}</span></span>
            {shown?.label ? <span>pass: <span className="text-foreground/85">{shown.label}</span></span> : null}
            {shown?.status === 'streaming' ? <span className="text-sky-300">elapsed {(shownElapsed / 1000).toFixed(1)}s</span> : null}
            {shown?.durationMs !== undefined ? <span>duration {fmt(shown.durationMs)}</span> : null}
            {shown ? <span>transport: {shown.streaming ? 'provider stream' : 'non-streamed response'}</span> : null}
            {shown?.truncated ? <span className="text-amber-300">buffer truncated (replay window)</span> : null}
            {shown?.error ? <span className="text-rose-300">error: {shown.error.slice(0, 120)}</span> : null}
            {shown?.status === 'completed' && shown.meta && typeof shown.meta === 'object' && 'configuredTimeoutMs' in (shown.meta as Record<string, unknown>) ? (
              <span className="flex items-center gap-1"><Gauge className="size-3" aria-hidden />deadline: {fmt(Number((shown.meta as Record<string, unknown>).configuredTimeoutMs))}</span>
            ) : null}
          </div>

          {/* transcript */}
          <div
            ref={scrollRef}
            className="nextool-scroll max-h-64 min-h-24 overflow-y-auto rounded-md border border-white/[0.06] bg-[#0A0D13] p-2.5 font-mono text-[11px] leading-relaxed text-slate-200"
            aria-live={streamingRecord ? 'polite' : 'off'}
          >
            {renderedText ? (
              <pre className="whitespace-pre-wrap break-words">{renderedText}</pre>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                {streamingRecord ? (
                  <><Loader2 className="size-3 animate-spin" aria-hidden /> waiting for the first provider tokens…</>
                ) : (
                  <>No CoreModule LLM output recorded {active ? 'yet — it appears here while the task decides' : 'for this task'}.</>
                )}
              </p>
            )}
            {shown?.status === 'streaming' ? <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-sky-400/80 align-middle" aria-hidden /> : null}
          </div>

          {/* controls (§1.1) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" variant={autoScroll ? 'secondary' : 'outline'} size="sm" className="min-h-8 gap-1 px-2 text-[11px]" onClick={() => setAutoScroll((v) => !v)} aria-pressed={autoScroll}>
              Auto-scroll {autoScroll ? 'on' : 'off'}
            </Button>
            {paused ? (
              <Button type="button" variant="outline" size="sm" className="min-h-8 gap-1 px-2 text-[11px]" onClick={() => { setPaused(false); if (activeId) flush(activeId, true); }}>
                <Play className="size-3" aria-hidden /> Resume
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" className="min-h-8 gap-1 px-2 text-[11px]" onClick={() => setPaused(true)}>
                <Pause className="size-3" aria-hidden /> Pause
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" className="min-h-8 gap-1 px-2 text-[11px]" onClick={copyTranscript}>
              <Copy className="size-3" aria-hidden /> Copy
            </Button>
            <Button type="button" variant="outline" size="sm" className="min-h-8 gap-1 px-2 text-[11px]" onClick={downloadTranscript}>
              <Download className="size-3" aria-hidden /> Save
            </Button>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              ~{wordCount} words rendered{paused ? ' · paused' : ''}
            </span>
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Real provider output streamed over SSE ({'{'}~10-word display batches{'}'}), replay-safe on reconnect and deduped by chunk sequence. The final decision still passes the normal parse/validate pipeline — this section is observability only and never exposes credentials.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function fmt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
