/**
 * NexTool v1.0.6 → v1.0.8 — async alert()/prompt()/confirm() runtime functions
 * (spec v1.0.6 §1.5–§1.7, v1.0.8 §1).
 * NexTool v1.0.13 — await askForUserAsChoice(): the operator picks ONE option
 * from a tool-provided list (multiple-choice question). Resolves to the
 * CHOSEN VALUE string, or null on cancel/timeout — the tool decides how to
 * handle "no answer" (an unresolved choice is never fabricated into one of
 * the options).
 *
 * These are NEXTOOL runtime functions, not the browser's blocking dialogs:
 *
 *   await alert("Server recovery completed.");        → runtime event, resolves
 *   const name = await prompt("Enter the server:");   → PAUSES the tool until
 *     the user answers via the console UI, cancels, or the 120s timeout hits.
 *   const ok = await confirm("Delete the files?");     → v1.0.8 §1 — PAUSES the
 *     tool, shows the NexTool confirmation UI, ALWAYS resolves to a boolean
 *     (never "yes"/"no" strings). Cancellation/timeout resolve FALSE — an
 *     unresolved confirmation is never treated as true (§1.4).
 *   const region = await askForUserAsChoice("Deploy target?", [
 *     "staging", "production"]);                       → v1.0.13 — PAUSES the
 *     tool, renders one button per option; resolves to the chosen VALUE or
 *     null (cancel/timeout).
 *
 * The runtime is NEVER frozen while a tool waits: only that tool's Promise
 * pends — the task loop, scheduler and other tools keep running. The tool's
 * own execution deadline is extended for the duration of the wait (§1.6) and
 * reset once the user responds.
 *
 * Runtime events (§1.3): tool.user_alert, tool.user_prompt.requested/
 * responded and tool.confirm.requested/responded — each carries taskId,
 * executionId, toolName and the request/response payload so the console can
 * associate the response with task/execution/tool/confirmation request.
 *
 * Two modes:
 *  - test (Tool IDE): alerts resolve immediately (logged as an event line),
 *    prompts resolve with their default value (or null) and confirms resolve
 *    with their declared default (or false) immediately — tests never hang on
 *    interactive input. Honest: documented in tool-development.md.
 *  - production (task execution): alert/prompt/confirm emit real events;
 *    prompts and confirms register in pending registries the console UI
 *    resolves via POST /api/prompts and POST /api/confirmations.
 */

import { emitEvent } from '../eventbus';

/** Prompt wait window (§1.6 "cancelled/timed out"). */
export const PROMPT_TIMEOUT_MS = 120_000;

/** Confirmation wait window (v1.0.8 §1.4) — on expiry the confirmation
 *  resolves FALSE (never true). Same runtime semantics as prompts. */
export const CONFIRM_TIMEOUT_MS = 120_000;

/** v1.0.13 — choice wait window; on expiry the choice resolves null. */
export const CHOICE_TIMEOUT_MS = 120_000;

/** One selectable option of askForUserAsChoice(). */
export interface ChoiceOption {
  /** The value RESOLVED to the tool (stable id — never rewritten). */
  value: string;
  /** Optional button label shown to the operator (defaults to the value). */
  label?: string;
}

export interface SandboxInteractions {
  alert(message: string): Promise<void>;
  prompt(message: string, defaultValue?: string): Promise<string | null>;
  /** v1.0.8 §1 — async confirmation; ALWAYS resolves to a boolean. */
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  /** v1.0.13 — multiple-choice operator question; resolves the chosen VALUE
   *  or null (cancel/timeout). Options may be plain strings or {value,label}. */
  askForUserAsChoice(
    message: string,
    choices: Array<string | ChoiceOption>,
    options?: { default?: string },
  ): Promise<string | null>;
  /** Awaiting a prompt/confirm/choice — the sandbox watchdog extends its deadline. */
  pendingCount(): number;
}

/** Normalize + validate choice options (fail loud — honest API). */
export function normalizeChoiceOptions(choices: Array<string | ChoiceOption>): ChoiceOption[] {
  if (!Array.isArray(choices)) {
    throw new Error('askForUserAsChoice() choices must be an array of strings or { value, label? } objects.');
  }
  if (choices.length === 0) {
    throw new Error('askForUserAsChoice() requires at least one choice option.');
  }
  if (choices.length > 12) {
    throw new Error('askForUserAsChoice() supports at most 12 choice options.');
  }
  const seen = new Set<string>();
  const out: ChoiceOption[] = [];
  for (const raw of choices) {
    const opt: ChoiceOption = typeof raw === 'string' ? { value: raw } : { value: raw?.value, label: raw?.label };
    const value = typeof opt.value === 'string' ? opt.value.trim() : '';
    if (!value || value.length > 120) {
      throw new Error('askForUserAsChoice() option values must be non-empty strings of at most 120 characters.');
    }
    const label = opt.label === undefined ? undefined : String(opt.label).slice(0, 200);
    if (seen.has(value)) continue; // silent dedupe of repeated values
    seen.add(value);
    out.push({ value, ...(label !== undefined ? { label } : {}) });
  }
  if (out.length === 0) {
    throw new Error('askForUserAsChoice() requires at least one choice option.');
  }
  return out;
}

interface PendingPrompt {
  promptId: string;
  taskId?: string;
  executionId: string;
  toolName?: string;
  message: string;
  requestedAt: string;
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** v1.0.8 §1 — a pending tool confirmation (yes/no interaction). */
interface PendingConfirm {
  confirmId: string;
  taskId?: string;
  executionId: string;
  toolName?: string;
  message: string;
  requestedAt: string;
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** v1.0.13 — a pending multiple-choice operator question. */
interface PendingChoice {
  choiceId: string;
  taskId?: string;
  executionId: string;
  toolName?: string;
  message: string;
  options: ChoiceOption[];
  requestedAt: string;
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as unknown as {
  __nextoolPrompts?: Map<string, PendingPrompt>;
  __nextoolConfirms?: Map<string, PendingConfirm>;
  __nextoolChoices?: Map<string, PendingChoice>;
  __nextoolInteractionWatch?: Set<string>;
};

function choiceRegistry(): Map<string, PendingChoice> {
  if (!g.__nextoolChoices) g.__nextoolChoices = new Map();
  return g.__nextoolChoices;
}

/** v1.0.8 — execution-scoped interaction watch: lets the EXECUTOR timeout
 *  watchdog defer while THIS execution is waiting for a user answer (§1.2 —
 *  "the tool resumes only after the user responds"), mirroring the sandbox
 *  deadline deferral. Prompts and confirms self-clear via their own 120s
 *  windows, so the executor can never hang forever on this. */
function interactionWatch(): Set<string> {
  if (!g.__nextoolInteractionWatch) g.__nextoolInteractionWatch = new Set();
  return g.__nextoolInteractionWatch;
}

export function hasPendingInteraction(executionId: string): boolean {
  return interactionWatch().has(executionId);
}

function promptRegistry(): Map<string, PendingPrompt> {
  if (!g.__nextoolPrompts) g.__nextoolPrompts = new Map();
  return g.__nextoolPrompts;
}

function confirmRegistry(): Map<string, PendingConfirm> {
  if (!g.__nextoolConfirms) g.__nextoolConfirms = new Map();
  return g.__nextoolConfirms;
}

export interface PendingPromptInfo {
  promptId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  requestedAt: string;
}

/** List pending prompts (optionally scoped to a task) — powers the console UI. */
export function listPendingPrompts(taskId?: string): PendingPromptInfo[] {
  const now = Date.now();
  const out: PendingPromptInfo[] = [];
  for (const [id, p] of promptRegistry()) {
    if (now - Date.parse(p.requestedAt) > PROMPT_TIMEOUT_MS + 1000) {
      clearTimeout(p.timer);
      promptRegistry().delete(id);
      continue;
    }
    if (taskId && p.taskId !== taskId) continue;
    out.push({ promptId: id, taskId: p.taskId, toolName: p.toolName, message: p.message, requestedAt: p.requestedAt });
  }
  return out;
}

/** Resolve a pending prompt from the console UI. Returns false when unknown/expired. */
export function resolvePendingPrompt(promptId: string, value: string | null): boolean {
  const p = promptRegistry().get(promptId);
  if (!p) return false;
  clearTimeout(p.timer);
  promptRegistry().delete(promptId);
  p.resolve(value === null ? null : String(value).slice(0, 4000));
  void emitEvent({
    taskId: p.taskId,
    type: 'tool.user_prompt.responded',
    source: 'user',
    message: value === null ? `Prompt cancelled: ${p.message.slice(0, 120)}` : `Prompt answered: ${p.message.slice(0, 120)}`,
    data: { promptId, executionId: p.executionId, value: value === null ? null : String(value).slice(0, 500), cancelled: value === null },
    priority: 4,
  });
  return true;
}

/** Reject + flush every pending prompt for a task (used when a task stops). */
export function cancelPendingPromptsForTask(taskId: string): void {
  for (const [id, p] of promptRegistry()) {
    if (p.taskId !== taskId) continue;
    clearTimeout(p.timer);
    promptRegistry().delete(id);
    p.resolve(null);
  }
}

// ---------- confirmations (v1.0.8 §1) ----------

export interface PendingConfirmInfo {
  confirmId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  requestedAt: string;
}

/** List pending confirmations (optionally scoped to a task) — powers the console UI. */
export function listPendingConfirmations(taskId?: string): PendingConfirmInfo[] {
  const now = Date.now();
  const out: PendingConfirmInfo[] = [];
  for (const [id, c] of confirmRegistry()) {
    if (now - Date.parse(c.requestedAt) > CONFIRM_TIMEOUT_MS + 1000) {
      clearTimeout(c.timer);
      confirmRegistry().delete(id);
      continue;
    }
    if (taskId && c.taskId !== taskId) continue;
    out.push({ confirmId: id, taskId: c.taskId, toolName: c.toolName, message: c.message, requestedAt: c.requestedAt });
  }
  return out;
}

/**
 * Resolve a pending confirmation from the console UI. Returns false when
 * unknown/expired. `accepted` is the user's boolean decision — the tool
 * ALWAYS receives a boolean (spec §1.1).
 */
export function resolvePendingConfirmation(confirmId: string, accepted: boolean): boolean {
  const c = confirmRegistry().get(confirmId);
  if (!c) return false;
  clearTimeout(c.timer);
  confirmRegistry().delete(confirmId);
  c.resolve(accepted === true);
  void emitEvent({
    taskId: c.taskId,
    type: 'tool.confirm.responded',
    source: 'user',
    message: accepted ? `Confirmation allowed: ${c.message.slice(0, 120)}` : `Confirmation denied: ${c.message.slice(0, 120)}`,
    data: { confirmId, executionId: c.executionId, toolName: c.toolName ?? null, accepted: accepted === true, cancelled: accepted !== true, message: c.message.slice(0, 500) },
    priority: 3,
  });
  return true;
}

export interface PendingChoiceInfo {
  choiceId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  options: ChoiceOption[];
  requestedAt: string;
}

/** List pending choice questions (optionally scoped to a task) — powers the console UI. */
export function listPendingChoices(taskId?: string): PendingChoiceInfo[] {
  const now = Date.now();
  const out: PendingChoiceInfo[] = [];
  for (const [id, c] of choiceRegistry()) {
    if (now - Date.parse(c.requestedAt) > CHOICE_TIMEOUT_MS + 1000) {
      clearTimeout(c.timer);
      choiceRegistry().delete(id);
      continue;
    }
    if (taskId && c.taskId !== taskId) continue;
    out.push({
      choiceId: id,
      taskId: c.taskId,
      toolName: c.toolName,
      message: c.message,
      options: c.options,
      requestedAt: c.requestedAt,
    });
  }
  return out;
}

/**
 * Resolve a pending choice question from the console UI. `value` MUST be one
 * of the offered option values (the operator picks, the tool never receives a
 * fabricated answer); null cancels. Returns false when unknown/expired/mismatch.
 */
export function resolvePendingChoice(choiceId: string, value: string | null): boolean {
  const c = choiceRegistry().get(choiceId);
  if (!c) return false;
  if (value !== null && !c.options.some((o) => o.value === value)) return false;
  clearTimeout(c.timer);
  choiceRegistry().delete(choiceId);
  c.resolve(value);
  void emitEvent({
    taskId: c.taskId,
    type: 'tool.user_choice.responded',
    source: 'user',
    message: value === null ? `Choice cancelled: ${c.message.slice(0, 120)}` : `Choice answered: ${value}`,
    data: {
      choiceId,
      executionId: c.executionId,
      toolName: c.toolName ?? null,
      value,
      cancelled: value === null,
      message: c.message.slice(0, 500),
    },
    priority: 4,
  });
  return true;
}

/** Cancel every pending choice for a task (task stop/pause transitions). */
export function cancelPendingChoicesForTask(taskId: string): void {
  for (const [id, c] of choiceRegistry()) {
    if (c.taskId !== taskId) continue;
    clearTimeout(c.timer);
    choiceRegistry().delete(id);
    c.resolve(null);
  }
}

/** Resolve every pending confirmation for a task as DENIED (§1.4 — used when a
 *  task stops/cancels: an unresolved confirmation is never treated as true). */
export function cancelPendingConfirmationsForTask(taskId: string): void {
  for (const [id, c] of confirmRegistry()) {
    if (c.taskId !== taskId) continue;
    clearTimeout(c.timer);
    confirmRegistry().delete(id);
    c.resolve(false);
    void emitEvent({
      taskId,
      type: 'tool.confirm.responded',
      source: 'system',
      message: `Confirmation cancelled (task stopped): ${c.message.slice(0, 120)}`,
      data: { confirmId: id, executionId: c.executionId, toolName: c.toolName ?? null, accepted: false, cancelled: true, reason: 'task_stopped' },
      priority: 4,
    });
  }
}

interface DeadlineController {
  /** Called while a prompt is pending so the sandbox watchdog defers. */
  extendDeadline(): void;
  /** Reset the watchdog once the interaction completes. */
  resetDeadline(): void;
}

function makePrompter(
  mode: 'test' | 'production',
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
) {
  return async function prompt(message: string, defaultValue?: string): Promise<string | null> {
    const msg = message === undefined || message === null ? '' : String(message);
    if (msg.length > 2000) throw new Error('prompt() message must be at most 2000 characters.');
    if (mode === 'test') {
      // Test mode resolves immediately with the default (or null) so the Tool
      // IDE test panel never hangs — the behavior is logged honestly.
      return defaultValue === undefined ? null : String(defaultValue);
    }
    const promptId = `pmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    deadline?.extendDeadline();
    interactionWatch().add(executionId);
    try {
      const value = await new Promise<string | null>((resolve) => {
        const entry: PendingPrompt = {
          promptId,
          taskId,
          executionId,
          toolName,
          message: msg,
          requestedAt: new Date().toISOString(),
          resolve,
          timer: setTimeout(() => {
            promptRegistry().delete(promptId);
            resolve(null);
          }, PROMPT_TIMEOUT_MS),
        };
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        promptRegistry().set(promptId, entry);
        void emitEvent({
          taskId,
          type: 'tool.user_prompt.requested',
          source: 'tool',
          message: `Tool requests input: ${msg.slice(0, 300)}`,
          data: { promptId, executionId, toolName: toolName ?? null, message: msg, hasDefault: defaultValue !== undefined },
          priority: 3,
        });
      });
      return value;
    } finally {
      interactionWatch().delete(executionId);
      deadline?.resetDeadline();
    }
  };
}

function makeAlerter(
  mode: 'test' | 'production',
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
) {
  return async function alert(message: string): Promise<void> {
    const msg = message === undefined || message === null ? '' : String(message);
    if (msg.length > 2000) throw new Error('alert() message must be at most 2000 characters.');
    if (mode === 'test') return; // resolved immediately; surfaced through tool logs by the caller
    void emitEvent({
      taskId,
      type: 'tool.user_alert',
      source: 'tool',
      message: `Tool alert: ${msg.slice(0, 300)}`,
      data: { executionId, toolName: toolName ?? null, message: msg },
      priority: 4,
    });
    return;
  };
}

/**
 * v1.0.8 §1 — async confirm(). Pauses THIS tool until the user answers the
 * NexTool confirmation UI, the request is cancelled, or the 120 s window
 * expires. ALWAYS resolves to a boolean; cancellation/timeout → false.
 */
function makeConfirmer(
  mode: 'test' | 'production',
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
) {
  return async function confirm(message: string, options?: { default?: boolean }): Promise<boolean> {
    const msg = message === undefined || message === null ? '' : String(message);
    if (msg.length > 2000) throw new Error('confirm() message must be at most 2000 characters.');
    if (mode === 'test') {
      // Test mode resolves immediately (never hangs): the declared default or
      // the conservative FALSE — an unresolved confirmation is never true.
      return options?.default === true;
    }
    const confirmId = `cfm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    deadline?.extendDeadline();
    interactionWatch().add(executionId);
    try {
      const accepted = await new Promise<boolean>((resolve) => {
        const entry: PendingConfirm = {
          confirmId,
          taskId,
          executionId,
          toolName,
          message: msg,
          requestedAt: new Date().toISOString(),
          resolve,
          timer: setTimeout(() => {
            // §1.4 — timed-out confirmation resolves FALSE.
            confirmRegistry().delete(confirmId);
            resolve(false);
          }, CONFIRM_TIMEOUT_MS),
        };
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        confirmRegistry().set(confirmId, entry);
        void emitEvent({
          taskId,
          type: 'tool.confirm.requested',
          source: 'tool',
          message: `Tool confirmation requested: ${msg.slice(0, 300)}`,
          data: { confirmId, executionId, toolName: toolName ?? null, message: msg, hasDefault: options?.default !== undefined },
          priority: 2,
        });
      });
      return accepted === true;
    } finally {
      interactionWatch().delete(executionId);
      deadline?.resetDeadline();
    }
  };
}

/**
 * v1.0.13 — async askForUserAsChoice(). Pauses THIS tool until the operator
 * picks one of the offered options in the console UI, the request is
 * cancelled, or the 120 s window expires. Resolves the chosen VALUE — never
 * a fabricated one — or null on cancel/timeout.
 */
function makeChoiceAsker(
  mode: 'test' | 'production',
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
) {
  return async function askForUserAsChoice(
    message: string,
    choices: Array<string | ChoiceOption>,
    options?: { default?: string },
  ): Promise<string | null> {
    const msg = message === undefined || message === null ? '' : String(message);
    if (msg.length > 2000) throw new Error('askForUserAsChoice() message must be at most 2000 characters.');
    const normalized = normalizeChoiceOptions(choices); // throws honestly on invalid input
    if (mode === 'test') {
      // Test mode resolves immediately (never hangs): the declared default when
      // it matches an offered option, otherwise the FIRST option's value.
      const fallback = normalized.find((o) => o.value === options?.default) ?? normalized[0];
      return fallback ? fallback.value : null;
    }
    const choiceId = `chc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    deadline?.extendDeadline();
    interactionWatch().add(executionId);
    try {
      const value = await new Promise<string | null>((resolve) => {
        const entry: PendingChoice = {
          choiceId,
          taskId,
          executionId,
          toolName,
          message: msg,
          options: normalized,
          requestedAt: new Date().toISOString(),
          resolve,
          timer: setTimeout(() => {
            // Unresolved choice resolves NULL — never one of the options.
            choiceRegistry().delete(choiceId);
            resolve(null);
          }, CHOICE_TIMEOUT_MS),
        };
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        choiceRegistry().set(choiceId, entry);
        void emitEvent({
          taskId,
          type: 'tool.user_choice.requested',
          source: 'tool',
          message: `Tool asks the operator to choose: ${msg.slice(0, 300)}`,
          data: {
            choiceId,
            executionId,
            toolName: toolName ?? null,
            message: msg,
            options: normalized,
            hasDefault: options?.default !== undefined,
          },
          priority: 3,
        });
      });
      return value;
    } finally {
      interactionWatch().delete(executionId);
      deadline?.resetDeadline();
    }
  };
}

/** Test-mode interactions (Tool IDE "Test Tool") — never hang. */
export function createTestInteractions(): SandboxInteractions {
  return {
    alert: makeAlerter('test', undefined, 'test', undefined),
    prompt: makePrompter('test', undefined, 'test', undefined),
    confirm: makeConfirmer('test', undefined, 'test', undefined),
    askForUserAsChoice: makeChoiceAsker('test', undefined, 'test', undefined),
    pendingCount: () => 0,
  };
}

/** Production interactions — real events + pending prompt/confirm registries. */
export function createRuntimeInteractions(
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
): SandboxInteractions {
  return {
    alert: makeAlerter('production', taskId, executionId, toolName),
    prompt: makePrompter('production', taskId, executionId, toolName, deadline),
    confirm: makeConfirmer('production', taskId, executionId, toolName, deadline),
    askForUserAsChoice: makeChoiceAsker('production', taskId, executionId, toolName, deadline),
    pendingCount: () => {
      let n = 0;
      for (const p of promptRegistry().values()) {
        if (p.executionId === executionId) n += 1;
      }
      for (const c of confirmRegistry().values()) {
        if (c.executionId === executionId) n += 1;
      }
      for (const c of choiceRegistry().values()) {
        if (c.executionId === executionId) n += 1;
      }
      return n;
    },
  };
}
