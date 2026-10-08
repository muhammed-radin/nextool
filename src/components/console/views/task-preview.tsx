'use client';

/**
 * Task Preview (spec §52) — dedicated per-task screen: live detail polling,
 * control surface (stop / send event / send feedback), plan, executions,
 * state, context, event timeline and the runtime terminal (§53).
 * v1.0.1: blue glass surfaces; <lg renders a scrollable tab row (Overview ·
 * Timeline · Tools · Internals) so 320–430px screens never force wide tables,
 * lg+ keeps the rich multi-column layout.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApprovalCard } from '@/components/console/approval-card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useNexoolStream } from '@/hooks/use-nexool-stream';
import { useConsoleStore } from '../console-store';
import { ApiClientError, answerChoice, answerConfirmation, answerFileRequest, answerPrompt, dismissAlert, getTaskContext, getTaskDetail, getTaskEvents, getTaskExecutions, listAlerts, listApprovals, listChoices, listConfirmations, listFileRequests, listLimitContinuations, listPrompts, listVerifications, pauseTask, resolveApprovalRequest, resolveLimitContinuationRequest, resolveVerificationRequest, resumeTask, sendTaskEvent, sendTaskFeedback, stopTask } from '@/lib/nexool/client';
import type { PendingAlertDTO, PendingApprovalDTO, PendingChoiceDTO, PendingConfirmationDTO, PendingFileRequestDTO, PendingLimitContinuationDTO, PendingPromptDTO, PendingVerificationDTO } from '@/lib/nexool/client';
import type { ContextComposition, NexToolEvent, PlanStep, ToolExecution } from '@/lib/nexool/types';
import type { TaskDetail } from '@/lib/nexool/api-contract';
import { RuntimeTerminal } from '../terminal';
import { ChecklistItems, TaskChecklist } from '../task-checklist';
import { EmptyState, ErrorCard, ExecutionStatusBadge, JsonBlock, SectionTitle, StatusChip, TechLabel, TimeAgo, SOURCE_COLORS, deriveTaskRuntime, deriveChecklist, fmtClock, fmtMs } from '../ui-bits';
import { reconcileExecutions, isTerminalExecutionStatus } from '@/lib/nexool/execution-merge';
import {
  Ban, BellRing, Braces, Check, CheckCircle2, ChevronDown, Circle, CirclePause, CirclePlay, CornerDownRight, FileText, Flag, Gauge, Layers, LifeBuoy, ListChecks, Loader2, MessageSquareQuote, MessageSquareWarning, Play, Radio, Send, ShieldAlert, ShieldCheck, Square, TerminalSquare, Upload, Wrench, X, Zap,
} from 'lucide-react';

const PREVIEW_AS_TERMINAL_KEY = 'nextool.previewAsTerminal';

/** Persisted per user/session (spec §69) — defaults to OFF (checklist view). */
function readTerminalPreference(): boolean {
  try {
    return window.localStorage.getItem(PREVIEW_AS_TERMINAL_KEY) === '1';
  } catch {
    return false;
  }
}

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'awaiting_approval', 'paused']);
/** v1.0.3 §1: terminal states — Live Checklist/Terminal are removed once reached. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);
/** Events that should refresh task detail/plan/executions immediately (v1.0.3 §2 + v1.0.6 §16 + v1.0.10 §21 + v1.0.11 §13). */
const REFRESH_EVENT_RE = /^(tool\.(completed|failed|timeout|cancelled)|tool\.(approval|user_prompt|user_alert|confirm|auto_execution)|task\.(completed|failed|cancelled|started|paused|resumed|waiting)|planner\.(plan|parallel_batch|partial_failure|mode_selected|one_by_one_step_planned|one_by_one_step_completed|one_by_one_replanned|one_by_one_goal_reached|recovery_started|recovery_plan_built|recovery_attempt|recovery_succeeded|recovery_failed|recovery_exhausted|main_plan_resumed|main_plan_aborted)|subgoal\.created|live\.event\.|event\.(received|admitted|queued|processing|completed|rejected|ignored|failed|cancelled)|observer\.(event_wake|scheduled_tick|observed|feedback_applied)|core\.decision|user\.(message|feedback))/;

function ExecutionCard({ ex }: { ex: ToolExecution }) {
  // v1.0.9 §15.1/§15.3-§15.6 — the status comes from the execution record via
  // the ONE reusable badge (Pending/Running/Completed/Failed/Timed out/
  // Cancelled/Stopped). The "running…" duration placeholder renders ONLY for
  // genuinely active executions — never after a terminal state.
  const active = !isTerminalExecutionStatus(ex.status) && ex.status !== 'pending';
  return (
    <div className="glass-card rounded-md px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ExecutionStatusBadge status={ex.status} />
        <span className="font-mono text-xs font-semibold text-foreground">{ex.tool}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {ex.durationMs !== undefined ? fmtMs(ex.durationMs) : active ? 'running…' : '—'} · {fmtClock(ex.startedAt)}
        </span>
      </div>
      {ex.error ? <p className="mt-1 font-mono text-[11px] text-rose-300">{ex.error.code}: {ex.error.message}</p> : null}
      <Accordion type="single" collapsible className="mt-1">
        <AccordionItem value="io" className="border-none">
          <AccordionTrigger className="py-1 text-[11px] text-muted-foreground hover:text-sky-300 hover:no-underline">params / result</AccordionTrigger>
          <AccordionContent className="space-y-2 pb-1">
            <div>
              <p className="mb-1"><TechLabel className="text-[9px]">params</TechLabel></p>
              <JsonBlock value={ex.params ?? {}} maxHeight="max-h-40" />
            </div>
            <div>
              <p className="mb-1"><TechLabel className="text-[9px]">result</TechLabel></p>
              <JsonBlock value={ex.result ?? null} maxHeight="max-h-40" />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function ExecutionsPanel({ executions }: { executions: ToolExecution[] | null }) {
  if (executions === null) {
    return <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  }
  if (executions.length === 0) return <EmptyState title="No tool calls yet" hint="Executions appear as the CoreModule dispatches tools." />;

  // v1.0.3 §23 — parallel visibility: executions sharing a batchId ran
  // CONCURRENTLY and render inside one labeled parallel-batch group instead of
  // a fake sequential chain. Sequential calls render as before.
  const groups: { key: string; batchId: string | null; items: ToolExecution[] }[] = [];
  for (const ex of executions) {
    const last = groups[groups.length - 1];
    if (ex.batchId && last && last.batchId === ex.batchId) {
      last.items.push(ex);
    } else if (ex.batchId) {
      groups.push({ key: `batch-${ex.batchId}`, batchId: ex.batchId, items: [ex] });
    } else {
      groups.push({ key: ex.executionId, batchId: null, items: [ex] });
    }
  }

  return (
    <div className="space-y-2">
      {groups.map((g) =>
        g.batchId ? (
          <div key={g.key} className="rounded-md border border-sky-400/25 bg-sky-400/[0.04] p-2" data-testid="parallel-batch">
            <p className="mb-1.5 flex items-center gap-1.5 px-1">
              <Zap className="size-3 text-sky-300" aria-hidden />
              <span className="font-tech text-[9px] uppercase tracking-widest text-sky-300/90">parallel batch · {g.items.length} concurrent</span>
            </p>
            <div className="space-y-2">
              {g.items.map((ex) => <ExecutionCard key={ex.executionId} ex={ex} />)}
            </div>
          </div>
        ) : (
          g.items.map((ex) => <ExecutionCard key={ex.executionId} ex={ex} />)
        ),
      )}
    </div>
  );
}

function ContextPanel({ title, value, count }: { title: string; value: unknown; count?: number }) {
  return (
    <div className="glass-card rounded-md p-3">
      <p className="mb-1.5 flex items-center justify-between gap-2">
        <TechLabel className="text-[9px]">{title}</TechLabel>
        {count !== undefined ? <Badge variant="outline" className="border-white/[0.09] px-1.5 py-0 font-mono text-[10px] text-muted-foreground">{count}</Badge> : null}
      </p>
      {value === null || value === undefined ? (
        <p className="text-[11px] text-muted-foreground/60">empty</p>
      ) : (
        <JsonBlock value={value} maxHeight="max-h-44" className="p-2" />
      )}
    </div>
  );
}

export default function TaskPreviewView({ taskId }: { taskId: string }) {
  const setActiveView = useConsoleStore((s) => s.setActiveView);

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<ToolExecution[] | null>(null);
  const [context, setContext] = useState<ContextComposition | null>(null);
  const [backfill, setBackfill] = useState<NexToolEvent[]>([]);

  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [eventType, setEventType] = useState('user.message');
  const [eventPayload, setEventPayload] = useState('{}');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState('Incorrect decision.');
  const [feedbackAction, setFeedbackAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewAsTerminal, setPreviewAsTerminal] = useState<boolean | null>(null); // null = not yet hydrated
  // v1.0.6 §16 — approval / prompt / pause-aware preview state
  const [approvals, setApprovals] = useState<PendingApprovalDTO[]>([]);
  const [prompts, setPrompts] = useState<PendingPromptDTO[]>([]);
  // v1.0.14 §20 — pending interactive alerts for THIS task
  const [alerts, setAlerts] = useState<PendingAlertDTO[]>([]);
  // v1.0.8 §1.5 — pending tool confirmations for THIS task
  const [confirmations, setConfirmations] = useState<PendingConfirmationDTO[]>([]);
  // v1.0.13 — operator choices / verification latches / safety-limit continuations for THIS task
  const [choices, setChoices] = useState<PendingChoiceDTO[]>([]);
  const [verifications, setVerifications] = useState<PendingVerificationDTO[]>([]);
  const [continuations, setContinuations] = useState<PendingLimitContinuationDTO[]>([]);
  // v1.0.13 §10 — pending fs.upload "Upload a file" requests for THIS task
  const [fileRequests, setFileRequests] = useState<PendingFileRequestDTO[]>([]);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [continuationBusy, setContinuationBusy] = useState(false);
  const [fileRequestBusy, setFileRequestBusy] = useState(false);
  const [promptAnswer, setPromptAnswer] = useState('');

  const { events: streamEvents } = useNexoolStream({ taskId, max: 300 });

  // Restore the persisted view preference after mount (avoids SSR mismatch).
  useEffect(() => {
    setPreviewAsTerminal(readTerminalPreference());
  }, []);

  const togglePreviewMode = (on: boolean) => {
    setPreviewAsTerminal(on);
    try {
      window.localStorage.setItem(PREVIEW_AS_TERMINAL_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable — session-only preference */
    }
  };

  // Backfill historical events from REST, then merge with live SSE (dedupe by id).
  useEffect(() => {
    let alive = true;
    getTaskEvents(taskId, { limit: 200 })
      .then((d) => {
        if (alive) setBackfill(d);
      })
      .catch(() => {
        /* honest: timeline will simply show live events only */
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  const taskEvents = useMemo(() => {
    const byId = new Map<string, NexToolEvent>();
    for (const ev of [...backfill, ...streamEvents]) byId.set(ev.id, ev);
    return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [backfill, streamEvents]);

  const isActive = detail ? ACTIVE_STATUSES.has(detail.status) : true;
  const isTerminal = detail ? TERMINAL_STATUSES.has(detail.status) : false;

  const loadDetail = useCallback(async () => {
    try {
      const d = await getTaskDetail(taskId);
      setDetail(d);
      setDetailError(null);
    } catch (e) {
      setDetailError(e instanceof ApiClientError ? e.message : 'Task unavailable');
    }
  }, [taskId]);

  const loadSide = useCallback(async () => {
    const [ex, ctx] = await Promise.allSettled([getTaskExecutions(taskId), getTaskContext(taskId)]);
    // v1.0.9 §15.9 — fold each fetched snapshot through the reconciler so a
    // stale running status can never overwrite a newer terminal one
    // (SSE-triggered refreshes and the 2.5s poll may interleave).
    if (ex.status === 'fulfilled') {
      setExecutions((prev) => (prev ? reconcileExecutions(prev, ex.value) : ex.value));
    }
    if (ctx.status === 'fulfilled') setContext(ctx.value);
  }, [taskId]);

  // v1.0.6 §16 — pending approvals + prompts for THIS task (real approvalIds).
  // v1.0.8 §1.5 — plus pending confirmations.
  // v1.0.13 — plus operator choices, verification latches and safety-limit continuations.
  const loadInteractive = useCallback(async () => {
    const [a, al, p, c, ch, v, lc, fr] = await Promise.allSettled([listApprovals(taskId), listAlerts(taskId), listPrompts(taskId), listConfirmations(taskId), listChoices(taskId), listVerifications(taskId), listLimitContinuations(taskId), listFileRequests(taskId)]);
    if (a.status === 'fulfilled') setApprovals(a.value.approvals);
    if (al.status === 'fulfilled') setAlerts(al.value.alerts);
    if (p.status === 'fulfilled') setPrompts(p.value.prompts);
    if (c.status === 'fulfilled') setConfirmations(c.value.confirmations);
    if (ch.status === 'fulfilled') setChoices(ch.value.choices);
    if (v.status === 'fulfilled') setVerifications(v.value.verifications);
    if (lc.status === 'fulfilled') setContinuations(lc.value.continuations);
    if (fr.status === 'fulfilled') setFileRequests(fr.value.requests);
  }, [taskId]);

  useEffect(() => {
    void loadDetail();
    void loadSide();
    void loadInteractive();
  }, [loadDetail, loadSide, loadInteractive]);

  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => {
      void loadDetail();
      void loadSide();
      void loadInteractive();
    }, 2500);
    return () => clearInterval(t);
  }, [isActive, loadDetail, loadSide, loadInteractive]);

  // v1.0.3 §2: plan/checklist state must update IMMEDIATELY when the runtime
  // reports a step/task transition — the live stream triggers an instant
  // detail refresh instead of waiting for the 2.5s poll.
  const lastStreamEvent = streamEvents.length > 0 ? streamEvents[streamEvents.length - 1] : null;
  const lastStreamEventId = lastStreamEvent?.id ?? '';
  const lastStreamEventType = lastStreamEvent?.type ?? '';
  useEffect(() => {
    if (!lastStreamEventId || !REFRESH_EVENT_RE.test(lastStreamEventType)) return;
    void loadDetail();
    void loadSide();
    void loadInteractive();
  }, [lastStreamEventId, lastStreamEventType, loadDetail, loadSide, loadInteractive]);

  const doStop = async () => {
    setStopping(true);
    try {
      await stopTask(taskId);
      toast.success('Stop signal sent', { description: `Task #${taskId.slice(0, 8)} cancellation requested.` });
      setStopOpen(false);
      void loadDetail();
    } catch (e) {
      toast.error('Stop failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setStopping(false);
    }
  };

  // v1.0.6 §11 — pause preserves state; resume continues (never restarts).
  const doPause = async () => {
    setPauseBusy(true);
    try {
      await pauseTask(taskId);
      toast.success('Task paused', { description: 'Plan, subgoal, context and event queue are preserved.' });
      void loadDetail();
      void loadInteractive();
    } catch (e) {
      toast.error('Pause failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPauseBusy(false);
    }
  };

  const doResume = async () => {
    setPauseBusy(true);
    try {
      await resumeTask(taskId);
      toast.success('Task resumed', { description: 'Continuing from the preserved state.' });
      void loadDetail();
      void loadInteractive();
    } catch (e) {
      toast.error('Resume failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPauseBusy(false);
    }
  };

  // v1.0.15 §31-§34 — approval actions from the Task Preview header area:
  // Accept executes; Skip records `skipped` + continues; Reject blocks.
  const doResolveApproval = async (approvalId: string, decision: 'accept' | 'skip' | 'reject', feedback?: string) => {
    setApprovalBusy(true);
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
        toast.info('Approval no longer pending', { description: res.reason ?? 'It may have timed out.' });
      }
      void loadDetail();
      void loadInteractive();
    } catch (e) {
      toast.error('Approval failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setApprovalBusy(false);
    }
  };

  const doAnswerPrompt = async (promptId: string, value: string | null) => {
    setPromptBusy(true);
    try {
      await answerPrompt(promptId, value);
      setPromptAnswer('');
      void loadInteractive();
    } catch (e) {
      toast.error('Prompt failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPromptBusy(false);
    }
  };

  // v1.0.14 §22.1 — file prompt: read the picked file and send structured
  // metadata (content ONLY for small files — never blind-huge blobs).
  const FILE_PROMPT_INLINE_LIMIT = 256 * 1024;
  const doAnswerFilePrompt = async (promptId: string, file: File) => {
    setPromptBusy(true);
    try {
      const small = file.size <= FILE_PROMPT_INLINE_LIMIT;
      const content = small ? await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
        reader.readAsDataURL(file);
      }) : undefined;
      await answerPrompt(promptId, '', { name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, ...(content !== undefined ? { content } : {}) });
      setPromptAnswer('');
      void loadInteractive();
    } catch (e) {
      toast.error('File answer failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPromptBusy(false);
    }
  };

  // v1.0.14 §20 — dismiss an interactive alert (the tool resumes).
  const doDismissAlert = async (alertId: string) => {
    setPromptBusy(true);
    try {
      await dismissAlert(alertId);
      void loadInteractive();
    } catch (e) {
      toast.error('Dismiss failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setPromptBusy(false);
    }
  };

  // v1.0.8 §1.2 — the user's boolean decision resumes the waiting tool.
  const doAnswerConfirmation = async (confirmId: string, accepted: boolean) => {
    setConfirmBusy(true);
    try {
      await answerConfirmation(confirmId, accepted);
      void loadInteractive();
      toast.success(accepted ? 'Confirmation allowed' : 'Confirmation denied', { description: 'The tool resumes with your boolean answer.' });
    } catch (e) {
      toast.error('Confirmation failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setConfirmBusy(false);
    }
  };

  // v1.0.13 — the operator's option pick resumes the waiting tool (null cancels).
  const doAnswerChoice = async (choiceId: string, value: string | null) => {
    setChoiceBusy(true);
    try {
      await answerChoice(choiceId, value);
      void loadInteractive();
      toast.success(value === null ? 'Choice cancelled' : 'Choice submitted', {
        description: value === null ? 'The tool receives no answer.' : `The tool receives: ${value}`,
      });
    } catch (e) {
      toast.error('Choice failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setChoiceBusy(false);
    }
  };

  // v1.0.13 — verify the held-open tool result; rejecting fails the execution (VERIFICATION_REJECTED).
  const doResolveVerification = async (verificationId: string, accepted: boolean) => {
    setVerificationBusy(true);
    try {
      await resolveVerificationRequest(verificationId, accepted);
      void loadInteractive();
      void loadSide(); // execution status changes (completes or fails) — refresh the Tools panel
      toast.success(accepted ? 'Result verified' : 'Result rejected', {
        description: accepted ? 'The execution completes with your verification.' : 'The execution fails as VERIFICATION_REJECTED.',
      });
    } catch (e) {
      toast.error('Verification failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setVerificationBusy(false);
    }
  };

  // v1.0.13 §10 — deliver the operator's chosen file to the waiting fs.upload tool.
  const doAnswerFileRequest = async (requestId: string, payload: { fileName: string; contentBase64: string } | { cancel: true }) => {
    setFileRequestBusy(true);
    try {
      await answerFileRequest(requestId, payload);
      void loadInteractive();
      void loadSide(); // the fs.upload execution completes — refresh the Tools panel
      toast.success('cancel' in payload ? 'File request cancelled' : 'File delivered', {
        description: 'cancel' in payload
          ? 'The fs.upload tool reports a FILE_REQUEST_TIMEOUT failure.'
          : `The file was handed to fs.upload: ${payload.fileName}`,
      });
    } catch (e) {
      toast.error('File request failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setFileRequestBusy(false);
    }
  };

  // v1.0.13 §10 — read the chosen file as base64 and resolve the request.
  const fileRequestInputRef = useRef<HTMLInputElement>(null);
  const [activeFileRequestId, setActiveFileRequestId] = useState<string | null>(null);
  const onFileRequestPicked = (file: File | null) => {
    const requestId = activeFileRequestId;
    setActiveFileRequestId(null);
    if (!file || !requestId) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
      if (!base64) {
        toast.error('Could not read the chosen file');
        return;
      }
      void doAnswerFileRequest(requestId, { fileName: file.name, contentBase64: base64 });
    };
    reader.onerror = () => toast.error('Could not read the chosen file');
    reader.readAsDataURL(file);
  };

  // v1.0.13 — 'continue' grows the limits and resumes the task; 'deny' ends it as limit_reached.
  const doResolveContinuation = async (continuationId: string, decision: 'continue' | 'deny') => {
    setContinuationBusy(true);
    try {
      await resolveLimitContinuationRequest(continuationId, decision);
      void loadInteractive();
      void loadDetail(); // task status changes (awaiting_approval → running / limit_reached)
      toast.success(decision === 'continue' ? 'Budget granted' : 'Continuation denied', {
        description: decision === 'continue' ? 'The limits grow and the task resumes.' : 'The task ends as limit_reached.',
      });
    } catch (e) {
      toast.error('Continuation failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setContinuationBusy(false);
    }
  };

  const doSendEvent = async () => {
    let payload: unknown;
    try {
      payload = eventPayload.trim() ? JSON.parse(eventPayload) : {};
    } catch {
      toast.error('Invalid JSON payload');
      return;
    }
    setBusy(true);
    try {
      await sendTaskEvent(taskId, { type: eventType, payload: payload as Record<string, unknown> });
      toast.success('Event injected', { description: `${eventType} → task #${taskId.slice(0, 8)}` });
      setEventOpen(false);
    } catch (e) {
      toast.error('Event injection failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const doSendFeedback = async () => {
    if (!feedbackMsg.trim()) {
      toast.error('Feedback message required');
      return;
    }
    setBusy(true);
    try {
      await sendTaskFeedback(taskId, {
        message: feedbackMsg.trim(),
        ...(feedbackAction.trim() ? { correctAction: feedbackAction.trim() } : {}),
      });
      toast.success('Feedback delivered', { description: 'The runtime emitted a user.feedback event.' });
      setFeedbackOpen(false);
    } catch (e) {
      toast.error('Feedback failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  if (detailError && detail === null) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="min-h-11 text-muted-foreground hover:text-foreground" onClick={() => setActiveView('dashboard')}>
          ← Back to dashboard
        </Button>
        <ErrorCard title="Task unavailable" message={detailError} onRetry={loadDetail} />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  const state = detail.state;
  const duration = detail.durationMs ?? (detail.startedAt ? Date.now() - new Date(detail.startedAt).getTime() : undefined);
  // v1.0.3 §2: state.plan is written on every runtime state persist, so it is
  // the fresher source for live step statuses (detail.plan can lag on tasks
  // executed before the plan-column sync fix); fall back to detail.plan.
  const planSteps = state?.plan?.length ? state.plan : detail.plan ?? [];

  // ---- shared section fragments (rendered in mobile tabs AND desktop columns) ----

  const goalCard = (
    <section aria-label="Current goal" className="glass-card rounded-lg p-4">
      <SectionTitle icon={<Flag className="size-4 text-sky-300" aria-hidden />} title="Current goal" />
      <p className="mt-2 text-sm text-foreground/90">{state?.goal || '—'}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        iteration {state?.iterationCount ?? 0} · tool calls {state?.toolCallCount ?? 0}
      </p>
    </section>
  );

  const subgoalCard = (
    <section aria-label="Active subgoal" className="glass-card rounded-lg p-4">
      <SectionTitle icon={<CornerDownRight className="size-4 text-sky-300" aria-hidden />} title="Active subgoal" />
      {state?.activeSubgoal ? (
        <>
          <p className="mt-2 text-sm font-medium text-foreground">{state.activeSubgoal.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{state.activeSubgoal.reason}</p>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground/70">No active subgoal — {state?.subgoals?.length ?? 0} subgoal(s) so far.</p>
      )}
    </section>
  );

  // v1.0.3 §2/§3/§4 — the Plan section IS a live checklist: states come from
  // the actual runtime plan + event stream (deriveChecklist) and transitions
  // animate (✓ pulse on completion, moving highlight while running, [!] on
  // failure). Never a hardcoded checked state.
  const planChecklist = deriveChecklist(planSteps, taskEvents);

  // v1.0.10 §22 — the planner mode is displayed explicitly. One-by-one tasks
  // get the dedicated Current Subgoal / Previous / Next layout: the plan
  // array only ever contains steps that were ACTUALLY planned (one per
  // cycle) — the preview never pretends a complete plan existed up front.
  const plannerType = detail.config?.plannerType === 'one-by-one' ? 'one-by-one' : 'pre-plan';
  const currentOneByOne = planSteps.find((s) => s.status === 'in_progress' || s.status === 'pending');
  const previousOneByOne = [...planSteps].filter((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped').reverse();
  const oneByOneSection = (
    <section aria-label="One-by-one planner" className="glass-panel rounded-lg p-4">
      <SectionTitle
        icon={<Play className="size-4 text-sky-300" aria-hidden />}
        title="One-by-one Planner"
        desc="Plans one step, observes, verifies the goal, then plans the next — generated only after the latest observation."
        right={
          <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 font-mono text-[10px] text-sky-300">Planner: One-by-one</Badge>
        }
      />
      <div className="mt-3 space-y-3">
        <div>
          <TechLabel className="text-[9px]">current subgoal</TechLabel>
          {currentOneByOne ? (
            <p className="mt-1 flex items-start gap-2 text-sm font-medium text-foreground">
              <span aria-hidden className="mt-0.5 text-sky-300">→</span>
              <span>
                {currentOneByOne.title}
                {currentOneByOne.detail ? <span className="block text-xs font-normal text-muted-foreground">{currentOneByOne.detail}</span> : null}
              </span>
            </p>
          ) : isTerminal ? (
            <p className="mt-1 text-xs text-muted-foreground/70">Task cycle complete — no further subgoal planned.</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground/70">Planning the first step…</p>
          )}
        </div>
        <div>
          <TechLabel className="text-[9px]">previous</TechLabel>
          {previousOneByOne.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground/70">No completed steps yet.</p>
          ) : (
            <ul className="nextool-scroll mt-1 max-h-40 space-y-1 overflow-y-auto pr-1">
              {previousOneByOne.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-xs text-foreground/85">
                  <span aria-hidden className={cn('mt-0.5 shrink-0 font-mono', s.status === 'completed' ? 'text-emerald-300' : s.status === 'failed' ? 'text-rose-300' : 'text-amber-300')}>
                    {s.status === 'completed' ? '✓' : s.status === 'failed' ? '!' : '~'}
                  </span>
                  <span>{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <TechLabel className="text-[9px]">next</TechLabel>
          <p className="mt-1 text-xs text-muted-foreground">Waiting for observation…</p>
        </div>
      </div>
    </section>
  );

  const planSection = plannerType === 'one-by-one' ? oneByOneSection : (
    <section aria-label="Plan" className="glass-panel rounded-lg p-4">
      <SectionTitle
        icon={<Play className="size-4 text-sky-300" aria-hidden />}
        title="Plan"
        desc="Runtime-driven checklist — steps update as the task executes."
        right={
          <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">Planner: Pre-plan</Badge>
        }
      />
      <div className="mt-3">
        {planSteps.length === 0 ? (
          <EmptyState title="No plan yet" hint="The planner publishes steps once the task starts executing." />
        ) : (
          <div className="nextool-scroll max-h-72 overflow-y-auto pr-1">
            <ChecklistItems items={planChecklist.items} finished={isTerminal} />
          </div>
        )}
      </div>
    </section>
  );

  // v1.0.11 §14 — Task Preview RECOVERY UI. A failed pre-plan step creates a
  // recovery subgoal with its own pre-plan; the main plan is frozen while it
  // runs. This panel makes that visible (never hidden inside the generic
  // execution list) — per spec: nested recovery steps, attempts, resume note
  // or an honest exhausted message.
  const recovery = state?.recovery;
  const recoverySection = recovery ? (
    <section
      aria-label="Recovery"
      className={cn(
        'glass-panel rounded-lg p-4',
        recovery.status === 'recovering' && 'ring-1 ring-amber-400/40',
        recovery.status === 'exhausted' && 'ring-1 ring-rose-400/40',
        recovery.status === 'resumed' && 'ring-1 ring-emerald-400/30',
      )}
    >
      <SectionTitle
        icon={<LifeBuoy className={cn('size-4', recovery.status === 'recovering' ? 'animate-pulse text-amber-300' : recovery.status === 'exhausted' ? 'text-rose-300' : 'text-emerald-300')} aria-hidden />}
        title="Recovery"
        desc="Failed pre-plan step → recovery subgoal with its own pre-plan → main plan resumes."
        right={
          <Badge
            variant="outline"
            className={cn(
              'font-mono text-[10px]',
              recovery.status === 'recovering' && 'border-amber-400/40 bg-amber-400/10 text-amber-300',
              recovery.status === 'resumed' && 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
              recovery.status === 'exhausted' && 'border-rose-400/40 bg-rose-400/10 text-rose-300',
            )}
          >
            {recovery.status === 'recovering' ? `Recovering ${recovery.attempt}/${recovery.maxAttempts}` : recovery.status === 'resumed' ? `Main plan resumed (${recovery.attempt}/${recovery.maxAttempts})` : `Recovery failed ${recovery.attempt}/${recovery.maxAttempts}`}
          </Badge>
        }
      />
      <div className="mt-3 space-y-3">
        <div>
          <TechLabel className="text-[9px]">failed step</TechLabel>
          <p className="mt-1 text-sm font-medium text-foreground">
            <span aria-hidden className="mr-1.5 text-rose-300">✗</span>
            {recovery.failedStepTitle ?? 'Plan step'}
          </p>
          <p className="mt-0.5 break-words font-mono text-[10px] text-rose-300/80">{recovery.reason}</p>
        </div>
        <div>
          <TechLabel className="text-[9px]">recovery pre-plan</TechLabel>
          {recovery.steps.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground/70">Pre-planning the recovery…</p>
          ) : (
            <ul className="nextool-scroll mt-1 max-h-40 space-y-1 overflow-y-auto pr-1">
              {recovery.steps.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-xs text-foreground/85">
                  <span aria-hidden className={cn('mt-0.5 shrink-0 font-mono', s.status === 'completed' ? 'text-emerald-300' : s.status === 'failed' ? 'text-rose-300' : s.status === 'in_progress' ? 'animate-pulse text-sky-300' : 'text-muted-foreground/50')}>
                    {s.status === 'completed' ? '✓' : s.status === 'failed' ? '!' : s.status === 'in_progress' ? '→' : '○'}
                  </span>
                  <span>{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <TechLabel className="text-[9px]">main plan</TechLabel>
          {recovery.status === 'recovering' ? (
            <p className="mt-1 text-xs text-amber-300/90">Frozen while recovery executes (attempt {recovery.attempt}/{recovery.maxAttempts})…</p>
          ) : recovery.status === 'resumed' ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-emerald-300/90">
              <span aria-hidden>↻</span>
              <span>{recovery.resumeNote ?? 'Main plan resumed.'}</span>
            </p>
          ) : (
            <p className="mt-1 text-xs text-rose-300/90">
              Recovery failed — attempts: {recovery.attempt}/{recovery.maxAttempts}. Main task ended because the failed step could not be recovered.
            </p>
          )}
        </div>
      </div>
    </section>
  ) : null;

  const toolsSection = (
    <section aria-label="Tool calls" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Wrench className="size-4 text-sky-300" aria-hidden />} title="Tool calls" desc="Executions with params and results." />
      <div className="mt-3"><ExecutionsPanel executions={executions} /></div>
    </section>
  );

  const stateSection = (
    <section aria-label="Task state" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Braces className="size-4 text-sky-300" aria-hidden />} title="State" desc="MainState snapshot (live JSON)." />
      <div className="mt-3">
        <JsonBlock value={state ?? {}} maxHeight="max-h-80" />
      </div>
    </section>
  );

  const contextSection = (
    <section aria-label="Context composition" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Layers className="size-4 text-sky-300" aria-hidden />} title="Context" desc="Previous + delta + observation + memory + history (assembled by the runtime)." />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <ContextPanel title="previous context" value={context?.previousContext ?? null} />
        <ContextPanel title="delta" value={context?.delta ?? null} />
        <ContextPanel title="new observation" value={context?.observation ?? null} />
        <ContextPanel title="memory refs" value={context?.memory ?? null} count={context?.memory?.length} />
        <ContextPanel title="history refs" value={context?.history ?? null} count={context?.history?.length} />
        <div className="glass-card rounded-md p-3">
          <p className="mb-1.5"><TechLabel className="text-[9px]">assembled at</TechLabel></p>
          <p className="font-mono text-xs text-foreground/90">{context ? <TimeAgo iso={context.assembledAt} /> : '—'}</p>
        </div>
      </div>
    </section>
  );

  const timelineSection = (
    <section aria-label="Event timeline" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Radio className="size-4 text-sky-300" aria-hidden />} title="Events timeline" desc="This task's events — REST backfill + live stream (newest last)." />
      <div className="mt-3">
        {taskEvents.length === 0 ? (
          <EmptyState title="No events for this task yet" hint="Runtime events appear here as the task executes." />
        ) : (
          <ol className="nextool-scroll relative max-h-96 space-y-2 overflow-y-auto border-l border-white/[0.08] pl-4 pr-1">
            {taskEvents.map((ev) => (
              <li key={ev.id} className="relative">
                <span
                  aria-hidden
                  className={cn('absolute -left-[21px] top-1.5 size-2 rounded-full ring-2 ring-card', SOURCE_COLORS[ev.source] ?? 'bg-slate-600')}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10px] text-muted-foreground">[{fmtClock(ev.createdAt)}]</span>
                  <span className="rounded border border-white/[0.09] px-1 font-mono text-[9px] uppercase text-slate-300">{ev.source}</span>
                  <span className="rounded border border-white/[0.09] px-1 font-mono text-[9px] text-cyan-300/90">{ev.type}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{ev.message}</span>
                </div>
                {ev.data ? <JsonBlock value={ev.data} maxHeight="max-h-32" className="mt-1" /> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );

  const terminal = <RuntimeTerminal taskId={taskId} events={taskEvents} taskStatus={detail.status} />;

  // ---- v1.0.2 §67-68: Preview as Terminal toggle — checklist is the DEFAULT.
  // Both views consume the SAME runtime state (spec §68).
  // v1.0.3 §1/§30: the whole Live Checklist/Terminal area exists ONLY while
  // the task is actively executing. On a terminal state (completed/failed/
  // cancelled/stopped) it disappears entirely — no empty container, no blank
  // gap — and the Final Task Output section takes over (historical info like
  // plan/executions/state/context/timeline remains below).
  const livePreview = (
    <section aria-label="Live task preview" className="glass-panel rounded-lg p-4" data-testid="live-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle
          icon={<ListChecks className="size-4 text-sky-300" aria-hidden />}
          title="Live checklist"
          desc="Real-time task timeline driven by the runtime plan."
        />
        <label className="flex min-h-11 items-center gap-2 rounded-md border border-white/[0.09] bg-white/[0.03] px-3 text-xs text-slate-300">
          <TerminalSquare className="size-3.5 text-sky-300/70" aria-hidden />
          Preview as Terminal
          <Switch
            checked={previewAsTerminal === true}
            onCheckedChange={togglePreviewMode}
            aria-label="Preview as Terminal"
            data-testid="terminal-toggle"
          />
        </label>
      </div>
      <div className="mt-3">
        {previewAsTerminal === false ? (
          <TaskChecklist plan={planSteps} events={taskEvents} taskStatus={detail.status} />
        ) : previewAsTerminal === true ? (
          terminal
        ) : (
          <Skeleton className="h-32 w-full" />
        )}
      </div>
    </section>
  );

  // v1.0.3 §1/§30 — Final Task Output: replaces the live area once the task
  // reaches a terminal state. Shows the runtime-recorded FinalResult (summary,
  // steps, tool calls, duration, artifacts) — real data only, '—' if absent.
  const finalResult = detail.finalResult ?? null;
  const finalResultSummary = (() => {
    if (finalResult?.result && typeof finalResult.result === 'object' && !Array.isArray(finalResult.result)) {
      const s = (finalResult.result as Record<string, unknown>).summary;
      if (typeof s === 'string' && s.trim()) return s;
    }
    if (detail.statusDetail) return detail.statusDetail;
    if (detail.error) return `${detail.error.code} [${detail.error.stage}]: ${detail.error.message}`;
    return null;
  })();
  const finalArtifacts = (() => {
    if (finalResult?.result && typeof finalResult.result === 'object' && !Array.isArray(finalResult.result)) {
      const a = (finalResult.result as Record<string, unknown>).artifacts;
      if (Array.isArray(a) && a.length > 0) return a as Record<string, unknown>[];
    }
    return null;
  })();
  const finalOutputSection = isTerminal ? (
    <section aria-label="Final task output" className="glass-panel rounded-lg p-4" data-testid="final-task-output">
      <SectionTitle
        icon={<CheckCircle2 className="size-4 text-emerald-300" aria-hidden />}
        title="Final task output"
        desc="Recorded by the runtime when the task reached its terminal state."
      />
      {finalResultSummary ? (
        <p className="mt-3 break-words rounded-md border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 text-sm text-foreground/90">
          {finalResultSummary}
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No summary was recorded for this task.</p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">result status</TechLabel>
          <p className="mt-1 font-mono text-sm text-foreground">{finalResult?.status ?? detail.status}</p>
        </div>
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">steps</TechLabel>
          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{finalResult?.steps ?? detail.steps}</p>
        </div>
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">tool calls</TechLabel>
          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{finalResult?.toolCalls ?? detail.toolCalls}</p>
        </div>
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">duration</TechLabel>
          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{finalResult?.durationMs !== undefined ? fmtMs(finalResult.durationMs) : duration !== undefined ? fmtMs(duration) : '—'}</p>
        </div>
      </div>
      {finalArtifacts ? (
        <div className="mt-3">
          <TechLabel className="text-[9px]">artifacts ({finalArtifacts.length})</TechLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {finalArtifacts.map((a, i) => (
              <Badge key={i} variant="outline" className="border-white/[0.09] font-mono text-[10px] text-slate-300">
                {String(a.type ?? 'artifact')}{typeof a.path === 'string' ? ` · ${a.path}` : ''}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3">
        <TechLabel className="text-[9px]">final result (live JSON)</TechLabel>
        <div className="mt-1">
          <JsonBlock value={finalResult ?? { status: detail.status, statusDetail: detail.statusDetail ?? null, error: detail.error ?? null }} maxHeight="max-h-72" />
        </div>
      </div>
    </section>
  ) : null;

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="min-h-11 text-muted-foreground hover:text-foreground" onClick={() => setActiveView('dashboard')}>
        ← Back to dashboard
      </Button>

      {/* Header card — task, status, controls (always visible) */}
      <section aria-label="Task overview" className="glass-panel rounded-lg p-4 md:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="break-all font-mono text-xs text-foreground/90">{detail.request}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusChip status={detail.status} />
              {(() => {
                // v1.0.2 §71: dynamic derived status from the SAME event stream
                // the terminal/checklist use — never a hardcoded state string.
                const rt = deriveTaskRuntime(detail.status, taskEvents);
                if (rt.status === detail.status) return null;
                return (
                  <Badge variant="outline" className="border-sky-400/25 bg-sky-400/[0.06] font-mono text-[10px] text-sky-300">
                    {rt.status}
                    {rt.activeTool ? <span className="ml-1 text-cyan-300/90">· {rt.activeTool}</span> : null}
                  </Badge>
                );
              })()}
              <Badge variant="outline" className={cn('font-mono text-[10px]', detail.mode === 'live' ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : 'border-white/[0.09] text-muted-foreground')}>
                {detail.mode}
              </Badge>
              {/* v1.0.6 §16 — Auto-Execute status is visible in the preview */}
              <Badge variant="outline" className={cn('font-mono text-[10px]', detail.config?.autoExecuteTools === true ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/[0.09] text-muted-foreground')}>
                auto-execute: {detail.config?.autoExecuteTools === true ? 'on' : 'approval required'}
              </Badge>
              {detail.config?.allowMultipleEvents === true ? (
                <Badge variant="outline" className="border-sky-400/25 bg-sky-400/[0.06] font-mono text-[10px] text-sky-300">multi-event</Badge>
              ) : null}
              <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">L{detail.reasoningLevel}</Badge>
              {detail.sessionId ? <span className="font-mono text-[10px] text-muted-foreground">session {detail.sessionId.slice(0, 12)}</span> : null}
              <span className="font-mono text-[10px] text-muted-foreground">#{detail.id.slice(0, 8)}</span>
            </div>
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
              {detail.steps} steps · {detail.toolCalls} tools{duration !== undefined ? ` · ${fmtMs(duration)}` : ''}
            </p>
            {/* v1.0.12 Phase 7 — Task Preview shows that custom instructions are
                attached and allows inspecting them (user-provided content only;
                internal system prompts are NOT exposed). */}
            {detail.instructions ? (
              <Collapsible className="mt-2">
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                  <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                  <span className="font-medium">Instructions ✓ Custom instructions attached</span>
                  <span className="font-mono text-[10px] text-muted-foreground">({detail.instructions.length.toLocaleString()} chars)</span>
                </div>
                <CollapsibleTrigger className="mt-1 flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-slate-300 hover:bg-white/[0.06]">
                  <span className="flex items-center gap-1.5">
                    <FileText className="size-3.5" aria-hidden /> Inspect attached instructions
                  </span>
                  <ChevronDown className="size-3.5" aria-hidden />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.08] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
{detail.instructions}
                  </pre>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                    User task instructions — context only, never executed. Applied BELOW system/runtime constraints and task configuration.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 justify-center border-white/[0.09] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"
              onClick={() => setEventOpen(true)}
            >
              <Send className="size-3.5" aria-hidden /> Send event
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 justify-center border-white/[0.09] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"
              onClick={() => setFeedbackOpen(true)}
            >
              <MessageSquareWarning className="size-3.5" aria-hidden /> Feedback
            </Button>
            {/* v1.0.6 §11.2 — Pause Live ⇄ Resume Live (distinct from Stop) */}
            {detail.status === 'paused' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pauseBusy}
                className="min-h-11 justify-center border-sky-400/30 bg-sky-400/[0.06] text-sky-300 hover:bg-sky-400/15"
                onClick={() => void doResume()}
              >
                {pauseBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CirclePlay className="size-3.5" aria-hidden />} Resume Live
              </Button>
            ) : ACTIVE_STATUSES.has(detail.status) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pauseBusy}
                className="min-h-11 justify-center border-sky-400/30 text-sky-300 hover:bg-sky-400/10"
                onClick={() => void doPause()}
              >
                {pauseBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CirclePause className="size-3.5" aria-hidden />} Pause Live
              </Button>
            ) : null}
            {ACTIVE_STATUSES.has(detail.status) ? (
              <Button
                variant="outline"
                size="sm"
                className="col-span-2 min-h-11 justify-center border-rose-500/40 text-rose-300 hover:bg-rose-500/10 sm:col-span-1"
                onClick={() => setStopOpen(true)}
              >
                <Square className="size-3.5" aria-hidden /> Stop task
              </Button>
            ) : null}
          </div>
        </div>
        {detail.statusDetail ? <p className="mt-2 text-xs text-muted-foreground">{detail.statusDetail}</p> : null}
        {detail.error ? <p className="mt-2 font-mono text-xs text-rose-300">{detail.error.code} [{detail.error.stage}]: {detail.error.message}</p> : null}

        {/* v1.0.15 §31-§35 — pending approval: [Skip] [Reject] [Accept] card
            (collapsible-safe, inside the header card) */}
        {approvals.length > 0 ? (
          <div className="mt-3 space-y-2" role="alert">
            {approvals.map((a) => (
              <ApprovalCard key={a.approvalId} approval={a} busy={approvalBusy} onResolve={(id, decision, fb) => void doResolveApproval(id, decision, fb)} />
            ))}
          </div>
        ) : null}

        {/* v1.0.14 §20 — pending interactive alerts (OK dismisses; tool resumes) */}
        {alerts.length > 0 ? (
          <div className="mt-3 space-y-2">
            {alerts.map((a) => (
              <div key={a.alertId} className="rounded-md border border-sky-400/30 bg-sky-400/[0.05] p-3">
                <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-sky-300">
                  <BellRing className="size-3.5" aria-hidden /> tool alert {a.toolName ? `· ${a.toolName}` : ''}
                </p>
                <p className="mt-1 break-words text-xs text-foreground">{a.message}</p>
                <div className="mt-2 flex">
                  <Button size="sm" disabled={promptBusy} onClick={() => void doDismissAlert(a.alertId)} className="min-h-9 border-sky-400/30 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20">OK</Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* v1.0.6 §1.6 — pending tool prompts (v1.0.14 §22: typed inputs) */}
        {prompts.length > 0 ? (
          <div className="mt-3 space-y-2">
            {prompts.map((p) => {
              const inputType = (p.inputType ?? 'text') as string;
              if (inputType === 'file') {
                return (
                  <div key={p.promptId} className="rounded-md border border-cyan-400/30 bg-cyan-400/[0.05] p-3">
                    <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-cyan-300">
                      <MessageSquareQuote className="size-3.5" aria-hidden /> tool prompt · file {p.toolName ? `· ${p.toolName}` : ''}
                    </p>
                    <p className="mt-1 break-words text-xs text-foreground">{p.message}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        type="file"
                        disabled={promptBusy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void doAnswerFilePrompt(p.promptId, f);
                          e.target.value = '';
                        }}
                        className="block w-full max-w-xs cursor-pointer rounded-md border border-white/[0.09] bg-white/[0.04] text-xs text-slate-300 file:mr-3 file:cursor-pointer file:rounded-l-md file:border-0 file:bg-cyan-400/15 file:px-3 file:py-2 file:text-xs file:font-medium file:text-cyan-200"
                        aria-label={`Choose a file for prompt: ${p.message.slice(0, 60)}`}
                      />
                      <Button size="sm" variant="outline" disabled={promptBusy} onClick={() => void doAnswerPrompt(p.promptId, null)} className="min-h-9 border-white/[0.09] text-muted-foreground">Cancel</Button>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">Files up to 256 KB include inline content — larger files send metadata only.</p>
                  </div>
                );
              }
              const nativeType = ['textarea'].includes(inputType) ? 'text'
                : ['number', 'email', 'password', 'url', 'search', 'date', 'time', 'datetime-local', 'month', 'week'].includes(inputType) ? inputType
                : inputType === 'color' ? 'color'
                : 'text';
              return (
                <div key={p.promptId} className="rounded-md border border-cyan-400/30 bg-cyan-400/[0.05] p-3">
                  <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-cyan-300">
                    <MessageSquareQuote className="size-3.5" aria-hidden /> tool prompt · {inputType} {p.toolName ? `· ${p.toolName}` : ''}
                  </p>
                  <p className="mt-1 break-words text-xs text-foreground">{p.message}</p>
                  <div className="mt-2 flex gap-2">
                    {inputType === 'textarea' ? (
                      <Textarea
                        value={promptAnswer}
                        onChange={(e) => setPromptAnswer(e.target.value)}
                        placeholder={p.placeholder ?? 'Your answer…'}
                        className="min-h-16 flex-1 border-white/[0.09] bg-white/[0.04] text-xs"
                        aria-label={`Answer for prompt: ${p.message.slice(0, 60)}`}
                      />
                    ) : (
                      <Input
                        type={nativeType}
                        value={promptAnswer}
                        onChange={(e) => setPromptAnswer(e.target.value)}
                        placeholder={p.placeholder ?? (inputType === 'color' ? '#7c3aed' : 'Your answer…')}
                        className={cn('min-h-9 flex-1 border-white/[0.09] bg-white/[0.04] text-xs', inputType === 'color' && 'h-9 min-h-9 p-1')}
                        aria-label={`Answer for prompt: ${p.message.slice(0, 60)}`}
                      />
                    )}
                    <Button size="sm" disabled={promptBusy} onClick={() => void doAnswerPrompt(p.promptId, promptAnswer || null)} className="min-h-9 border-cyan-400/30 bg-cyan-400/10 text-cyan-200 hover:bg-cyan-400/20">Send</Button>
                    <Button size="sm" variant="outline" disabled={promptBusy} onClick={() => void doAnswerPrompt(p.promptId, null)} className="min-h-9 border-white/[0.09] text-muted-foreground">Cancel</Button>
                  </div>
                </div>
              );
            })}
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
                  <Button size="sm" disabled={confirmBusy} onClick={() => void doAnswerConfirmation(c.confirmId, true)} className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20">
                    <Check className="size-3.5" aria-hidden /> Confirm
                  </Button>
                  <Button size="sm" variant="outline" disabled={confirmBusy} onClick={() => void doAnswerConfirmation(c.confirmId, false)} className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10">
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
                      disabled={choiceBusy}
                      onClick={() => void doAnswerChoice(ch.choiceId, opt.value)}
                      className="min-h-9 border-violet-400/30 text-violet-200 hover:bg-violet-400/10"
                    >
                      {opt.label ?? opt.value}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={choiceBusy}
                    onClick={() => void doAnswerChoice(ch.choiceId, null)}
                    className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                  >
                    <X className="size-3.5" aria-hidden /> Cancel
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* v1.0.13 §10 — fs.upload file requests: choose a file from the device or cancel */}
        {fileRequests.length > 0 ? (
          <div className="mt-3 space-y-2">
            {fileRequests.map((fr) => (
              <div key={fr.requestId} className="rounded-md border border-teal-400/30 bg-teal-400/[0.05] p-3">
                <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-teal-300">
                  <Upload className="size-3.5" aria-hidden /> upload requested {fr.toolName ? `· ${fr.toolName}` : ''}
                </p>
                <p className="mt-1 break-words text-xs text-foreground">{fr.message}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={fileRequestBusy}
                    onClick={() => {
                      setActiveFileRequestId(fr.requestId);
                      fileRequestInputRef.current?.click();
                    }}
                    className="min-h-9 border-teal-400/40 bg-teal-400/10 text-teal-200 hover:bg-teal-400/20"
                  >
                    <Upload className="size-3.5" aria-hidden /> Choose file
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={fileRequestBusy}
                    onClick={() => void doAnswerFileRequest(fr.requestId, { cancel: true })}
                    className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                  >
                    <X className="size-3.5" aria-hidden /> Cancel
                  </Button>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">the tool waits up to 120 s for the file · it is stored in the shared VFS</p>
              </div>
            ))}
          </div>
        ) : null}
        <input
          ref={fileRequestInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            onFileRequestPicked(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
          aria-hidden
          tabIndex={-1}
        />

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
                  <Button size="sm" disabled={verificationBusy} onClick={() => void doResolveVerification(v.verificationId, true)} className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20">
                    <Check className="size-3.5" aria-hidden /> Verify result
                  </Button>
                  <Button size="sm" variant="outline" disabled={verificationBusy} onClick={() => void doResolveVerification(v.verificationId, false)} className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10">
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
                  <Button size="sm" disabled={continuationBusy} onClick={() => void doResolveContinuation(lc.continuationId, 'continue')} className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20">
                    <Check className="size-3.5" aria-hidden /> Continue +{lc.extraBudget}
                  </Button>
                  <Button size="sm" variant="outline" disabled={continuationBusy} onClick={() => void doResolveContinuation(lc.continuationId, 'deny')} className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10">
                    <X className="size-3.5" aria-hidden /> End task
                  </Button>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">denying ends the task as limit_reached · auto-denied after 5 min</p>
              </div>
            ))}
          </div>
        ) : null}

        {/* v1.0.6 §10.8/§16 — event queue (real runtime state, collapsible) */}
        {state?.eventQueue && state.eventQueue.length > 0 ? (
          <Collapsible className="mt-3">
            <CollapsibleTrigger className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-slate-300 hover:bg-white/[0.06]">
              <span>event queue · {state.eventQueue.filter((q) => q.status === 'queued').length} queued · {state.eventQueue.filter((q) => q.status === 'processing').length} processing</span>
              <ChevronDown className="size-4 text-sky-300/70" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="glass-inset nextool-scroll mt-2 max-h-44 space-y-1 overflow-y-auto rounded-md p-2">
                {[...state.eventQueue].sort((a, b) => b.seq - a.seq).map((q) => (
                  <p key={q.seq} className="flex items-center gap-2 font-mono text-[10px]">
                    <span className={q.status === 'processing' ? 'text-amber-300' : q.status === 'queued' ? 'text-slate-400' : 'text-slate-600'}>{q.status === 'processing' ? '●' : '○'}</span>
                    <span className="text-foreground/90">{q.type}</span>
                    <span className="text-muted-foreground">seq {q.seq} · prio {q.priority}</span>
                    <span className="ml-auto shrink-0 text-slate-500">{q.status}</span>
                  </p>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </section>

      {/* Mobile: segmented tabs — Overview · Timeline · Tools · Internals */}
      <div className="lg:hidden">
        <Tabs defaultValue="overview" className="gap-3">
          <TabsList className="glass-card h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg p-1 nextool-scroll" aria-label="Task sections">
            <TabsTrigger
              value="overview"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger
              value="timeline"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Timeline
            </TabsTrigger>
            <TabsTrigger
              value="tools"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Tools
            </TabsTrigger>
            <TabsTrigger
              value="internals"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Internals
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-3 space-y-4 outline-none">
            {goalCard}
            {subgoalCard}
            {isTerminal ? finalOutputSection : livePreview}
            {planSection}
            {recoverySection}
          </TabsContent>
          <TabsContent value="timeline" className="mt-3 space-y-4 outline-none">
            {timelineSection}
            {/* v1.0.3 §1: the live terminal disappears once the task finishes. */}
            {!isTerminal ? terminal : null}
          </TabsContent>
          <TabsContent value="tools" className="mt-3 space-y-4 outline-none">
            {toolsSection}
          </TabsContent>
          <TabsContent value="internals" className="mt-3 space-y-4 outline-none">
            {stateSection}
            {contextSection}
          </TabsContent>
        </Tabs>
      </div>

      {/* Desktop (lg+): rich multi-column layout */}
      <div className="hidden space-y-4 lg:block">
        <div className="grid gap-4 md:grid-cols-2">
          {goalCard}
          {subgoalCard}
        </div>

        {planSection}

        {recoverySection}

        {isTerminal ? finalOutputSection : livePreview}

        <div className="grid gap-4 lg:grid-cols-2">
          {toolsSection}
          {stateSection}
        </div>

        {contextSection}

        {timelineSection}
      </div>

      {/* Stop confirm dialog */}
      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><Ban className="size-4" aria-hidden /> Stop task?</DialogTitle>
            <DialogDescription>
              Cancellation is sent to the runtime: active executions are aborted and the task terminates with status <code className="font-mono">stopped</code>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setStopOpen(false)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" disabled={stopping} onClick={() => void doStop()}>
              {stopping ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Square className="size-4" aria-hidden />} Stop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send event dialog */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send event to task</DialogTitle>
            <DialogDescription>Injects a runtime event. <code className="font-mono">scheduled.force</code> wakes live-mode ticks immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-type">Event type</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger id="ev-type" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent className="glass-strong">
                  <SelectItem value="user.message">user.message</SelectItem>
                  <SelectItem value="environment.custom">environment.custom</SelectItem>
                  <SelectItem value="scheduled.force">scheduled.force</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-payload">Payload (JSON)</Label>
              <Textarea id="ev-payload" value={eventPayload} onChange={(e) => setEventPayload(e.target.value)} rows={4} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" placeholder="{}" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setEventOpen(false)}>Cancel</Button>
            <Button className="min-h-11 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={busy} onClick={() => void doSendEvent()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feedback dialog (spec §60) */}
      <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-300"><MessageSquareWarning className="size-4" aria-hidden /> Send feedback</DialogTitle>
            <DialogDescription>Tell the runtime a decision was wrong. It records a user.feedback event and adapts context.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fb-msg">What was incorrect?</Label>
              <Textarea id="fb-msg" value={feedbackMsg} onChange={(e) => setFeedbackMsg(e.target.value)} rows={3} className="border-white/[0.09] bg-white/[0.04] text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-action">Correct action <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="fb-action" value={feedbackAction} onChange={(e) => setFeedbackAction(e.target.value)} className="min-h-11 border-white/[0.09] bg-white/[0.04] text-sm" placeholder="e.g. restart api-01 before health check" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setFeedbackOpen(false)}>Cancel</Button>
            <Button className="min-h-11 bg-amber-500/90 text-slate-950 hover:bg-amber-400" disabled={busy} onClick={() => void doSendFeedback()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageSquareWarning className="size-4" aria-hidden />} Send feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
