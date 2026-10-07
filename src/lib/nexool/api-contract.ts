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
  /** v1.0.12 Phase 7 — combined custom task instructions (uploaded Markdown +
   * textarea), stored verbatim with the task and returned on read. Null when
   * the task carries no custom instructions. */
  instructions?: string | null;
}

export interface ToolEntry {
  name: string;
  description: string;
  purpose?: string;
  category: string;
  // v1.0.12 — 'mcp' joins the set: tools imported from a connected MCP server
  // (connector-backed; managed from the Connectors page, not the Tool IDE).
  environment: 'builtin' | 'virtual-env' | 'dynamic' | 'js-function' | 'nodejs' | 'freedom-node' | 'mcp';
  schema: ToolDefinition['schema'];
  handlerKind?: string;
  /** v1.0.5: dynamic handler configuration object (http_get url/timeout, …). */
  handlerConfig?: Record<string, unknown>;
  /** v1.0.2: JavaScript function source for js-function tools. */
  functionSource?: string;
  /** v1.0.2: user-facing tool version string. */
  toolVersion?: string;
  /** v1.0.5: user metadata key/value pairs (from the stored definition). */
  metadata?: Record<string, string>;
  /** v1.0.6 §9.2: per-tool auto-execute policy (default false = approval required). */
  autoExecute?: boolean;
  /** v1.0.13: verification latch — completed executions wait for operator verification. */
  verificationLatch?: boolean;
  /** v1.0.7 §1: tool-specific execution timeout (ms) — overrides the global
   *  default; the runtime caps at 1 hour. Undefined = use global default. */
  timeoutMs?: number;
  /** v1.0.12: mcp tools only — connector + remote tool identity (NO secrets). */
  mcp?: ToolDefinition['mcp'];
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
POST /api/tasks { request, config? }   -> TaskDetail   (starts async execution; config may include parallelToolCalls + maxParallelToolCalls — v1.0.3)
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
GET  /api/tools/:name                  -> ToolEntry (full definition incl. functionSource)
POST /api/tools/js { name, schema, functionSource, ... } -> ToolEntry   (v1.0.2 Tool IDE save)
PUT  /api/tools/:name { partial tool } -> ToolEntry                   (v1.0.2 edit; built-ins read-only)
DELETE /api/tools/:name               -> { deleted: true }           (v1.0.2; built-ins rejected)
POST /api/tools/test { name | functionSource, params? } -> { mode, status, durationMs, result, error, logs }  (v1.0.2)

POST /api/training { datasetId, config? }        -> TrainingJobSummary (v1.0.2; real TF.js run starts async)
GET  /api/training                               -> TrainingJobSummary[]
GET  /api/training/:id                           -> TrainingJobDetail (metrics series + logs)
DELETE /api/training/:id                         -> { cancelled } | { deleted }

POST /api/benchmark { modelKey, datasetId, suite, limit? } -> BenchmarkRunSummary (v1.0.2; synchronous real run)
GET  /api/benchmark                              -> BenchmarkRunSummary[]
GET  /api/benchmark/:id                          -> BenchmarkRunDetail (per-case results)

GET  /api/models/export?id=&format=tfjs|nextool  -> zip download (v1.0.2)
POST /api/models/import (multipart file)         -> ImportModelResult (v1.0.2)

GET  /api/icons                                  -> { manifest, active } (v1.0.2 branding)
POST /api/icons (multipart file=icons.zip)       -> { packageId, manifest, accepted, rejected }
PATCH /api/icons { action:"activate", packageId } -> BrandingManifest
DELETE /api/icons                                -> { discarded }

GET  /api/memory                       -> MemoryEntryDTO[]
POST /api/memory { key, value, tags?, source? } -> MemoryEntryDTO
DELETE /api/memory?key=                -> { deleted: true }

GET  /api/history?taskId=&limit=       -> HistoryEntryDTO[]

GET  /api/notifications?limit=         -> NotificationDTO[]
POST /api/notifications/read-all       -> { ok: true }

GET  /api/images?limit=                -> GeneratedImageDTO[]

GET  /api/models                       -> { engine: ActiveEngineInfo, packages: ModelPackageInfo[], adapters: { tfjs: true, nextoolManifest: true, parquet: true } }
POST /api/models/load { manifest }     -> ModelPackageInfo  (validates .nextool JSON manifest: name, version, format:"nextool", architecture, compatibility — rejects invalid with 400)

GET  /api/datasets                     -> DatasetInfo[]
POST /api/datasets/import              -> DatasetInfo  (JSON body OR multipart file=.parquet/.json — v1.0.3; computes train/val/test split counts)
GET  /api/datasets/:id/export?format=json|parquet -> { dataset, examples } | binary .parquet download (v1.0.3)
DELETE /api/datasets/:id               -> { deleted: true }

GET  /api/settings                     -> NexToolSettings
PUT  /api/settings { partial settings } -> NexToolSettings

GET  /api/connectors                              -> { registryVersion, providers: McpProviderDTO[], connectors: ConnectorDTO[] }   (v1.0.12)
POST /api/connectors { providerId, name?, config? } -> ConnectorDTO                                                                (v1.0.12)
GET  /api/connectors/:id                          -> ConnectorDTO (REAL status; credential PRESENCE only — never values)           (v1.0.12)
PATCH /api/connectors/:id { name?, config?, enabled? } -> ConnectorDTO                                                              (v1.0.12)
DELETE /api/connectors/:id                        -> { deleted, id, removedTools } (remote MCP server untouched)                    (v1.0.12)
POST /api/connectors/:id/connection { action: connect|disconnect|reconnect } -> ConnectorDTO                                      (v1.0.12)
PUT  /api/connectors/:id/credentials { values }   -> ConnectorDTO (values stored SERVER-SIDE ONLY)                                 (v1.0.12)
DELETE /api/connectors/:id/credentials           -> ConnectorDTO                                                                  (v1.0.12)
GET  /api/connectors/:id/tools                    -> { connected, tools: DiscoveredToolDTO[] } (live discovery; 409 when offline)  (v1.0.12)
POST /api/connectors/:id/tools { action: import|refresh|toggle|remove, ... } -> ImportResult | RefreshResult | ImportedToolDTO | { removed } (v1.0.12)

======================= SSE protocol =======================

GET /api/stream (text/event-stream)
- on connect: event: hello, data: {"ok":true,"since":...}
- then replays events with createdAt > since (if provided) as event: event data: NexToolEvent JSON
- live events are pushed in real-time as they occur in the runtime
- comment heartbeat ":keepalive" every 15s
- optional query: taskId to filter, since (ISO string or ms) to replay history

============================================================ */
export {}
