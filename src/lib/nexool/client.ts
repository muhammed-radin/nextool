/**
 * NexTool Q1 v1.0.1 — typed frontend API client.
 * Every call goes through apiFetch which enforces the ApiEnvelope contract:
 *   { ok: true, data: T } | { ok: false, error: { code, message } }
 * Network/HTTP failures throw ApiClientError — callers MUST handle them
 * (show error cards / toasts, never fabricate data).
 */
import type {
  ApiEnvelope, ApiError, SystemStats, GlobalLiveState, NexToolEvent,
  TaskSummary, TaskConfig, TaskMode, TaskStatus, ToolDefinition,
  ContextComposition, ToolExecution, MemoryEntryDTO, HistoryEntryDTO,
  NotificationDTO, GeneratedImageDTO, ActiveEngineInfo, ModelPackageInfo,
  DatasetInfo, DatasetImportPayload, DatasetExample, NexToolSettings,
  TrainingConfig, TrainingJobSummary, TrainingJobDetail,
  BenchmarkConfig, BenchmarkRunSummary, BenchmarkRunDetail,
  BrandingManifest,
} from './types';
import type { TaskDetail, ToolEntry } from './api-contract';

export class ApiClientError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'unknown', status = 0) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiClientError('Network unreachable — runtime may be offline', 'network_error', 0);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiClientError(`Invalid response from ${path} (HTTP ${res.status})`, 'bad_json', res.status);
  }

  const env = json as Partial<ApiEnvelope<T>>;
  if (!res.ok || !env || env.ok !== true || !('data' in env) || env.data === undefined) {
    const err = (env as { ok: false; error?: ApiError } | undefined)?.error;
    throw new ApiClientError(
      err?.message || `Request failed (HTTP ${res.status})`,
      err?.code || 'http_error',
      res.status,
    );
  }
  return env.data as T;
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function body(payload: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(payload ?? {}) };
}

// ---------- System / Live State ----------

export const getSystemStats = () => apiFetch<SystemStats>('/api/system');

export const getLiveState = () => apiFetch<GlobalLiveState>('/api/state');

export const injectEnvEvent = (payload: {
  type: 'server.crash' | 'server.degrade' | 'server.recover';
  serverId?: string;
}) => apiFetch<GlobalLiveState>('/api/env/event', body(payload));

// ---------- Tasks ----------

export interface ListTasksParams {
  status?: TaskStatus;
  mode?: TaskMode;
  limit?: number;
}

export const listTasks = (params: ListTasksParams = {}) =>
  apiFetch<TaskSummary[]>(`/api/tasks${qs(params)}`);

export interface CreateTaskPayload {
  request: string;
  config?: Partial<TaskConfig>;
  /** v1.0.12 Phase 7 — custom task instructions: content of an uploaded
   *  .md file and/or free-form textarea text. Combined server-side. */
  instructions?: {
    uploadedMarkdown?: string;
    text?: string;
  };
}

export const createTask = (payload: CreateTaskPayload) =>
  apiFetch<TaskDetail>('/api/tasks', body(payload));

export const getTaskDetail = (id: string) => apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);

export const stopTask = (id: string) =>
  apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}/stop`, body({}));

/** v1.0.6 §11 — Pause Live / Resume Live (pause preserves ALL state; stop terminates). */
export const pauseTask = (id: string) =>
  apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}/pause`, body({}));

export const resumeTask = (id: string) =>
  apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}/resume`, body({}));

export const sendTaskEvent = (id: string, payload: { type: string; payload?: Record<string, unknown> }) =>
  apiFetch<NexToolEvent>(`/api/tasks/${encodeURIComponent(id)}/event`, body(payload));

export const sendTaskFeedback = (id: string, payload: { message: string; correctAction?: string }) =>
  apiFetch<NexToolEvent>(`/api/tasks/${encodeURIComponent(id)}/feedback`, body(payload));

export interface TaskEventsParams {
  since?: string;
  limit?: number;
}

export const getTaskEvents = (id: string, params: TaskEventsParams = {}) =>
  apiFetch<NexToolEvent[]>(`/api/tasks/${encodeURIComponent(id)}/events${qs(params)}`);

export const getTaskContext = (id: string) =>
  apiFetch<ContextComposition>(`/api/tasks/${encodeURIComponent(id)}/context`);

export const getTaskExecutions = (id: string) =>
  apiFetch<ToolExecution[]>(`/api/tasks/${encodeURIComponent(id)}/executions`);

// ---------- Tools ----------

export const listTools = () => apiFetch<ToolEntry[]>('/api/tools');

export interface RegisterToolPayload {
  definition: ToolDefinition;
  handlerKind?: 'echo' | 'delay' | 'http_get' | 'uuid';
  handlerConfig?: Record<string, unknown>;
}

export const registerTool = (payload: RegisterToolPayload) =>
  apiFetch<ToolEntry>('/api/tools/register', body(payload));

export const toggleTool = (name: string, enabled: boolean) =>
  apiFetch<ToolEntry>(`/api/tools/${encodeURIComponent(name)}/toggle`, body({ enabled }));

// ---------- Tools v1.0.2 (Tool IDE) ----------

export interface JsToolPayload {
  name: string;
  description?: string;
  purpose?: string;
  category?: string;
  toolVersion?: string;
  /** v1.0.5: js-function (default) or nodejs — the restricted sandboxes. */
  environment?: 'js-function' | 'nodejs' | 'freedom-node';
  schema: ToolDefinition['schema'];
  functionSource: string;
  /** v1.0.5: structured metadata key/value pairs. */
  metadata?: Record<string, string>;
  /** v1.0.6 §9.2: per-tool auto-execute (default false = approval required). */
  autoExecute?: boolean;
  /** v1.0.13: verification latch — completed executions wait for operator verification. */
  verificationLatch?: boolean;
  /** v1.0.7 §1: tool-specific execution timeout (ms, 1000–3600000). */
  timeoutMs?: number;
  enabled?: boolean;
}

export const registerJsTool = (payload: JsToolPayload) =>
  apiFetch<ToolEntry>('/api/tools/js', body(payload));

export const getTool = (name: string) =>
  apiFetch<ToolEntry>(`/api/tools/${encodeURIComponent(name)}`);

export const updateTool = (
  name: string,
  payload: Partial<JsToolPayload> & {
    enabled?: boolean;
    renameTo?: string;
    /** v1.0.5: dynamic tools only. */
    handlerKind?: string;
    handlerConfig?: Record<string, unknown>;
  },
) => {
  const { renameTo, ...rest } = payload;
  return apiFetch<ToolEntry>(`/api/tools/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(renameTo ? { ...rest, name: renameTo } : rest),
  });
};

export const deleteTool = (name: string) =>
  apiFetch<{ deleted: boolean; name: string }>(`/api/tools/${encodeURIComponent(name)}`, { method: 'DELETE' });

export interface ToolTestResult {
  mode: 'registered' | 'test-source';
  status: 'completed' | 'failed' | 'timeout' | 'cancelled' | string;
  durationMs: number;
  result: unknown;
  error: { code: string; message: string } | null;
  params?: Record<string, unknown>;
  logs: string[];
}

export const testTool = (payload: {
  name?: string;
  functionSource?: string;
  /** v1.0.5: sandbox for an unsaved source — js-function (default) | nodejs. */
  environment?: 'js-function' | 'nodejs' | 'freedom-node';
  params?: Record<string, unknown>;
  /** v1.0.7 §1: effective execution timeout for the test run (ms). */
  timeoutMs?: number;
}) =>
  apiFetch<ToolTestResult>('/api/tools/test', body(payload));

// ---------- Maintenance (v1.0.7 §3/§4/§5) ----------

export interface ApplicationResetReport {
  ok: boolean;
  confirmPhrase: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  cleared: Record<string, number>;
  filesRemoved: number;
  failures: string[];
  protectedResources: readonly string[];
}

/** §3.3 — the backend REQUIRES the exact typed phrase "RESET". */
export const resetApplicationData = () =>
  apiFetch<ApplicationResetReport>('/api/settings/reset', body({ confirm: 'RESET' }));

export interface RemovedResource {
  id: string;
  name: string;
  version: string;
}

export interface CleanupReport {
  dryRun: boolean;
  ran: boolean;
  models: {
    protected: RemovedResource[];
    candidates: RemovedResource[];
    removed: RemovedResource[];
    failed: { resource: RemovedResource; error: string }[];
  };
  datasets: {
    protected: RemovedResource[];
    candidates: RemovedResource[];
    removed: RemovedResource[];
    failed: { resource: RemovedResource; error: string }[];
  };
  warnings: string[];
  durationMs: number;
  analyzedAt: string;
}

/** §4.8 — dry-run dependency analysis + cleanup report (never deletes). */
export const analyzeMaintenance = () =>
  apiFetch<CleanupReport>('/api/maintenance/cleanup');

/** §4.7 — execute the idempotent cleanup (only confirmed orphans are removed). */
export const runMaintenanceCleanup = () =>
  apiFetch<CleanupReport>('/api/maintenance/cleanup', body({ dryRun: false }));

export interface RuntimeValidationReport {
  ok: boolean;
  checkedAt: string;
  activeModel: { name: string; version: string; artifact: string; ok: boolean };
  fallbackModel: { name: string; ok: boolean };
  checks: { models: number; datasets: number; trainingJobs: number; benchmarkRuns: number; manifestParses: number };
  problems: { severity: 'error' | 'warning'; resource: string; message: string }[];
}

/** §4.11 — startup/on-demand dependency validation. */
export const validateRuntimeDependencies = () =>
  apiFetch<RuntimeValidationReport>('/api/maintenance/validate');

// ---------- Tool environments (v1.0.5) ----------

export interface HandlerKindConfigField {
  key: string;
  label: string;
  type: 'string' | 'number';
  required: boolean;
  description: string;
  min?: number;
  max?: number;
  placeholder?: string;
}

export interface HandlerKindDescriptor {
  kind: string;
  label: string;
  description: string;
  configFields: HandlerKindConfigField[];
}

export interface NodeEnvironmentInfo {
  modules: Record<string, { description: string; methods: string[]; virtual?: boolean }>;
  blocked: Record<string, string>;
  globals: { name: string; type: string; description: string }[];
  limits: {
    timeoutMs: number;
    syncTimeoutMs: number;
    memoryLimitMb: number;
    maxSourceChars: number;
    maxResultBytes: number;
    maxLogLines: number;
    moduleAllowlist: string[];
    childProcess?: { timeoutMs: number; maxOutputBytes: number; maxProcessesPerExecution: number; maxPipeStages: number; maxArgs: number };
    virtualCommands?: string[];
  };
}

export interface ToolEnvironmentInfo {
  environments: { id: string; label: string; description: string; authorable: boolean; execution: string }[];
  handlerKinds: HandlerKindDescriptor[];
  functionSandbox: {
    timeoutMs: number;
    /** v1.0.8 §9.5 — ceiling + default from the central limits. */
    timeoutMaxMs?: number;
    timeoutDefaultMs?: number;
    syncTimeoutMs: number;
    maxSourceChars: number;
    maxResultBytes: number;
    maxLogLines: number;
  };
  /** v1.0.6 §1.3/§3.1 — the enforced network policy. */
  network?: {
    allowedProtocols: string[];
    requestTimeoutMs: number;
    maxResponseBytes: number;
    maxRedirects: number;
    maxRequestsPerExecution: number;
    urlImportsEnabled: boolean;
    /** v1.0.91 — relative fetch URLs resolve against the application origin. */
    selfOriginAccess?: boolean;
  };
  /** v1.0.8 §5 — Virtual FS limits + workspace scaffold (live central limits). */
  vfs?: {
    limits: { maxFileBytes: number; maxTotalBytes: number; maxEntries: number; maxPathLength: number; maxDepth: number };
    workspaceDirectories: string[];
  };
  /** v1.0.8 §3 — virtual child_process policy (expanded command set). */
  childProcess?: {
    limits: { timeoutMs: number; maxOutputBytes: number; maxProcessesPerExecution: number; maxPipeStages: number; maxArgs: number; npmMaxPackages: number };
    virtualCommands: string[];
  };
  /** v1.0.6 §8 — capability matrix generated from the real runtime config.
   *  v1.0.11 — the freedomNode column describes the unrestricted environment. */
  capabilities?: { capability: string; jsFunction: string; nodejs: string; freedomNode?: string }[];
  /** v1.0.11 §20/§29 — freedom-node runtime reference (honest gate state). */
  freedomNode?: {
    enabled: boolean;
    fsConfig: { enabled: boolean; restricted: boolean };
    note: string;
    preservedLimits: Record<string, unknown>;
  };
  node: NodeEnvironmentInfo;
}

/** The REAL runtime environment configuration (§2.5/§3.6) — never hardcoded in the UI. */
export const getToolEnvironmentInfo = () => apiFetch<ToolEnvironmentInfo>('/api/tools/environments');

// ---------- Approvals & prompts (v1.0.6 §9/§1.7) ----------

export interface PendingApprovalDTO {
  approvalId: string;
  tool: string;
  params: Record<string, unknown>;
  purpose?: string;
  reason?: string;
  /** v1.0.15 §35 — tool environment (fs, freedom-node, mcp …) on the card. */
  environment?: string;
  /** v1.0.15 §35 — tool registry description on the card. */
  description?: string;
  /** v1.0.15 §36 — explicit approval state machine (pending on request). */
  state?: 'pending' | 'accepted' | 'skipped' | 'rejected' | 'cancelled';
  subgoal?: string;
  requestedAt: string;
}

export const listApprovals = (taskId?: string) =>
  apiFetch<{ approvals: PendingApprovalDTO[] }>(`/api/approvals${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

/**
 * v1.0.15 §31-§34 — resolve an approval with the THREE operator choices:
 * 'accept' (execute + continue), 'skip' (record skipped + continue) or
 * 'reject' (block + escalation ladder). 'allow'/'deny' remain accepted.
 */
export const resolveApprovalRequest = (approvalId: string, decision: 'accept' | 'skip' | 'reject' | 'allow' | 'deny', feedback?: string) =>
  apiFetch<{ resolved: boolean; decision?: string; state?: string; reason?: string }>('/api/approvals', body({ approvalId, decision, ...(feedback ? { feedback } : {}) }));

export interface PendingPromptDTO {
  promptId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  /** v1.0.14 §22 — requested input type (drives the operator UI control). */
  inputType?: string;
  placeholder?: string;
  requestedAt: string;
}

export interface PromptFilePayload {
  name: string;
  mimeType?: string;
  size?: number;
  /** Base64/data-url content — only for small files (client-capped). */
  content?: string;
}

export const listPrompts = (taskId?: string) =>
  apiFetch<{ prompts: PendingPromptDTO[] }>(`/api/prompts${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

export const answerPrompt = (promptId: string, value: string | null, file?: PromptFilePayload) =>
  apiFetch<{ resolved: boolean; reason?: string }>(
    '/api/prompts',
    body(value === null && !file ? { promptId, cancel: true } : { promptId, ...(value !== null ? { value } : {}), ...(file ? { file } : {}) }),
  );

// ---------- Alerts (v1.0.14 §20 — interactive alert dialogs) ----------

export interface PendingAlertDTO {
  alertId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  requestedAt: string;
}

export const listAlerts = (taskId?: string) =>
  apiFetch<{ alerts: PendingAlertDTO[] }>(`/api/alerts${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

export const dismissAlert = (alertId: string) =>
  apiFetch<{ resolved: boolean; reason?: string }>('/api/alerts', body({ alertId }));

// ---------- Confirmations (v1.0.8 §1) ----------

export interface PendingConfirmationDTO {
  confirmId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  requestedAt: string;
}

export const listConfirmations = (taskId?: string) =>
  apiFetch<{ confirmations: PendingConfirmationDTO[] }>(`/api/confirmations${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

export const answerConfirmation = (confirmId: string, accepted: boolean) =>
  apiFetch<{ resolved: boolean; reason?: string }>('/api/confirmations', body({ confirmId, accepted }));

// ---------- Choice questions (v1.0.13 — askForUserAsChoice) ----------

export interface PendingChoiceOptionDTO {
  value: string;
  label?: string;
}

export interface PendingChoiceDTO {
  choiceId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  options: PendingChoiceOptionDTO[];
  requestedAt: string;
}

export const listChoices = (taskId?: string) =>
  apiFetch<{ choices: PendingChoiceDTO[] }>(`/api/choices${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

/** value=null cancels; otherwise it must EXACTLY match one offered option value. */
export const answerChoice = (choiceId: string, value: string | null) =>
  apiFetch<{ resolved: boolean; reason?: string }>('/api/choices', body(value === null ? { choiceId, cancel: true } : { choiceId, value }));

// ---------- Verification latch (v1.0.13) ----------

export interface PendingVerificationDTO {
  verificationId: string;
  taskId?: string;
  executionId?: string;
  tool: string;
  resultSummary?: string;
  requestedAt: string;
}

export const listVerifications = (taskId?: string) =>
  apiFetch<{ verifications: PendingVerificationDTO[] }>(`/api/verifications${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

/** accepted=true verifies the result; false rejects it (execution → VERIFICATION_REJECTED). */
export const resolveVerificationRequest = (verificationId: string, accepted: boolean, feedback?: string) =>
  apiFetch<{ resolved: boolean; reason?: string }>('/api/verifications', body({ verificationId, accepted, ...(feedback ? { feedback } : {}) }));

// ---------- Safety-limit continuations (v1.0.13) ----------

export interface PendingLimitContinuationDTO {
  continuationId: string;
  taskId?: string;
  limitKind: 'maxIterations' | 'safetyLimit' | 'both';
  iterations: number;
  toolCalls: number;
  maxIterations: number;
  safetyLimit: number;
  extraBudget: number;
  requestedAt: string;
}

export const listLimitContinuations = (taskId?: string) =>
  apiFetch<{ continuations: PendingLimitContinuationDTO[] }>(`/api/limits/continuations${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

/** decision 'continue' grants the budget to both limits; 'deny' ends the task as before. */
export const resolveLimitContinuationRequest = (continuationId: string, decision: 'continue' | 'deny', feedback?: string) =>
  apiFetch<{ resolved: boolean; reason?: string }>('/api/limits/continuations', body({ continuationId, decision, ...(feedback ? { feedback } : {}) }));

// ---------- File requests (v1.0.13 §10 — fs.upload prompt) ----------

export interface PendingFileRequestDTO {
  requestId: string;
  taskId?: string;
  toolName?: string;
  message: string;
  suggestedName?: string;
  requestedAt: string;
}

export const listFileRequests = (taskId?: string) =>
  apiFetch<{ requests: PendingFileRequestDTO[] }>(`/api/file-requests${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);

/** Deliver the chosen file (base64) to the awaiting fs.upload tool, or cancel. */
export const answerFileRequest = (requestId: string, payload: { fileName: string; contentBase64: string } | { cancel: true }) =>
  apiFetch<{ resolved: boolean; cancelled?: boolean }>('/api/file-requests', body({ requestId, ...payload }));

// ---------- Configuration limits registry (v1.0.8 §7/§8/§10) ----------

export interface LimitPropertyDTO {
  type: 'integer' | 'number' | 'boolean' | 'string' | 'enum';
  nullable?: boolean;
  default: unknown;
  min?: number;
  max?: number;
  unit?: string;
  description?: string;
  step?: number;
  category?: string;
}

export interface ConfigurationLimitsDTO {
  limits: { version: number; [section: string]: unknown };
  resolved: Record<string, Record<string, number | boolean>>;
  source: string;
}

/** The resolved limits metadata — the Settings UI derives its input
 *  constraints from THIS (never hard-coded in components, spec §8.3). */
export const getConfigurationLimits = () => apiFetch<ConfigurationLimitsDTO>('/api/config/limits');

/** v1.0.14 §18 — fetch a full preset limits JSON ('standard' | 'unrestricted'). */
export const getLimitsPreset = (preset: 'standard' | 'unrestricted') =>
  apiFetch<{ preset: string; limits: { version: number; [section: string]: unknown } }>(`/api/config/limits?preset=${preset}`);

/** v1.0.14 §17.2/§18.1 — SAVE the full limits JSON (server validates before
 *  writing; the runtime hot-reloads within ~2 s). */
export const saveConfigurationLimits = (limits: { version: number; [section: string]: unknown }) =>
  apiFetch<{ saved: boolean; source: string }>('/api/config/limits', { method: 'PUT', body: JSON.stringify(limits) });

// ---------- Training (v1.0.2) ----------

export const listTrainingJobs = () => apiFetch<TrainingJobSummary[]>('/api/training');

export interface CreateTrainingPayload {
  datasetId: string;
  config?: Partial<TrainingConfig>;
}

export const createTrainingJob = (payload: CreateTrainingPayload) =>
  apiFetch<TrainingJobSummary>('/api/training', body(payload));

export const getTrainingJob = (id: string) =>
  apiFetch<TrainingJobDetail>(`/api/training/${encodeURIComponent(id)}`);

/** Cancel (running) or remove (finished) a training job. */
export const cancelTrainingJob = (id: string) =>
  apiFetch<{ cancelled?: boolean; deleted?: boolean }>(`/api/training/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---------- Benchmark (v1.0.2) ----------

export const listBenchmarkRuns = () => apiFetch<BenchmarkRunSummary[]>('/api/benchmark');

export interface CreateBenchmarkPayload extends BenchmarkConfig {
  label?: string;
}

export const runBenchmarkJob = (payload: CreateBenchmarkPayload) =>
  apiFetch<BenchmarkRunSummary>('/api/benchmark', body(payload));

export const getBenchmarkRun = (id: string) =>
  apiFetch<BenchmarkRunDetail>(`/api/benchmark/${encodeURIComponent(id)}`);

// ---------- Model packages (v1.0.2) ----------

export const modelExportUrl = (id: string, format: 'tfjs' | 'nextool') =>
  `/api/models/export?id=${encodeURIComponent(id)}&format=${format}`;

export const importModelPackage = async (file: File) => {
  const form = new FormData();
  form.set('file', file);
  let res: Response;
  try {
    res = await fetch('/api/models/import', { method: 'POST', body: form });
  } catch {
    throw new ApiClientError('Network unreachable — runtime may be offline', 'network_error', 0);
  }
  const json = (await res.json().catch(() => null)) as ApiEnvelope<ImportModelResult> | null;
  if (!res.ok || !json || json.ok !== true) {
    const err = json && 'error' in json ? json.error : undefined;
    throw new ApiClientError(err?.message ?? `Import failed (HTTP ${res.status})`, err?.code ?? 'http_error', res.status);
  }
  return json.data;
};

export interface ImportModelResult {
  name: string;
  version: string;
  format: string;
  modelRecordId: string;
  runnable: boolean;
  metadata: {
    packageName: string;
    applicationVersion: string;
    modelVersion: string;
    architecture: string;
    parameterCount: number;
    datasetVersion: string | null;
    createdAt: string;
    tfjsCompatibility: string;
    packageFormat: string;
    notes?: string;
  } | null;
  warnings: string[];
}

// ---------- Branding icons (v1.0.2) ----------

export interface BrandingState {
  manifest: (BrandingManifest & { packageId: string }) | null;
  active: (BrandingManifest & { packageId: string }) | null;
}

export const getBranding = () => apiFetch<BrandingState>('/api/icons');

export const uploadIconPackage = async (file: File) => {
  const form = new FormData();
  form.set('file', file);
  let res: Response;
  try {
    res = await fetch('/api/icons', { method: 'POST', body: form });
  } catch {
    throw new ApiClientError('Network unreachable — runtime may be offline', 'network_error', 0);
  }
  const json = (await res.json().catch(() => null)) as ApiEnvelope<IconUploadResult> | null;
  if (!res.ok || !json || json.ok !== true) {
    const err = json && 'error' in json ? json.error : undefined;
    throw new ApiClientError(err?.message ?? `Upload rejected (HTTP ${res.status})`, err?.code ?? 'http_error', res.status);
  }
  return json.data;
};

export interface IconUploadResult {
  packageId: string;
  manifest: BrandingManifest;
  accepted: { file: string; width: number | null; height: number | null; bytes: number }[];
  rejected: { file: string; reason: string }[];
  /** v1.0.3: well-known non-icon entries that were intentionally skipped. */
  ignored?: { file: string; reason: string }[];
}

export const activateIconPackage = (packageId: string) =>
  apiFetch<BrandingManifest>('/api/icons', { method: 'PATCH', body: JSON.stringify({ action: 'activate', packageId }) });

export const discardIconPackage = () =>
  apiFetch<{ discarded: boolean }>('/api/icons', { method: 'DELETE' });

// ---------- Memory ----------

export const listMemory = () => apiFetch<MemoryEntryDTO[]>('/api/memory');

export const addMemory = (payload: {
  key: string;
  value: unknown;
  tags?: string[];
  source?: string;
}) => apiFetch<MemoryEntryDTO>('/api/memory', body(payload));

export const deleteMemory = (key: string) =>
  apiFetch<{ deleted: boolean }>(`/api/memory${qs({ key })}`, { method: 'DELETE' });

// ---------- History / Notifications / Images ----------

export const listHistory = (params: { taskId?: string; limit?: number } = {}) =>
  apiFetch<HistoryEntryDTO[]>(`/api/history${qs(params)}`);

export const listNotifications = (params: { limit?: number } = {}) =>
  apiFetch<NotificationDTO[]>(`/api/notifications${qs(params)}`);

export const markNotificationsRead = () =>
  apiFetch<{ ok: boolean }>('/api/notifications/read-all', body({}));

export const listImages = (params: { limit?: number } = {}) =>
  apiFetch<GeneratedImageDTO[]>(`/api/images${qs(params)}`);

// ---------- Models ----------

export interface CurrentTrainedModelInfo {
  id: string;
  name: string;
  version: string;
  format: string;
  classes: string[];
  vocabSize: number | null;
  parameterCount: number | null;
  datasetVersion: string | null;
  finalMetrics: Record<string, unknown> | null;
  trainedAt: string;
}

export interface ModelsInfo {
  engine: ActiveEngineInfo;
  packages: ModelPackageInfo[];
  /** v1.0.15 — the CURRENT TRAINED MODEL (registry status='active'): the
   *  checkpoint the runtime classifier serves (CoreModule hint + fallback). */
  currentModel?: CurrentTrainedModelInfo | null;
  adapters: { tfjs: boolean; nextoolManifest: boolean; parquet: boolean };
  /** v1.0.2: application version from the runtime. */
  appVersion?: string;
}

export const getModels = () => apiFetch<ModelsInfo>('/api/models');

export const loadModel = (payload: { manifest: Record<string, unknown> }) =>
  apiFetch<ModelPackageInfo>('/api/models/load', body(payload));

// ---------- Datasets ----------

export const listDatasets = () => apiFetch<DatasetInfo[]>('/api/datasets');

export const importDataset = (payload: DatasetImportPayload) =>
  apiFetch<DatasetInfo>('/api/datasets/import', body(payload));

/**
 * v1.0.3 — multipart dataset import (.parquet or .json file upload).
 * The .parquet path is decoded by the REAL Parquet adapter server-side.
 */
export const importDatasetFile = async (
  file: File,
  meta: { name?: string; version?: string; note?: string } = {},
) => {
  const form = new FormData();
  form.set('file', file);
  if (meta.name) form.set('name', meta.name);
  if (meta.version) form.set('version', meta.version);
  if (meta.note) form.set('note', meta.note);
  let res: Response;
  try {
    res = await fetch('/api/datasets/import', { method: 'POST', body: form });
  } catch {
    throw new ApiClientError('Network unreachable — runtime may be offline', 'network_error', 0);
  }
  const json = (await res.json().catch(() => null)) as ApiEnvelope<DatasetInfo> | null;
  if (!res.ok || !json || json.ok !== true) {
    const err = json && 'error' in json ? json.error : undefined;
    throw new ApiClientError(err?.message ?? `Import rejected (HTTP ${res.status})`, err?.code ?? 'http_error', res.status);
  }
  return json.data;
};

export const exportDatasetUrl = (id: string, format: 'json' | 'parquet' = 'json') =>
  `/api/datasets/${encodeURIComponent(id)}/export?format=${format}`;

export interface DatasetExport {
  dataset: DatasetInfo;
  examples: DatasetExample[];
}

export const exportDataset = (id: string) => apiFetch<DatasetExport>(exportDatasetUrl(id));

export const deleteDataset = (id: string) =>
  apiFetch<{ deleted: boolean }>(`/api/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---------- Settings ----------

export const getSettings = () => apiFetch<NexToolSettings>('/api/settings');

export const updateSettings = (partial: Partial<NexToolSettings>) =>
  apiFetch<NexToolSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(partial) });

// ---------- Documentation ----------

export interface DocMetaDTO {
  slug: string;
  title: string;
  category: string;
  order: number;
  excerpt: string;
}

export interface DocsIndex {
  version: string;
  count: number;
  docs: DocMetaDTO[];
}

export interface DocPage extends DocMetaDTO {
  content: string;
  updatedAt: string;
}

export const getDocsIndex = () => apiFetch<DocsIndex>('/api/docs');

export const getDocPage = (slug: string) =>
  apiFetch<DocPage>(`/api/docs/${encodeURIComponent(slug)}`);

// ---------- MCP connectors (v1.0.12) ----------

export interface ImportedToolDTO {
  name: string;
  mcpToolName: string;
  description: string;
  enabled: boolean;
  paramCount: number;
  remoteHash?: string;
  importedAt?: string;
  lastRefreshedAt?: string;
  customizedDescription: boolean;
}

export interface ConnectorDTO {
  id: string;
  providerId: string;
  /** User-facing connector name (editable). */
  name: string;
  providerName: string;
  providerDescription: string;
  providerCategory: string;
  docsUrl?: string;
  transportType: 'stdio' | 'http';
  authType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  status: 'not_connected' | 'connecting' | 'auth_required' | 'connected' | 'disconnected' | 'error' | 'reconnecting';
  statusDetail?: string | null;
  lastError?: string | null;
  lastConnectedAt?: string | null;
  hasCredentials: boolean;
  credentialFieldsProvided: string[];
  missingRequiredFields: string[];
  authRequired: boolean;
  /** v1.0.13 §5 — effective selectable auth method (stored or inferred). */
  authMethod?: 'none' | 'bearer' | 'token_pair' | 'oauth2';
  /** v1.0.13 §5.4 — presence of a refresh token (NEVER the value). */
  hasRefreshToken?: boolean;
  serverInfo?: { name: string; version: string } | null;
  importedTools: ImportedToolDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface McpProviderFieldDTO {
  key: string;
  label: string;
  type: 'string' | 'number';
  required: boolean;
  secret?: boolean;
  placeholder?: string;
  description: string;
  envName?: string;
}

export interface McpProviderOAuthPresetDTO {
  authorizeUrl: string;
  tokenUrl: string;
  /** Editable preset scopes (§5.3) — the UI shows them as chips + an arbitrary adder. */
  defaultScopes: string[];
  pkce?: boolean;
  expiresInSecs?: number;
  /** Extra fixed authorize params declared by the preset. */
  extraAuthorizeParams?: Record<string, string>;
}

export type McpAuthMethodDTO = 'none' | 'bearer' | 'token_pair' | 'oauth2';

export interface McpProviderDTO {
  id: string;
  name: string;
  description: string;
  category: string;
  docsUrl?: string;
  enabled: boolean;
  transport: {
    type: 'stdio' | 'http';
    defaultCommand?: string;
    defaultArgs?: string[];
    defaultUrl?: string;
    configFields: McpProviderFieldDTO[];
  };
  authentication: {
    type: string;
    title: string;
    description: string;
    injection: 'env' | 'header';
    requiredFields: string[];
    optionalFields: string[];
    fields: McpProviderFieldDTO[];
    // ---- v1.0.13 §5 — customizable authentication metadata (registry-driven) ----
    authMethods?: McpAuthMethodDTO[];
    requiredFieldsByMethod?: Partial<Record<McpAuthMethodDTO, string[]>>;
    oauth?: McpProviderOAuthPresetDTO;
    loginWording?: string;
    validation?: 'none' | 'google_tokeninfo' | 'github_user';
  };
}

export interface ConnectorsStateDTO {
  registryVersion: number;
  providers: McpProviderDTO[];
  connectors: ConnectorDTO[];
}

export interface DiscoveredToolDTO {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  remoteHash: string;
  imported: boolean;
  importedToolName?: string;
}

// v1.0.13 §4 — capability discovery beyond tools (all optional, empty when
// the server does not expose the capability).
export interface DiscoveredResourceDTO {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface DiscoveredResourceTemplateDTO {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface DiscoveredPromptDTO {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface DiscoveredServerInfoDTO {
  name: string;
  version: string;
  capabilities: Record<string, unknown> | null;
}

export interface ImportResultDTO {
  imported: string[];
  updated: string[];
  failed: { name: string; reason: string }[];
}

export interface RefreshResultDTO {
  refreshed: { name: string; mcpToolName: string; changed: boolean; summary: string }[];
  unavailable: string[];
}

export const listConnectors = () => apiFetch<ConnectorsStateDTO>('/api/connectors');

export const getConnector = (id: string) =>
  apiFetch<ConnectorDTO>(`/api/connectors/${encodeURIComponent(id)}`);

export const createConnector = (payload: { providerId: string; name?: string; config?: Record<string, string | number> }) =>
  apiFetch<ConnectorDTO>('/api/connectors', body(payload));

export const updateConnector = (id: string, payload: { name?: string; config?: Record<string, string | number>; enabled?: boolean }) =>
  apiFetch<ConnectorDTO>(`/api/connectors/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });

export const deleteConnector = (id: string) =>
  apiFetch<{ deleted: true; id: string; removedTools: string[] }>(`/api/connectors/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const connectorConnectionAction = (id: string, action: 'connect' | 'disconnect' | 'reconnect') =>
  apiFetch<ConnectorDTO>(`/api/connectors/${encodeURIComponent(id)}/connection`, body({ action }));

/** v1.0.13 §5.4 — rotate the stored access token via the refresh-token grant. */
export const connectorRefreshAuth = (id: string) =>
  apiFetch<{ refreshed: boolean; tokenExpiresAt?: string }>(`/api/connectors/${encodeURIComponent(id)}/connection`, body({ action: 'refresh-auth' }));

/** v1.0.13 §5.2 — begin the OAuth redirect login; returns the authorize URL. */
export const startConnectorOAuth = (id: string) =>
  apiFetch<{ authorizeUrl: string; stateExpiresInSeconds: number }>(`/api/connectors/${encodeURIComponent(id)}/oauth/start`, body({ method: 'oauth2' }));

/**
 * Store credentials SERVER-SIDE. The response is the connector WITHOUT any
 * secret values (only presence info) — the client never round-trips tokens.
 * v1.0.13 §5 — the UI can also declare the EFFECTIVE auth method
 * (none | bearer | token_pair | oauth2) with the same request.
 */
export const setConnectorCredentials = (id: string, values: Record<string, string>, authMethod?: 'none' | 'bearer' | 'token_pair' | 'oauth2') =>
  apiFetch<ConnectorDTO>(`/api/connectors/${encodeURIComponent(id)}/credentials`, { method: 'PUT', body: JSON.stringify({ values, ...(authMethod ? { authMethod } : {}) }) });

export const clearConnectorCredentials = (id: string) =>
  apiFetch<ConnectorDTO>(`/api/connectors/${encodeURIComponent(id)}/credentials`, { method: 'DELETE' });

export const discoverConnectorTools = (id: string) =>
  apiFetch<{
    connected: boolean;
    tools: DiscoveredToolDTO[];
    resources?: DiscoveredResourceDTO[];
    resourceTemplates?: DiscoveredResourceTemplateDTO[];
    prompts?: DiscoveredPromptDTO[];
    serverInfo?: DiscoveredServerInfoDTO | null;
  }>(`/api/connectors/${encodeURIComponent(id)}/tools`);

export const importConnectorTools = (id: string, names: string[]) =>
  apiFetch<ImportResultDTO>(`/api/connectors/${encodeURIComponent(id)}/tools`, body({ action: 'import', names }));

export const refreshConnectorTools = (id: string, names?: string[]) =>
  apiFetch<RefreshResultDTO>(`/api/connectors/${encodeURIComponent(id)}/tools`, body({ action: 'refresh', ...(names?.length ? { names } : {}) }));

export const toggleImportedTool = (id: string, name: string, enabled: boolean) =>
  apiFetch<ImportedToolDTO>(`/api/connectors/${encodeURIComponent(id)}/tools`, body({ action: 'toggle', name, enabled }));

export const removeImportedTool = (id: string, name: string) =>
  apiFetch<{ removed: true; name: string }>(`/api/connectors/${encodeURIComponent(id)}/tools`, body({ action: 'remove', name }));
