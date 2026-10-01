/**
 * NexTool Q1 v1.0.0 — BINDING REST API contract (backend implements, frontend consumes)
 * All endpoints return ApiEnvelope<T> = { ok: true, data: T } | { ok: false, error: { code, message } }
 * All request/response bodies are JSON.
 */
import type {
  TaskSummary, TaskConfig, MainState, PlanStep, FinalResult,
  ToolDefinition, ToolStats,
} from './types';

// NOTE: response DTOs (frontend may rely on these exact shapes)

export interface TaskDetail extends TaskSummary {
  config: TaskConfig;
  state: MainState;
  plan: PlanStep[];
  finalResult?: FinalResult;
  error?: { code: string; message: string; stage: string } | null;
  sessionId?: string;
}

export interface ToolEntry {
  name: string;
  description: string;
  purpose?: string;
  category: string;
  environment: 'builtin' | 'virtual-env' | 'dynamic';
  schema: ToolDefinition['schema'];
  handlerKind?: string;
  enabled: boolean;
  stats: ToolStats;
}

export interface MemoryEntryDTO {
  id: string;
  key: string;
  value: unknown;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntryDTO {
  id: string;
  taskId?: string;
  action: string;
  params?: unknown;
  result?: unknown;
  status: string;
  timestamp: string;
}

export interface NotificationDTO {
  id: string;
  title: string;
  body: string;
  source: string;
  taskId?: string;
  level: 'info' | 'warning' | 'critical';
  read: boolean;
  createdAt: string;
}

export interface GeneratedImageDTO {
  id: string;
  path: string;
  prompt: string;
  size?: string;
  taskId?: string;
  createdAt: string;
}

/* ======================= ENDPOINTS =======================

GET  /api/system                       -> SystemStats
GET  /api/state                        -> GlobalLiveState  (+ servers, runtime status, active counts)
POST /api/env/event  { type:"server.crash"|"server.degrade"|"server.recover", serverId? } -> GlobalLiveState

GET  /api/tasks?status=&mode=&limit=   -> TaskSummary[]
POST /api/tasks { request, config? }   -> TaskDetail   (starts async execution)
GET  /api/tasks/:id                    -> TaskDetail
POST /api/tasks/:id/stop               -> TaskDetail   (cancels goal/live task + active execution)
POST /api/tasks/:id/event { type, payload? } -> NexToolEvent   (inject runtime event; wakes live mode)
POST /api/tasks/:id/feedback { message, correctAction? } -> NexToolEvent (user correction event)
GET  /api/tasks/:id/events?since=&limit= -> NexToolEvent[]
GET  /api/tasks/:id/context            -> ContextComposition
GET  /api/tasks/:id/executions         -> ToolExecution[] (this task's tool calls w/ results)

GET  /api/stream?taskId=&since=        -> SSE  (event: "event" data: NexToolEvent; event: "hello" data:{ok:true}; heartbeat comments every 15s)

GET  /api/tools                        -> ToolEntry[]
POST /api/tools/register { definition: ToolDefinition, handlerKind?, handlerConfig? } -> ToolEntry
POST /api/tools/:name/toggle { enabled } -> ToolEntry

GET  /api/memory                       -> MemoryEntryDTO[]
POST /api/memory { key, value, tags?, source? } -> MemoryEntryDTO
DELETE /api/memory?key=                -> { deleted: true }

GET  /api/history?taskId=&limit=       -> HistoryEntryDTO[]

GET  /api/notifications?limit=         -> NotificationDTO[]
POST /api/notifications/read-all       -> { ok: true }

GET  /api/images?limit=                -> GeneratedImageDTO[]

GET  /api/models                       -> { engine: ActiveEngineInfo, packages: ModelPackageInfo[], adapters: { tfjs: false, nextoolManifest: true, parquet: false } }
POST /api/models/load { manifest }     -> ModelPackageInfo  (validates .nextool JSON manifest: name, version, format:"nextool", architecture, compatibility — rejects invalid with 400)

GET  /api/datasets                     -> DatasetInfo[]
POST /api/datasets/import              -> DatasetInfo  (DatasetImportPayload; computes train/val/test split counts)
GET  /api/datasets/:id/export?format=json -> { dataset: DatasetInfo, examples: DatasetExample[] }
DELETE /api/datasets/:id               -> { deleted: true }

GET  /api/settings                     -> NexToolSettings
PUT  /api/settings { partial settings } -> NexToolSettings

======================= SSE protocol =======================

GET /api/stream (text/event-stream)
- on connect: event: hello, data: {"ok":true,"since":...}
- then replays events with createdAt > since (if provided) as event: event data: NexToolEvent JSON
- live events are pushed in real-time as they occur in the runtime
- comment heartbeat ":keepalive" every 15s
- optional query: taskId to filter, since (ISO string or ms) to replay history

============================================================ */
export {}
