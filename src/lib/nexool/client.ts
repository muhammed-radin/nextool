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
}

export const getModels = () => apiFetch<ModelsInfo>('/api/models');

export const loadModel = (payload: { manifest: Record<string, unknown> }) =>
  apiFetch<ModelPackageInfo>('/api/models/load', body(payload));

// ---------- Datasets ----------

export const listDatasets = () => apiFetch<DatasetInfo[]>('/api/datasets');

export const importDataset = (payload: DatasetImportPayload) =>
  apiFetch<DatasetInfo>('/api/datasets/import', body(payload));

export const exportDatasetUrl = (id: string) =>
  `/api/datasets/${encodeURIComponent(id)}/export?format=json`;

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
