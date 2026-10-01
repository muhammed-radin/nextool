/**
 * NexTool Q1 v1.0.0 — Core domain types (BINDING contract for backend + frontend)
 * Spec: /home/z/my-project/upload/Pasted Content_1790827341994.txt
 */

// ---------- Tool System ----------

export type ToolParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface ToolParamDef {
  name: string;
  type: ToolParamType;
  required: boolean;
  description: string;
  /** extractive = pull directly from request; constructive = generate/enrich */
  generation?: 'extractive' | 'constructive';
  enumValues?: string[];
  min?: number;
  max?: number;
  default?: unknown;
}

export interface ToolSchema {
  type: 'object';
  properties: ToolParamDef[];
}

export type ToolEnvironment = 'builtin' | 'virtual-env' | 'dynamic';

export interface ToolDefinition {
  name: string; // e.g. "server.health"
  description: string;
  purpose?: string;
  category: string; // e.g. "monitoring" | "automation" | "content" | "utility" | "memory" | "notification"
  environment: ToolEnvironment;
  schema: ToolSchema;
  /** dynamic tools only */
  handlerKind?: 'echo' | 'delay' | 'http_get' | 'uuid';
  handlerConfig?: Record<string, unknown>;
}

export interface ToolStats {
  callCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  avgMs: number;
  enabled: boolean;
}

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface ToolExecution {
  executionId: string;
  tool: string;
  status: ExecutionStatus;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string } | null;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

// ---------- CoreModule ----------

export type CoreModuleStatus = 'tool_call' | 'no_tool' | 'clarification_required' | 'cannot_execute' | 'stop';

export interface CoreModuleCandidate {
  tool: string;
  score: number;
}

export interface CoreModuleOutput {
  status: CoreModuleStatus;
  tool?: string;
  params?: Record<string, unknown>;
  confidence: number; // 0..1
  reason: string; // concise operational explanation (NO chain-of-thought)
  missing?: string[]; // missing required params when clarification_required
  candidates?: CoreModuleCandidate[];
  /** which engine produced the decision: llm-core | heuristic-fallback */
  engine: 'llm-core' | 'heuristic-fallback';
  latencyMs: number;
}

// ---------- Planning / State ----------

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
  kind: 'action' | 'observation' | 'verification';
  /** steps with the same non-empty group can run in parallel (spec §10) */
  parallelGroup?: number;
}

export interface Subgoal {
  id: string;
  title: string;
  reason: string;
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
}

export interface MainState {
  request: string;
  goal: string;
  mode: 'goal' | 'live';
  plan: PlanStep[];
  currentStepId?: string;
  activeSubgoal?: Subgoal;
  subgoals: Subgoal[];
  previousActions: { action: string; status: string; at: string }[];
  observations: { at: string; message: string }[];
  iterationCount: number;
  toolCallCount: number;
  lastObservation?: string;
  terminationStatus?: 'completed' | 'failed' | 'stopped' | 'cancelled' | 'limit_reached' | null;
  errorState?: { code: string; message: string; stage: string } | null;
}

// ---------- Task ----------

export type TaskMode = 'goal' | 'live';
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'cancelled';

export interface TaskConfig {
  name?: string;
  mode: TaskMode; // default goal — NEVER auto-switched to live
  reasoningLevel: 1 | 2 | 3 | 4 | 5 | 6;
  enabledTools?: string[]; // empty/undefined = all enabled tools
  useMemory?: boolean;
  learnFrom?: { feedback?: boolean; results?: boolean };
  autoExecuteSubtools?: boolean;
  maxSubtoolCalls?: number; // default 20
  safetyLimit?: number; // default 100
  maxIterations?: number; // default 30 (goal mode)
  taskTimeoutMs?: number; // default 120000
  toolTimeoutMs?: number; // default 30000
  liveIntervalMs?: number; // live mode scheduled tick interval, default 60000
  sessionId?: string;
  context?: Record<string, unknown>;
}

export interface TaskSummary {
  id: string;
  name?: string;
  request: string;
  goal?: string;
  mode: TaskMode;
  reasoningLevel: number;
  status: TaskStatus;
  statusDetail?: string;
  steps: number;
  toolCalls: number;
  durationMs?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface FinalResult {
  status: 'completed' | 'failed' | 'stopped' | 'cancelled' | 'limit_reached';
  goal: string;
  result?: unknown;
  steps: number;
  toolCalls: number;
  durationMs: number;
}

// ---------- Events ----------

export type EventSource = 'runtime' | 'planner' | 'observer' | 'core' | 'tool' | 'environment' | 'user' | 'system';

export interface NexToolEvent {
  id: string;
  taskId?: string;
  type: string;
  source: EventSource;
  message: string;
  data?: Record<string, unknown>;
  priority: number; // 1 emergency .. 9 scheduled tick
  createdAt: string;
}

// ---------- Live State / Environment ----------

export interface VirtualServer {
  id: string;
  health: 'healthy' | 'unhealthy' | 'degraded' | 'restarting';
  cpu: number;
  memory: number;
  uptimeSec: number;
  lastCheckAt?: string;
}

export interface GlobalLiveState {
  servers: VirtualServer[];
  runtimeStatus: 'online' | 'degraded' | 'offline';
  activeGoalTasks: number;
  activeLiveTasks: number;
  startedAt: string;
}

// ---------- Context (Live Mode composition) ----------

export interface ContextComposition {
  previousContext: Record<string, unknown>;
  delta: Record<string, unknown>;
  observation: Record<string, unknown> | null;
  memory: Record<string, unknown>[];
  history: Record<string, unknown>[];
  assembledAt: string;
}

// ---------- Notifications ----------

export interface NotificationRecord {
  id: string;
  title: string;
  body: string;
  source: string;
  taskId?: string;
  level: 'info' | 'warning' | 'critical';
  read: boolean;
  createdAt: string;
}

// ---------- API envelope ----------

export interface ApiError {
  code: string;
  message: string;
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// ---------- REST DTOs ----------
// Canonical definitions live in api-contract.ts (BINDING contract). Re-exported
// here so frontend and runtime share ONE import surface (v1.0.1 §47).
export type {
  TaskDetail,
  ToolEntry,
  MemoryEntryDTO,
  HistoryEntryDTO,
  NotificationDTO,
  GeneratedImageDTO,
} from './api-contract';

// ---------- System (Dashboard) ----------

export interface SystemStats {
  /** Application release version (package.json / version.ts). */
  appVersion: string;
  runtimeStatus: 'online' | 'degraded' | 'offline';
  runtimeUptimeSec: number;
  engine: {
    active: string; // "llm-core"
    fallback: string; // "heuristic-fallback"
    version: string; // CoreModule model version (unchanged since 1.0.0)
    coreCalls: number;
    avgCoreLatencyMs: number;
    lastDecisionAt?: string;
  };
  /** Version of the most recently updated dataset, if any. */
  datasetVersion: string | null;
  tasks: {
    total: number;
    active: number;
    live: number;
    completed: number;
    failed: number;
    successRate: number; // 0..1 over finished tasks
  };
  toolCalls: {
    total: number;
    success: number;
    failed: number;
    avgMs: number;
  };
  eventCount: number;
  memoryEntries: number;
  process: {
    heapUsedMb: number;
    rssMb: number;
    nodeVersion: string;
    platform: string;
  };
  latencySeries: { at: string; ms: number }[]; // recent core decisions
}

// ---------- Models ----------

export interface ActiveEngineInfo {
  name: string;
  version: string;
  architecture: string;
  backend: string;
  status: 'active';
  coreCalls: number;
  avgLatencyMs: number;
  lastDecisionAt?: string;
  notes: string;
}

export interface ModelPackageInfo {
  id: string;
  name: string;
  version: string;
  format: string;
  status: 'registered' | 'active' | 'rejected';
  sizeBytes?: number;
  note?: string;
  createdAt: string;
  manifest: Record<string, unknown>;
}

// ---------- Datasets ----------

export interface DatasetInfo {
  id: string;
  name: string;
  version: string;
  format: 'json' | 'parquet';
  trainSize: number;
  valSize: number;
  testSize: number;
  categories?: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetImportPayload {
  name: string;
  version: string;
  /** array of examples: { category, request, expectedTool?, expectedParams?, split? } */
  examples: DatasetExample[];
  note?: string;
}

export interface DatasetExample {
  category: string;
  request: string;
  expectedTool?: string;
  expectedParams?: Record<string, unknown>;
  split?: 'train' | 'validation' | 'test';
}

// ---------- Settings ----------

export interface NexToolSettings {
  defaultMode: TaskMode; // goal
  defaultReasoningLevel: 1 | 2 | 3 | 4 | 5 | 6;
  maxSubtoolCalls: number;
  safetyLimit: number;
  maxIterations: number;
  taskTimeoutMs: number;
  toolTimeoutMs: number;
  liveIntervalMs: number;
  useMemory: boolean;
  logLevel: 'info' | 'debug' | 'error';
  realTimeTransport: 'sse'; // websocket adapter not installed in this environment (honest state)
}
