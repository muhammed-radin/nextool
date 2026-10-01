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
}

export const createTask = (payload: CreateTaskPayload) =>
  apiFetch<TaskDetail>('/api/tasks', body(payload));

export const getTaskDetail = (id: string) => apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);

export const stopTask = (id: string) =>
  apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}/stop`, body({}));

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
  schema: ToolDefinition['schema'];
  functionSource: string;
  enabled?: boolean;
}

export const registerJsTool = (payload: JsToolPayload) =>
  apiFetch<ToolEntry>('/api/tools/js', body(payload));

export const getTool = (name: string) =>
  apiFetch<ToolEntry>(`/api/tools/${encodeURIComponent(name)}`);

export const updateTool = (name: string, payload: Partial<JsToolPayload> & { enabled?: boolean; renameTo?: string }) => {
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

export const testTool = (payload: { name?: string; functionSource?: string; params?: Record<string, unknown> }) =>
  apiFetch<ToolTestResult>('/api/tools/test', body(payload));

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

export interface ModelsInfo {
  engine: ActiveEngineInfo;
  packages: ModelPackageInfo[];
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
