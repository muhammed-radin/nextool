/**
 * NexTool v1.0.6 → v1.0.14 — async alert()/prompt()/confirm() runtime functions
 * (spec v1.0.6 §1.5–§1.7, v1.0.8 §1, v1.0.13 choices, v1.0.14 §20–§22).
 *
 * v1.0.14 — FULLY INTERACTIVE RUNTIME (§20/§21): await alert(), confirm(),
 * askForUserAsChoice() and prompt() are REAL user interactions in EVERY
 * runtime mode — including the Tool Editor test runtime. None of them
 * auto-resolve anymore: the execution stays "waiting_for_user" until the
 * operator responds (or the 120s window expires). The editor renders the
 * interaction UI from the same pending registries the console uses.
 *
 * v1.0.14 §22 — ADVANCED prompt(): the message argument may be a structured
 * spec `{ message, type, placeholder?, defaultValue? }` with input types:
 * text, textarea, number, email, password, url, search, date, time,
 * datetime-local, month, week, color, file. `type: "file"` resolves to a
 * JSON string `{ name, mimeType, size, content? }` (content only when the
 * operator picks a small file — huge contents are never blindly injected).
 *
 * These are NEXTOOL runtime functions, not the browser's blocking dialogs:
 *
 *   await alert("Server recovery completed.");        → OK dialog, resolves
 *   const name = await prompt("Enter the server:");   → PAUSES the tool until
 *     the user answers via the console UI, cancels, or the 120s timeout hits.
 *   const ok = await confirm("Delete the files?");     → PAUSES the tool,
 *     shows the NexTool confirmation UI, ALWAYS resolves to a boolean
 *     (never "yes"/"no" strings). Cancellation/timeout resolve FALSE — an
 *     unresolved confirmation is never treated as true (§1.4).
 *   const region = await askForUserAsChoice("Deploy target?", [
 *     "staging", "production"]);                       → PAUSES the tool,
 *     renders one button per option; resolves to the chosen VALUE or
 *     null (cancel/timeout).
 *   const picked = await prompt({ message: "Upload config", type: "file" });
 *                                                      → file chooser; JSON
 *     metadata string (see above).
 *
 * The runtime is NEVER frozen while a tool waits: only that tool's Promise
 * pends — the task loop, scheduler and other tools keep running. The tool's
 * own execution deadline is extended for the duration of the wait (§1.6) and
 * reset once the user responds.
 *
 * Runtime events (§1.3): tool.user_alert (requested/dismissed),
 * tool.user_prompt.requested/responded, tool.confirm.requested/responded,
 * tool.user_choice.requested/responded — each carries taskId, executionId,
 * toolName and the request/response payload so the console (and the Tool
 * Editor test panel) can associate the response with the right interaction.
 */

import { emitEvent } from '../eventbus';

/** Prompt wait window (§1.6 "cancelled/timed out"). */
export const PROMPT_TIMEOUT_MS = 120_000;

/** Confirmation wait window (v1.0.8 §1.4) — on expiry the confirmation
 *  resolves FALSE (never true). Same runtime semantics as prompts. */
export const CONFIRM_TIMEOUT_MS = 120_000;

/** v1.0.13 — choice wait window; on expiry the choice resolves null. */
export const CHOICE_TIMEOUT_MS = 120_000;

/** v1.0.14 — alert wait window; on expiry the alert auto-dismisses. */
export const ALERT_TIMEOUT_MS = 120_000;

/** One selectable option of askForUserAsChoice(). */
export interface ChoiceOption {
  /** The value RESOLVED to the tool (stable id — never rewritten). */
  value: string;
  /** Optional button label shown to the operator (defaults to the value). */
  label?: string;
}

/** v1.0.14 §22 — supported prompt() input types. */
export const PROMPT_INPUT_TYPES = [
  'text', 'textarea', 'number', 'email', 'password', 'url', 'search',
  'date', 'time', 'datetime-local', 'month', 'week', 'color', 'file',
] as const;

export type PromptInputType = (typeof PROMPT_INPUT_TYPES)[number];

/** v1.0.14 §22 — structured prompt() configuration. */
export interface PromptSpec {
  message: string;
  type?: PromptInputType;
  placeholder?: string;
  defaultValue?: string;
}

/** Normalize a prompt() argument: string or structured spec (fail loud). */
export function normalizePromptSpec(input: string | PromptSpec): {
  message: string;
  inputType: PromptInputType;
  placeholder?: string;
  defaultValue?: string;
} {
  if (typeof input === 'string') {
    const msg = input === undefined || input === null ? '' : String(input);
    if (msg.length > 2000) throw new Error('prompt() message must be at most 2000 characters.');
    return { message: msg, inputType: 'text' };
  }
  if (!input || typeof input !== 'object') {
    throw new Error('prompt() expects a message string or a { message, type? } object.');
  }
  const message = String(input.message ?? '');
  if (!message.trim()) throw new Error('prompt() spec requires a non-empty message.');
  if (message.length > 2000) throw new Error('prompt() message must be at most 2000 characters.');
  const inputType = (input.type ?? 'text') as PromptInputType;
  if (!PROMPT_INPUT_TYPES.includes(inputType)) {
    throw new Error(
      `prompt() type "${String(input.type)}" is not supported. Supported types: ${PROMPT_INPUT_TYPES.join(', ')}.`,
    );
  }
  const placeholder = input.placeholder === undefined ? undefined : String(input.placeholder).slice(0, 200);
  const defaultValue = input.defaultValue === undefined ? undefined : String(input.defaultValue).slice(0, 4000);
  return { message, inputType, ...(placeholder !== undefined ? { placeholder } : {}), ...(defaultValue !== undefined ? { defaultValue } : {}) };
}

export interface SandboxInteractions {
  alert(message: string): Promise<void>;
  /** v1.0.14 §22 — accepts a plain message OR a structured spec. */
  prompt(message: string | PromptSpec, defaultValue?: string): Promise<string | null>;
  /** v1.0.8 §1 — async confirmation; ALWAYS resolves to a boolean. */
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  /** v1.0.13 — multiple-choice operator question; resolves the chosen VALUE
   *  or null (cancel/timeout). Options may be plain strings or {value,label}. */
  askForUserAsChoice(
    message: string,
    choices: Array<string | ChoiceOption>,
    options?: { default?: string },
  ): Promise<string | null>;
  /** Awaiting a prompt/confirm/choice/alert — the sandbox watchdog extends its deadline. */
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
  /** v1.0.14 §22 — the requested input type (drives the operator UI). */
  inputType: PromptInputType;
  placeholder?: string;
  requestedAt: string;
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** v1.0.14 — a pending alert: the OK/dismiss button resolves it. */
interface PendingAlert {
  alertId: string;
  taskId?: string;
  executionId: string;
  toolName?: string;
  message: string;
  requestedAt: string;
  resolve: () => void;
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
  __nextoolAlerts?: Map<string, PendingAlert>;
  __nextoolConfirms?: Map<string, PendingConfirm>;
  __nextoolChoices?: Map<string, PendingChoice>;
  __nextoolInteractionWatch?: Set<string>;
};

function choiceRegistry(): Map<string, PendingChoice> {
  if (!g.__nextoolChoices) g.__nextoolChoices = new Map();
  return g.__nextoolChoices;
}

function alertRegistry(): Map<string, PendingAlert> {
  if (!g.__nextoolAlerts) g.__nextoolAlerts = new Map();
  return g.__nextoolAlerts;
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
  /** v1.0.14 §22 — input type requested by the tool (text/date/color/...). */
  inputType: PromptInputType;
  placeholder?: string;
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
    out.push({
      promptId: id, taskId: p.taskId, toolName: p.toolName, message: p.message,
      inputType: p.inputType, ...(p.placeholder !== undefined ? { placeholder: p.placeholder } : {}),
      requestedAt: p.requestedAt,
    });
  }
  return out;
}

/** File metadata attached by the operator UI for `type: "file"` prompts. */
export interface PromptFileValue {
  name: string;
  mimeType?: string;
  size?: number;
  /** Base64/data-url content — ONLY for small files (client-capped). */
  content?: string;
}

/** Compose the string the TOOL receives for a file prompt (§22.1): a JSON
 *  object with name/mime/size and (only when provided) the content. */
function composeFileValue(file: PromptFileValue): string {
  return JSON.stringify({
    name: String(file.name ?? 'file').slice(0, 300),
    mimeType: file.mimeType === undefined ? undefined : String(file.mimeType).slice(0, 200),
    size: typeof file.size === 'number' && Number.isFinite(file.size) ? Math.round(file.size) : undefined,
    ...(typeof file.content === 'string' && file.content ? { content: file.content.slice(0, 700_000) } : {}),
  });
}

/**
 * Resolve a pending prompt from the console UI. Returns false when
 * unknown/expired. `file` carries structured file-prompt metadata — the tool
 * receives it as a JSON string (never a fabricated plain-text answer).
 */
export function resolvePendingPrompt(promptId: string, value: string | null, file?: PromptFileValue): boolean {
  const p = promptRegistry().get(promptId);
  if (!p) return false;
  clearTimeout(p.timer);
  promptRegistry().delete(promptId);
  let resolved: string | null = value === null ? null : String(value).slice(0, 4000);
  if (p.inputType === 'file') {
    resolved = file ? composeFileValue(file) : null;
  }
  p.resolve(resolved);
  void emitEvent({
    taskId: p.taskId,
    type: 'tool.user_prompt.responded',
    source: 'user',
    message: resolved === null ? `Prompt cancelled: ${p.message.slice(0, 120)}` : `Prompt answered: ${p.message.slice(0, 120)}`,
    data: {
      promptId, executionId: p.executionId,
      value: resolved === null ? null : resolved.slice(0, 500),
      cancelled: resolved === null, inputType: p.inputType,
    },
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

// ---------- alerts (v1.0.14 §20 — interactive, never silent) ----------

export interface PendingAlertInfo {
  alertId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  requestedAt: string;
}

/** List pending alerts (optionally scoped to a task) — powers the console UI. */
export function listPendingAlerts(taskId?: string): PendingAlertInfo[] {
  const now = Date.now();
  const out: PendingAlertInfo[] = [];
  for (const [id, a] of alertRegistry()) {
    if (now - Date.parse(a.requestedAt) > ALERT_TIMEOUT_MS + 1000) {
      clearTimeout(a.timer);
      alertRegistry().delete(id);
      continue;
    }
    if (taskId && a.taskId !== taskId) continue;
    out.push({ alertId: id, taskId: a.taskId, toolName: a.toolName, message: a.message, requestedAt: a.requestedAt });
  }
  return out;
}

/** Dismiss a pending alert (the OK button). Returns false when unknown/expired. */
export function resolvePendingAlert(alertId: string): boolean {
  const a = alertRegistry().get(alertId);
  if (!a) return false;
  clearTimeout(a.timer);
  alertRegistry().delete(alertId);
  a.resolve();
  void emitEvent({
    taskId: a.taskId,
    type: 'tool.user_alert.dismissed',
    source: 'user',
    message: `Alert dismissed: ${a.message.slice(0, 120)}`,
    data: { alertId, executionId: a.executionId, toolName: a.toolName ?? null },
    priority: 5,
  });
  return true;
}

/** Dismiss every pending alert for a task (task stop). */
export function cancelPendingAlertsForTask(taskId: string): void {
  for (const [id, a] of alertRegistry()) {
    if (a.taskId !== taskId) continue;
    clearTimeout(a.timer);
    alertRegistry().delete(id);
    a.resolve();
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

/**
 * v1.0.14 §20/§21 — INTERACTIVE in every mode. The tool test stays paused
 * ("waiting_for_user") until the operator responds — no auto-resolve, no
 * mock defaults. `mode` is kept in the signature for runtime-event context.
 */
function makePrompter(
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
) {
  return async function prompt(message: string | PromptSpec, defaultValue?: string): Promise<string | null> {
    // v1.0.14 §22 — string OR structured spec.
    const spec = normalizePromptSpec(message);
    // Legacy positional default applies to plain string messages (text input).
    if (typeof message === 'string' && defaultValue !== undefined) {
      spec.defaultValue = String(defaultValue).slice(0, 4000);
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
          message: spec.message,
          inputType: spec.inputType,
          ...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
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
          message: `Tool requests input (${spec.inputType}): ${spec.message.slice(0, 300)}`,
          data: {
            promptId, executionId, toolName: toolName ?? null, message: spec.message,
            inputType: spec.inputType, hasDefault: spec.defaultValue !== undefined,
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

/**
 * v1.0.14 §20 — alert() is INTERACTIVE: the OK button (or the 120s window)
 * resolves it. The emitted tool.user_alert event + pending registry entry
 * let the console/editor render the dialog.
 */
function makeAlerter(
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
) {
  return async function alert(message: string): Promise<void> {
    const msg = message === undefined || message === null ? '' : String(message);
    if (msg.length > 2000) throw new Error('alert() message must be at most 2000 characters.');
    const alertId = `alr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    deadline?.extendDeadline();
    interactionWatch().add(executionId);
    try {
      await new Promise<void>((resolve) => {
        const entry: PendingAlert = {
          alertId,
          taskId,
          executionId,
          toolName,
          message: msg,
          requestedAt: new Date().toISOString(),
          resolve,
          timer: setTimeout(() => {
            alertRegistry().delete(alertId);
            resolve();
          }, ALERT_TIMEOUT_MS),
        };
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
        alertRegistry().set(alertId, entry);
        void emitEvent({
          taskId,
          type: 'tool.user_alert',
          source: 'tool',
          message: `Tool alert: ${msg.slice(0, 300)}`,
          data: { alertId, executionId, toolName: toolName ?? null, message: msg },
          priority: 4,
        });
      });
    } finally {
      interactionWatch().delete(executionId);
      deadline?.resetDeadline();
    }
  };
}

/**
 * v1.0.8 §1 — async confirm(). Pauses THIS tool until the user answers the
 * NexTool confirmation UI, the request is cancelled, or the 120 s window
 * expires. ALWAYS resolves to a boolean; cancellation/timeout → false.
 */
function makeConfirmer(
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
) {
  return async function confirm(message: string, options?: { default?: boolean }): Promise<boolean> {
    const msg = message === undefined || message === null ? '' : String(message);
    if (msg.length > 2000) throw new Error('confirm() message must be at most 2000 characters.');
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

/**
 * v1.0.14 — LEGACY ALIAS kept for import compatibility. Test-mode
 * interactions are now REAL interactions (the Tool Editor test runtime waits
 * for the operator like production does — §20/§21: never auto-resolve).
 */
export function createTestInteractions(): SandboxInteractions {
  return createRuntimeInteractions(undefined, `test_${Date.now().toString(36)}`, undefined);
}

/** Runtime interactions — real events + pending registries; used by BOTH the
 *  production tool executor and the Tool Editor test runtime (v1.0.14). */
export function createRuntimeInteractions(
  taskId: string | undefined,
  executionId: string,
  toolName: string | undefined,
  deadline?: DeadlineController,
): SandboxInteractions {
  return {
    alert: makeAlerter(taskId, executionId, toolName, deadline),
    prompt: makePrompter(taskId, executionId, toolName, deadline),
    confirm: makeConfirmer(taskId, executionId, toolName, deadline),
    askForUserAsChoice: makeChoiceAsker(taskId, executionId, toolName, deadline),
    pendingCount: () => {
      let n = 0;
      for (const p of promptRegistry().values()) {
        if (p.executionId === executionId) n += 1;
      }
      for (const a of alertRegistry().values()) {
        if (a.executionId === executionId) n += 1;
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
