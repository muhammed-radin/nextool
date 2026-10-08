'use client';

/**
 * Live Monitor (spec §54-55) — live-mode task cards, environment server grid
 * with crash/degrade/recover injection, and the filtered live event stream.
 * v1.0.1: glass surfaces, sky "live" accents, mobile-first card order (LIVE →
 * task → status → subgoal → observation → next tick → events → stop action)
 * and a full-width min-h-11 stop button with confirm dialog on every card.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useConsoleStore } from '../console-store';
import { useGlobalStream } from '../providers';
import { ApiClientError, answerChoice, answerConfirmation, answerPrompt, dismissAlert, getLiveState, getTaskDetail, injectEnvEvent, listAlerts, listApprovals, listChoices, listConfirmations, listLimitContinuations, listPrompts, listTasks, listVerifications, pauseTask, resolveApprovalRequest, resolveLimitContinuationRequest, resolveVerificationRequest, resumeTask, stopTask } from '@/lib/nexool/client';
import type { PendingAlertDTO, PendingApprovalDTO, PendingChoiceDTO, PendingConfirmationDTO, PendingLimitContinuationDTO, PendingPromptDTO, PendingVerificationDTO } from '@/lib/nexool/client';
import { ApprovalCard } from '@/components/console/approval-card';
import type { GlobalLiveState, NexToolEvent, TaskSummary } from '@/lib/nexool/types';
import type { TaskDetail } from '@/lib/nexool/api-contract';
import { ServerCard } from '../server-card';
import { TaskChecklist } from '../task-checklist';
import { RuntimeTerminal } from '../terminal';
import { EmptyState, ErrorCard, PulsingDot, SectionTitle, StatusChip, TimeAgo, fmtMs } from '../ui-bits';
import { Ban, Check, ChevronDown, CirclePause, CirclePlay, Gauge, ListChecks, Loader2, MessageSquareQuote, MessageSquareWarning, RadioTower, ShieldAlert, ShieldCheck, Square, Timer, X } from 'lucide-react';

const STREAM_SOURCES = new Set(['environment', 'planner', 'core', 'tool']);

/** Shared per-session preview preference — checklist is the default (spec §67/§69). */
function readTerminalPreference(): boolean {
  try {
    return window.localStorage.getItem('nextool.previewAsTerminal') === '1';
  } catch {
    return false;
  }
}

interface LiveTaskCardData {
  summary: TaskSummary;
  detail: TaskDetail | null;
  eventCount: number;
  lastTickAt: string | null;
}

// v1.0.13 — adds operator choice / verification latch / safety-limit continuation cards.
function LiveTaskCard({ data, taskEvents, approvals, alerts, prompts, confirmations, choices, verifications, continuations, onStop, stopping, onPause, onResume, pauseResumeBusy, onResolveApproval, resolvingApproval, onDismissAlert, onAnswerPrompt, answeringPrompt, onAnswerConfirmation, answeringConfirmation, onAnswerChoice, answeringChoice, onResolveVerification, resolvingVerification, onResolveContinuation, resolvingContinuation, onOpen }: {
  data: LiveTaskCardData;
  taskEvents: NexToolEvent[];
  approvals: PendingApprovalDTO[];
  alerts: PendingAlertDTO[];
  prompts: PendingPromptDTO[];
  confirmations: PendingConfirmationDTO[];
  choices: PendingChoiceDTO[];
  verifications: PendingVerificationDTO[];
  continuations: PendingLimitContinuationDTO[];
  onStop: (id: string) => void;
  stopping: boolean;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  pauseResumeBusy: boolean;
  onResolveApproval: (approvalId: string, decision: 'accept' | 'skip' | 'reject', feedback?: string) => void;
  resolvingApproval: boolean;
  onDismissAlert: (alertId: string) => void;
  onAnswerPrompt: (promptId: string, value: string | null) => void;
  answeringPrompt: boolean;
  onAnswerConfirmation: (confirmId: string, accepted: boolean) => void;
  answeringConfirmation: boolean;
  onAnswerChoice: (choiceId: string, value: string | null) => void;
  answeringChoice: boolean;
  onResolveVerification: (verificationId: string, accepted: boolean) => void;
  resolvingVerification: boolean;
  onResolveContinuation: (continuationId: string, decision: 'continue' | 'deny') => void;
  resolvingContinuation: boolean;
  onOpen: (id: string) => void;
}) {
  const { summary, detail, eventCount, lastTickAt } = data;
  const interval = detail?.config?.liveIntervalMs;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [asTerminal, setAsTerminal] = useState<boolean | null>(null);
  const [promptAnswer, setPromptAnswer] = useState<string>('');
  const paused = summary.status === 'paused';
  // v1.0.14 — the monitor shows the LIVE queue (queued + processing only);
  // settled entries (processed/failed/cancelled/dropped) stay visible in the
  // task's own event lifecycle trail instead of lingering here.
  const queue = (detail?.state?.eventQueue ?? []).filter((q) => q.status === 'queued' || q.status === 'processing');
  const nextTickEstimate = useMemo(() => {
    if (!lastTickAt || !interval || paused) return null;
    const elapsed = Date.now() - new Date(lastTickAt).getTime();
    const remaining = Math.max(0, interval - elapsed);
    return `~${Math.ceil(remaining / 1000)}s`;
  }, [lastTickAt, interval, paused]);

  // Default Live Mode visualization is the CHECKLIST (spec §62) — restore the
  // per-session "Preview as Terminal" preference on mount.
  useEffect(() => {
    setAsTerminal(readTerminalPreference());
  }, []);

  return (
    <div className="glass-card rounded-lg p-4">
      {/* Priority row: LIVE badge · status · task · stop (desktop) */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1.5 border-sky-400/30 bg-sky-400/10 font-tech text-[9px] uppercase tracking-wider text-sky-300">
          <PulsingDot tone="info" /> live
        </Badge>
        <StatusChip status={summary.status} />
        <button
          type="button"
          onClick={() => onOpen(summary.id)}
          className="min-w-0 flex-1 truncate rounded text-left font-mono text-xs text-foreground/90 outline-ring/50 hover:text-sky-300 hover:underline focus-visible:ring-2"
          aria-label={`Open preview for live task ${summary.id.slice(0, 8)}`}
        >
          {summary.name || summary.request}
        </button>
        <Button
          variant="outline"
          size="sm"
          disabled={stopping || pauseResumeBusy}
          onClick={() => (paused ? onResume(summary.id) : onPause(summary.id))}
          className="hidden min-h-11 border-sky-400/30 text-sky-300 hover:bg-sky-400/10 sm:inline-flex"
          aria-label={paused ? `Resume live task ${summary.id.slice(0, 8)}` : `Pause live task ${summary.id.slice(0, 8)}`}
        >
          {paused ? <CirclePlay className="size-3.5" aria-hidden /> : <CirclePause className="size-3.5" aria-hidden />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={stopping}
          onClick={() => onStop(summary.id)}
          className="hidden min-h-11 border-rose-500/40 text-rose-300 hover:bg-rose-500/10 sm:inline-flex"
          aria-label={`Stop live task ${summary.id.slice(0, 8)}`}
        >
          <Square className="size-3.5" aria-hidden /> Stop
        </Button>
      </div>

      {/* v1.0.6 §11.3 — paused banner (state stays intact; resume continues) */}
      {paused ? (
        <p className="mt-2 flex items-center gap-1.5 rounded-md border border-sky-400/25 bg-sky-400/5 px-2.5 py-1.5 font-mono text-[11px] text-sky-300" role="status">
          <CirclePause className="size-3.5 shrink-0" aria-hidden />
          Paused — no new planner actions or tool executions. Queued events are retained. Resume continues from this state.
        </p>
      ) : null}

      {/* Priority info: subgoal → last observation → next tick → events */}
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="min-w-0 text-foreground/90">
          <span className="text-muted-foreground">subgoal: </span>
          {detail?.state?.activeSubgoal?.title ?? '—'}
        </p>
        <p className="min-w-0 text-foreground/90 sm:truncate">
          <span className="text-muted-foreground">last observation: </span>
          {detail?.state?.lastObservation ?? '—'}
        </p>
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Timer className="size-3 shrink-0" aria-hidden />
          tick {interval ? fmtMs(interval) : '—'}
          {nextTickEstimate ? ` · next ${nextTickEstimate}` : ''}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground">events {eventCount} · steps {summary.steps} · tools {summary.toolCalls}</p>
      </div>

      {/* Stop action — full-width, easy to reach on mobile */}
      <div className="mt-3 grid gap-2 sm:hidden">
        <Button
          variant="outline"
          disabled={stopping || pauseResumeBusy}
          onClick={() => (paused ? onResume(summary.id) : onPause(summary.id))}
          className="min-h-11 w-full justify-center border-sky-400/30 text-sky-300 hover:bg-sky-400/10"
          aria-label={paused ? `Resume live task ${summary.id.slice(0, 8)}` : `Pause live task ${summary.id.slice(0, 8)}`}
        >
          {paused ? <CirclePlay className="size-4" aria-hidden /> : <CirclePause className="size-4" aria-hidden />}
          {paused ? 'Resume Live' : 'Pause Live'}
        </Button>
        <Button
          variant="outline"
          disabled={stopping}
          onClick={() => onStop(summary.id)}
          className="min-h-11 w-full justify-center border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
          aria-label={`Stop live task ${summary.id.slice(0, 8)}`}
        >
          <Square className="size-4" aria-hidden /> Stop live task
        </Button>
      </div>

      {/* v1.0.15 §31-§35 — approval request: [Skip] [Reject] [Accept] with
          tool description, environment, params, target/reason and subgoal. */}
      {approvals.length > 0 ? (
        <div className="mt-3 space-y-2" role="alert">
          {approvals.map((a) => (
            <ApprovalCard key={a.approvalId} approval={a} busy={resolvingApproval} onResolve={onResolveApproval} />
          ))}
        </div>
      ) : null}

      {/* v1.0.14 §20 — pending interactive alerts: OK dismisses, tool resumes */}
      {alerts.length > 0 ? (
        <div className="mt-3 space-y-2">
          {alerts.map((a) => (
            <div key={a.alertId} className="rounded-md border border-sky-400/30 bg-sky-400/[0.05] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-sky-300">
                <MessageSquareQuote className="size-3.5" aria-hidden /> tool alert {a.toolName ? `· ${a.toolName}` : ''}
              </p>
              <p className="mt-1 break-words text-xs text-foreground">{a.message}</p>
              <div className="mt-2 flex">
                <Button size="sm" disabled={answeringPrompt} onClick={() => onDismissAlert(a.alertId)} className="min-h-9 border-sky-400/30 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20">OK</Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* v1.0.6 §1.6 — pending tool prompts: answer or cancel without blocking the runtime */}
      {prompts.length > 0 ? (
        <div className="mt-3 space-y-2">
          {prompts.map((p) => (
            <div key={p.promptId} className="rounded-md border border-cyan-400/30 bg-cyan-400/[0.05] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-cyan-300">
                <MessageSquareQuote className="size-3.5" aria-hidden /> tool prompt {p.toolName ? `· ${p.toolName}` : ''}
              </p>
              <p className="mt-1 break-words text-xs text-foreground">{p.message}</p>
              <div className="mt-2 flex gap-2">
                <Input
                  value={promptAnswer}
                  onChange={(e) => setPromptAnswer(e.target.value)}
                  placeholder="Your answer…"
                  className="min-h-9 flex-1 border-white/[0.09] bg-white/[0.04] text-xs"
                  aria-label={`Answer for prompt: ${p.message.slice(0, 60)}`}
                />
                <Button
                  size="sm"
                  disabled={answeringPrompt}
                  onClick={() => {
                    onAnswerPrompt(p.promptId, promptAnswer.trim() || null);
                    setPromptAnswer('');
                  }}
                  className="min-h-9 border-cyan-400/30 bg-cyan-400/10 text-cyan-200 hover:bg-cyan-400/20"
                >
                  Send
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={answeringPrompt}
                  onClick={() => onAnswerPrompt(p.promptId, null)}
                  className="min-h-9 border-white/[0.09] text-muted-foreground"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* v1.0.8 §1.5 — pending tool confirmations ([waiting] Tool confirmation requested) */}
      {confirmations.length > 0 ? (
        <div className="mt-3 space-y-2">
          {confirmations.map((c) => (
            <div key={c.confirmId} className="rounded-md border border-amber-400/30 bg-amber-400/[0.05] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-amber-300">
                <MessageSquareWarning className="size-3.5" aria-hidden /> tool confirmation {c.toolName ? `· ${c.toolName}` : ''}
              </p>
              <p className="mt-1 break-words text-xs text-foreground">{c.message}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={answeringConfirmation}
                  onClick={() => onAnswerConfirmation(c.confirmId, true)}
                  className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                >
                  <Check className="size-3.5" aria-hidden /> Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={answeringConfirmation}
                  onClick={() => onAnswerConfirmation(c.confirmId, false)}
                  className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                >
                  <X className="size-3.5" aria-hidden /> Cancel
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* v1.0.13 — operator choice requests (askForUserAsChoice): pick ONE option or cancel */}
      {choices.length > 0 ? (
        <div className="mt-3 space-y-2">
          {choices.map((ch) => (
            <div key={ch.choiceId} className="rounded-md border border-violet-400/30 bg-violet-400/[0.05] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-violet-300">
                <ListChecks className="size-3.5" aria-hidden /> operator choice {ch.toolName ? `· ${ch.toolName}` : ''}
              </p>
              <p className="mt-1 break-words text-xs text-foreground">{ch.message}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ch.options.map((opt) => (
                  <Button
                    key={opt.value}
                    size="sm"
                    variant="outline"
                    disabled={answeringChoice}
                    onClick={() => onAnswerChoice(ch.choiceId, opt.value)}
                    className="min-h-9 border-violet-400/30 text-violet-200 hover:bg-violet-400/10"
                  >
                    {opt.label ?? opt.value}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={answeringChoice}
                  onClick={() => onAnswerChoice(ch.choiceId, null)}
                  className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                >
                  <X className="size-3.5" aria-hidden /> Cancel
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* v1.0.13 — verification latch: the operator must verify the held-open tool result */}
      {verifications.length > 0 ? (
        <div className="mt-3 space-y-2">
          {verifications.map((v) => (
            <div key={v.verificationId} className="rounded-md border border-cyan-400/30 bg-cyan-400/[0.05] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-cyan-300">
                <ShieldCheck className="size-3.5" aria-hidden /> verification required · {v.tool}
              </p>
              {v.resultSummary ? (
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[10px] text-slate-300 nextool-scroll">{v.resultSummary}</pre>
              ) : null}
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={resolvingVerification}
                  onClick={() => onResolveVerification(v.verificationId, true)}
                  className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                >
                  <Check className="size-3.5" aria-hidden /> Verify result
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolvingVerification}
                  onClick={() => onResolveVerification(v.verificationId, false)}
                  className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                >
                  <X className="size-3.5" aria-hidden /> Reject
                </Button>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">rejecting fails the execution (VERIFICATION_REJECTED) · auto-verifies after 5 min</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* v1.0.13 — safety-limit continuation: grant extra budget or end the task */}
      {continuations.length > 0 ? (
        <div className="mt-3 space-y-2">
          {continuations.map((lc) => (
            <div key={lc.continuationId} className="rounded-md border border-amber-400/30 bg-amber-400/[0.05] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-amber-300">
                <Gauge className="size-3.5" aria-hidden /> safety limit · {lc.limitKind}
              </p>
              <p className="mt-1 break-words text-xs text-foreground">
                iterations {lc.iterations}/{lc.maxIterations} · tool calls {lc.toolCalls}/{lc.safetyLimit} — continue with +{lc.extraBudget} more of each?
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={resolvingContinuation}
                  onClick={() => onResolveContinuation(lc.continuationId, 'continue')}
                  className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                >
                  <Check className="size-3.5" aria-hidden /> Continue +{lc.extraBudget}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolvingContinuation}
                  onClick={() => onResolveContinuation(lc.continuationId, 'deny')}
                  className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                >
                  <X className="size-3.5" aria-hidden /> End task
                </Button>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">denying ends the task as limit_reached · auto-denied after 5 min</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* v1.0.6 §10.8 — event queue (multi-event mode): real runtime state */}
      {queue.length > 0 ? (
        <Collapsible className="mt-3">
          <CollapsibleTrigger className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-slate-300 hover:bg-white/[0.06]">
            <span>event queue · {queue.filter((q) => q.status === 'queued').length} queued</span>
            <ChevronDown className="size-4 text-sky-300/70" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="glass-inset nextool-scroll mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md p-2">
              {queue.map((q) => (
                <p key={q.seq} className="flex items-center gap-2 font-mono text-[10px]">
                  <span className={cn('size-1.5 shrink-0 rounded-full', q.status === 'processing' ? 'bg-amber-300' : 'bg-slate-500')} aria-hidden />
                  <span className={q.status === 'processing' ? 'text-amber-300' : 'text-slate-400'}>{q.status === 'processing' ? '●' : '○'}</span>
                  <span className="text-foreground/90">{q.type}</span>
                  <span className="text-muted-foreground">seq {q.seq} · prio {q.priority}</span>
                  <span className="ml-auto shrink-0 text-slate-500">{q.status}</span>
                </p>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {/* v1.0.2 §62-68: live checklist/timeline (default) with terminal toggle.
          Both views consume the SAME runtime event stream. */}
      <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
        <CollapsibleTrigger className="mt-3 flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-slate-300 hover:bg-white/[0.06]">
          <span className="flex items-center gap-2">
            {asTerminal ? <span className="font-mono">terminal preview</span> : <span>live checklist</span>}
            <span className="font-mono text-[10px] text-muted-foreground">{eventCount} events</span>
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const next = !(asTerminal ?? false);
                setAsTerminal(next);
                try {
                  window.localStorage.setItem('nextool.previewAsTerminal', next ? '1' : '0');
                } catch { /* session-only */ }
              }}
              className="rounded border border-sky-400/25 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-sky-300 outline-ring/50 hover:bg-sky-400/10 focus-visible:ring-2"
            >
              Preview as Terminal: {asTerminal ? 'ON' : 'OFF'}
            </button>
            <ChevronDown className={cn('size-4 text-sky-300/70 transition-transform', previewOpen && 'rotate-180')} aria-hidden />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          {asTerminal === true ? (
            <RuntimeTerminal taskId={summary.id} events={taskEvents} taskStatus={summary.status} />
          ) : (
            // v1.0.3 §2: prefer the fresher state.plan (written on every state persist).
            <TaskChecklist plan={detail?.state?.plan?.length ? detail.state.plan : detail?.plan} events={taskEvents} taskStatus={summary.status} />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default function LiveMonitorView() {
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);
  const { events } = useGlobalStream();

  const [liveState, setLiveState] = useState<GlobalLiveState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [liveTasks, setLiveTasks] = useState<TaskSummary[] | null>(null);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [stopCandidate, setStopCandidate] = useState<string | null>(null);
  // v1.0.6 — approval/prompt/pause interaction state
  const [approvalsByTask, setApprovalsByTask] = useState<Record<string, PendingApprovalDTO[]>>({});
  const [promptsByTask, setPromptsByTask] = useState<Record<string, PendingPromptDTO[]>>({});
  // v1.0.14 §20 — pending interactive alerts per active task
  const [alertsByTask, setAlertsByTask] = useState<Record<string, PendingAlertDTO[]>>({});
  // v1.0.8 §1.5 — pending confirmations per active task
  const [confirmationsByTask, setConfirmationsByTask] = useState<Record<string, PendingConfirmationDTO[]>>({});
  // v1.0.13 — operator choices / verification latches / safety-limit continuations per active task
  const [choicesByTask, setChoicesByTask] = useState<Record<string, PendingChoiceDTO[]>>({});
  const [verificationsByTask, setVerificationsByTask] = useState<Record<string, PendingVerificationDTO[]>>({});
  const [continuationsByTask, setContinuationsByTask] = useState<Record<string, PendingLimitContinuationDTO[]>>({});
  const [pauseResumeBusy, setPauseResumeBusy] = useState(false);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [answeringPrompt, setAnsweringPrompt] = useState(false);
  const [answeringConfirmation, setAnsweringConfirmation] = useState(false);
  const [answeringChoice, setAnsweringChoice] = useState(false);
  const [resolvingVerification, setResolvingVerification] = useState(false);
  const [resolvingContinuation, setResolvingContinuation] = useState(false);

  const load = useCallback(async () => {
    const [stateRes, tasksRes] = await Promise.allSettled([getLiveState(), listTasks({ mode: 'live', limit: 50 })]);
    if (stateRes.status === 'fulfilled') {
      setLiveState(stateRes.value);
      setStateError(null);
    } else {
      setStateError(stateRes.reason instanceof ApiClientError ? stateRes.reason.message : 'Live state unavailable');
    }
    if (tasksRes.status === 'fulfilled') {
      setLiveTasks(tasksRes.value);
      // v1.0.6 §9.6/§1.7 — poll pending approvals + prompts per active task.
      const activeIds = tasksRes.value
        .filter((t) => ['running', 'waiting', 'queued', 'paused', 'awaiting_approval'].includes(t.status))
        .map((t) => t.id);
      const nextApprovals: Record<string, PendingApprovalDTO[]> = {};
      const nextAlerts: Record<string, PendingAlertDTO[]> = {};
      const nextPrompts: Record<string, PendingPromptDTO[]> = {};
      const nextConfirmations: Record<string, PendingConfirmationDTO[]> = {};
      const nextChoices: Record<string, PendingChoiceDTO[]> = {};
      const nextVerifications: Record<string, PendingVerificationDTO[]> = {};
      const nextContinuations: Record<string, PendingLimitContinuationDTO[]> = {};
      await Promise.all(
        activeIds.map(async (id) => {
          // v1.0.13 — the interaction poll is now a 6-tuple: approvals, prompts,
          // confirmations, choices, verifications, limit continuations.
          const [a, al, p, c, ch, v, lc] = await Promise.allSettled([listApprovals(id), listAlerts(id), listPrompts(id), listConfirmations(id), listChoices(id), listVerifications(id), listLimitContinuations(id)]);
          if (a.status === 'fulfilled') nextApprovals[id] = a.value.approvals;
          if (al.status === 'fulfilled') nextAlerts[id] = al.value.alerts;
          if (p.status === 'fulfilled') nextPrompts[id] = p.value.prompts;
          if (c.status === 'fulfilled') nextConfirmations[id] = c.value.confirmations;
          if (ch.status === 'fulfilled') nextChoices[id] = ch.value.choices;
          if (v.status === 'fulfilled') nextVerifications[id] = v.value.verifications;
          if (lc.status === 'fulfilled') nextContinuations[id] = lc.value.continuations;
        }),
      );
      setApprovalsByTask(nextApprovals);
      setAlertsByTask(nextAlerts);
      setPromptsByTask(nextPrompts);
      setConfirmationsByTask(nextConfirmations);
      setChoicesByTask(nextChoices);
      setVerificationsByTask(nextVerifications);
      setContinuationsByTask(nextContinuations);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  // Pull details for live tasks (subgoal, interval, observation).
  useEffect(() => {
    const ids = (liveTasks ?? []).filter((t) => ['running', 'waiting', 'queued', 'paused', 'awaiting_approval'].includes(t.status)).map((t) => t.id);
    if (ids.length === 0) return;
    let alive = true;
    void Promise.allSettled(ids.map((id) => getTaskDetail(id))).then((results) => {
      if (!alive) return;
      setDetails((prev) => {
        const next = { ...prev };
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') next[ids[i]] = r.value;
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [liveTasks]);

  const stopTaskById = async (id: string) => {
    setStoppingId(id);
    try {
      await stopTask(id);
      toast.success('Stop signal sent', { description: `Live task #${id.slice(0, 8)} cancellation requested.` });
      void load();
    } catch (e) {
      toast.error('Stop failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setStoppingId(null);
      setStopCandidate(null);
    }
  };

  const inject = async (type: 'server.crash' | 'server.degrade' | 'server.recover', serverId: string) => {
    setInjecting(true);
    try {
      await injectEnvEvent({ type, serverId });
      toast.success('Environment event injected', { description: `${type} → ${serverId}` });
      void load();
    } catch (e) {
      toast.error('Injection failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setInjecting(false);
    }
  };

  // v1.0.6 §11 — pause preserves everything; only new actions stop.
  const pauseById = async (id: string) => {
    setPauseResumeBusy(true);
    try {
      await pauseTask(id);
      toast.success('Task paused', { description: 'State is preserved — Resume Live continues from here.' });
      void load();
    } catch (e) {
      toast.error('Pause failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPauseResumeBusy(false);
    }
  };

  const resumeById = async (id: string) => {
    setPauseResumeBusy(true);
    try {
      await resumeTask(id);
      toast.success('Task resumed', { description: 'Continuing from the preserved state — queued events process next.' });
      void load();
    } catch (e) {
      toast.error('Resume failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPauseResumeBusy(false);
    }
  };

  // v1.0.15 §31-§34 — Accept executes; Skip records `skipped` + continues;
  // Reject blocks (escalation ladder). Optional feedback becomes an event.
  const resolveApprovalById = async (approvalId: string, decision: 'accept' | 'skip' | 'reject', feedback?: string) => {
    setResolvingApproval(true);
    try {
      const res = await resolveApprovalRequest(approvalId, decision, feedback);
      if (res.resolved) {
        const label = decision === 'accept' ? 'Tool accepted' : decision === 'skip' ? 'Tool skipped' : 'Tool rejected';
        const desc = decision === 'accept'
          ? 'Executing; the plan continues.'
          : decision === 'skip'
            ? 'Not executed — marked skipped; the plan continues with the next logical step.'
            : 'Not executed — the planner must revise the plan or stop.';
        toast.success(label, { description: desc });
      } else {
        toast.info('Approval no longer pending', { description: res.reason ?? 'It may have timed out or been resolved elsewhere.' });
      }
      void load();
    } catch (e) {
      toast.error('Approval failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setResolvingApproval(false);
    }
  };

  // v1.0.6 §1.6 — answer/cancel a pending tool prompt.
  const answerPromptById = async (promptId: string, value: string | null) => {
    setAnsweringPrompt(true);
    try {
      await answerPrompt(promptId, value);
      void load();
    } catch (e) {
      toast.error('Prompt failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setAnsweringPrompt(false);
    }
  };

  // v1.0.14 §20 — dismiss an interactive alert; the paused tool resumes.
  const dismissAlertById = async (alertId: string) => {
    setAnsweringPrompt(true);
    try {
      await dismissAlert(alertId);
      void load();
    } catch (e) {
      toast.error('Dismiss failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setAnsweringPrompt(false);
    }
  };

  // v1.0.8 §1.2 — the user's boolean decision resumes the waiting tool.
  const answerConfirmationById = async (confirmId: string, accepted: boolean) => {
    setAnsweringConfirmation(true);
    try {
      await answerConfirmation(confirmId, accepted);
      void load();
      toast.success(accepted ? 'Confirmation allowed' : 'Confirmation denied');
    } catch (e) {
      toast.error('Confirmation failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setAnsweringConfirmation(false);
    }
  };

  // v1.0.13 — the operator's option pick resumes the waiting tool (null cancels).
  const answerChoiceById = async (choiceId: string, value: string | null) => {
    setAnsweringChoice(true);
    try {
      await answerChoice(choiceId, value);
      void load();
      toast.success(value === null ? 'Choice cancelled' : 'Choice submitted', {
        description: value === null ? 'The tool receives no answer.' : `The tool receives: ${value}`,
      });
    } catch (e) {
      toast.error('Choice failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setAnsweringChoice(false);
    }
  };

  // v1.0.13 — verify the held-open tool result; rejecting fails the execution (VERIFICATION_REJECTED).
  const resolveVerificationById = async (verificationId: string, accepted: boolean) => {
    setResolvingVerification(true);
    try {
      await resolveVerificationRequest(verificationId, accepted);
      void load();
      toast.success(accepted ? 'Result verified' : 'Result rejected', {
        description: accepted ? 'The execution completes with your verification.' : 'The execution fails as VERIFICATION_REJECTED.',
      });
    } catch (e) {
      toast.error('Verification failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setResolvingVerification(false);
    }
  };

  // v1.0.13 — 'continue' grows the limits and resumes the task; 'deny' ends it as limit_reached.
  const resolveContinuationById = async (continuationId: string, decision: 'continue' | 'deny') => {
    setResolvingContinuation(true);
    try {
      await resolveLimitContinuationRequest(continuationId, decision);
      void load();
      toast.success(decision === 'continue' ? 'Budget granted' : 'Continuation denied', {
        description: decision === 'continue' ? 'The limits grow and the task resumes.' : 'The task ends as limit_reached.',
      });
    } catch (e) {
      toast.error('Continuation failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setResolvingContinuation(false);
    }
  };

  const liveTaskEvents = (taskId: string) => events.filter((ev) => ev.taskId === taskId).length;
  const lastTick = (taskId: string) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.taskId === taskId && (ev.type.includes('tick') || ev.type.includes('scheduled'))) return ev.createdAt;
    }
    return null;
  };

  const monitorEvents = useMemo(
    () => events.filter((ev) => STREAM_SOURCES.has(ev.source)).slice(-60).reverse(),
    [events],
  );

  const activeLive = (liveTasks ?? []).filter((t) => ['running', 'waiting', 'queued', 'paused', 'awaiting_approval'].includes(t.status));

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<RadioTower className="size-4 text-sky-300" aria-hidden />}
        title="Live Monitor"
        desc="Continuous (live-mode) tasks and the virtual environment — refreshed every 3s."
      />

      {stateError ? <ErrorCard title="Runtime unavailable" message={stateError} onRetry={load} /> : null}

      {/* Live tasks */}
      <section aria-label="Live tasks" className="space-y-3">
        <SectionTitle title="Live tasks" desc={`${activeLive.length} active · click stop to cancel; tasks are interruptible.`} />
        {liveTasks === null && !stateError ? (
          <Skeleton className="h-28 w-full" />
        ) : activeLive.length === 0 ? (
          <EmptyState
            title="No live tasks running"
            hint="Create one in the Task Console — choose Live mode and confirm the opt-in."
          />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {activeLive.map((t) => (
              <LiveTaskCard
                key={t.id}
                data={{ summary: t, detail: details[t.id] ?? null, eventCount: liveTaskEvents(t.id), lastTickAt: lastTick(t.id) }}
                taskEvents={events.filter((ev) => ev.taskId === t.id).slice(-120)}
                approvals={approvalsByTask[t.id] ?? []}
                alerts={alertsByTask[t.id] ?? []}
                prompts={promptsByTask[t.id] ?? []}
                confirmations={confirmationsByTask[t.id] ?? []}
                choices={choicesByTask[t.id] ?? []}
                verifications={verificationsByTask[t.id] ?? []}
                continuations={continuationsByTask[t.id] ?? []}
                onStop={(id) => setStopCandidate(id)}
                stopping={stoppingId === t.id}
                onPause={(id) => void pauseById(id)}
                onResume={(id) => void resumeById(id)}
                pauseResumeBusy={pauseResumeBusy}
                onResolveApproval={(approvalId, decision, feedback) => void resolveApprovalById(approvalId, decision, feedback)}
                resolvingApproval={resolvingApproval}
                onDismissAlert={(alertId) => void dismissAlertById(alertId)}
                onAnswerPrompt={(promptId, value) => void answerPromptById(promptId, value)}
                answeringPrompt={answeringPrompt}
                onAnswerConfirmation={(confirmId, accepted) => void answerConfirmationById(confirmId, accepted)}
                answeringConfirmation={answeringConfirmation}
                onAnswerChoice={(choiceId, value) => void answerChoiceById(choiceId, value)}
                answeringChoice={answeringChoice}
                onResolveVerification={(verificationId, accepted) => void resolveVerificationById(verificationId, accepted)}
                resolvingVerification={resolvingVerification}
                onResolveContinuation={(continuationId, decision) => void resolveContinuationById(continuationId, decision)}
                resolvingContinuation={resolvingContinuation}
                onOpen={openTaskPreview}
              />
            ))}
          </div>
        )}
      </section>

      {/* Environment */}
      <section aria-label="Virtual environment" className="space-y-3">
        <SectionTitle title="Environment" desc="Virtual servers (api-01 · web-01 · db-01). Injections emit real environment events into the runtime." />
        {liveState === null ? (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
          </div>
        ) : liveState.servers.length === 0 ? (
          <EmptyState title="No servers in the virtual environment" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {liveState.servers.map((server) => (
              <ServerCard key={server.id} server={server} onInject={(type, id) => void inject(type, id)} injecting={injecting} />
            ))}
          </div>
        )}
      </section>

      {/* Live event stream */}
      <section aria-label="Live event stream" className="glass-panel rounded-lg p-4">
        <SectionTitle
          title="Live event stream"
          desc="environment · planner · core · tool sources — newest first."
          right={<PulsingDot tone={monitorEvents.length > 0 ? 'ok' : 'muted'} />}
        />
        <div className="mt-3">
          {monitorEvents.length === 0 ? (
            <EmptyState title="No runtime events yet" hint="Start a task or inject an environment event." />
          ) : (
            <div className="glass-inset nextool-terminal nextool-scroll max-h-96 space-y-1 overflow-y-auto rounded-md p-3">
              {monitorEvents.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  disabled={!ev.taskId}
                  onClick={() => ev.taskId && openTaskPreview(ev.taskId)}
                  className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-white/[0.05] disabled:hover:bg-transparent"
                >
                  <span className="shrink-0 text-slate-500">[{new Date(ev.createdAt).toLocaleTimeString('en-GB', { hour12: false })}]</span>
                  <span className={ev.source === 'planner' ? 'shrink-0 font-semibold text-emerald-300' : ev.source === 'core' ? 'shrink-0 font-semibold text-cyan-300' : ev.source === 'tool' ? 'shrink-0 font-semibold text-amber-300' : 'shrink-0 font-semibold text-orange-300'}>{ev.source}</span>
                  <span className="shrink-0 text-slate-600">→</span>
                  <span className={ev.type.includes('error') ? 'min-w-0 flex-1 font-bold text-rose-300' : 'min-w-0 flex-1 text-foreground/90'}>{ev.message}</span>
                  <TimeAgo iso={ev.createdAt} className="shrink-0 text-[10px] text-slate-600" />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Stop confirm dialog — required confirmation before cancelling a live task */}
      <Dialog
        open={stopCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setStopCandidate(null);
        }}
      >
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><Ban className="size-4" aria-hidden /> Stop live task?</DialogTitle>
            <DialogDescription>
              Cancellation is sent to the runtime: scheduled ticks stop, active executions abort and the task terminates with status <code className="font-mono">stopped</code>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setStopCandidate(null)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" disabled={stoppingId !== null} onClick={() => stopCandidate && void stopTaskById(stopCandidate)}>
              {stoppingId !== null ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Square className="size-4" aria-hidden />} Stop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
