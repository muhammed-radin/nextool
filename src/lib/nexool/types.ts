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
  /** v1.0.12 — FULL original JSON Schema for imported MCP tool params.
   *  Preserves nested objects, array items, formats and any other JSON Schema
   *  keyword that has no first-class NexTool slot (spec §1.13: never throw
   *  schema information away). Ignored by runtimes that do not know it. */
  jsonSchema?: Record<string, unknown>;
}

export interface ToolSchema {
  type: 'object';
  properties: ToolParamDef[];
}

/**
 * v1.0.5 — `nodejs` joins the environment set: a RESTRICTED Node.js sandbox
 * (node:vm + module allowlist — no process/fs/net/child_process). See
 * tools/node-runner.ts for the actual runtime contract.
 * v1.0.6 — the nodejs environment gains the Virtual FS, controlled
 * http/https, a virtual child_process layer and the common safe APIs
 * (fetch/XHR/alert/prompt); js-function gains the same common APIs.
 * v1.0.12 — `mcp` joins the environment set: tools IMPORTED from a connected
 * MCP (Model Context Protocol) server. An mcp tool has NO local code — its
 * handler proxies the call through the owning connector to the remote MCP
 * server (see mcp/connector-manager.ts + tools/mcp-runner.ts). mcp tools are
 * NOT authorable in the Tool IDE and NOT exportable (connector-backed —
 * the definition must never travel without its server).
 */
export type ToolEnvironment = 'builtin' | 'virtual-env' | 'dynamic' | 'js-function' | 'nodejs' | 'freedom-node' | 'mcp';

/** v1.0.12 — reference block carried INSIDE the stored definition JSON of
 *  every environment='mcp' tool. Contains connector/tool identity ONLY —
 *  NEVER tokens or secrets (spec §1.14: credentials are resolved through the
 *  connector at execution time, server-side). */
export interface McpToolRef {
  connectorId: string;
  providerId: string;
  mcpToolName: string;
  /** Provider display name, denormalized for display only. */
  serverName: string;
  /** sha256-stable hash of the remote inputSchema at import/refresh time. */
  remoteHash?: string;
  importedAt?: string;
  lastRefreshedAt?: string;
  /** Set when the user edited the description locally — Refresh tools keeps
   *  the local text instead of silently overwriting it (spec §1.16). */
  customizedDescription?: boolean;
  /** The remote schema at import/refresh time, kept for diffing. */
  remoteInputSchema?: unknown;
}

/** v1.0.12 — REAL connector connection states (never faked; spec §1.8).
 *  `auth_required` = credentials missing (per the provider's auth type) or
 *  the server rejected them. `disconnected` = user-initiated. Reconciliation
 *  against live in-memory clients happens on every read. */
export type McpConnectorStatus =
  | 'not_connected'
  | 'connecting'
  | 'auth_required'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting';

/** Environments a developer may author tools for in the Tool IDE (v1.0.5 §2.3).
 *  v1.0.11 — `freedom-node` joins the authorable set: an INTENTIONALLY
 *  UNRESTRICTED environment with real host Node.js capabilities (real fs,
 *  network, child processes, process). Gated server-side by the central
 *  `fs` configuration section — fail closed. */
export const AUTHORABLE_ENVIRONMENTS = ['js-function', 'nodejs', 'dynamic', 'freedom-node'] as const;
export type AuthorableEnvironment = (typeof AUTHORABLE_ENVIRONMENTS)[number];

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
  /** js-function tools only (v1.0.2) — mirrors ToolRecord.functionSource */
  functionSource?: string;
  /** js-function tools only (v1.0.2) — free-form user-facing tool version */
  toolVersion?: string;
  /** v1.0.5 — arbitrary user metadata as structured string key/value pairs.
   *  Lives inside the stored definition JSON; round-trips through
   *  create/edit/save/test/duplicate/export/import. */
  metadata?: Record<string, string>;
  /** v1.0.6 §9 — execute automatically inside tasks (default FALSE: tools
   *  require explicit user approval unless a global/task setting overrides).
   *  v1.0.11 resolution precedence (resolveAutoExecution): global setting →
   *  per-tool config → per-task config → default OFF. undefined = inherit
   *  (the tool does not force an explicit decision). */
  autoExecute?: boolean;
  /** v1.0.7 §1 — tool-specific execution timeout in ms (optional). Overrides
   *  the global default; the runtime still caps every value at 1 hour
   *  (3600000 ms). Default when unset: global toolTimeoutMs (10000 ms). */
  timeoutMs?: number;
  /** v1.0.9 §14 — tool-specific Network Policy request timeout (optional).
   *  Overrides the global networkRequestTimeoutMs for THIS tool's individual
   *  network requests; still bounded by the central network.timeoutMs limits
   *  and never beyond the tool's own effective execution timeout. */
  networkTimeoutMs?: number;
  /** v1.0.12 — mcp tools only: connector + remote tool reference. Identity
   *  only — NEVER credentials (they resolve through the connector). */
  mcp?: McpToolRef;
  /** v1.0.13 — VERIFICATION LATCH: when true, a COMPLETED execution of this
   *  tool is held open until the operator verifies the result in the console.
   *  Verify → completes normally; Reject → structured VERIFICATION_REJECTED
   *  failure; timeout (5 min) → auto-verified with a warning event (the
   *  latch is a review gate, deliberately NOT a security gate). Subtool and
   *  test executions never latch. Default: false. */
  verificationLatch?: boolean;
}

// ---------- Tool execution approval (v1.0.6 §9) ----------

export interface PendingApproval {
  approvalId: string;
  tool: string;
  params: Record<string, unknown>;
  purpose?: string;
  reason?: string;
  /** Current subgoal title when the approval was raised from a subgoal. */
  subgoal?: string;
  requestedAt: string;
}

// ---------- Live event queue (v1.0.6 §10) ----------

export interface QueuedLiveEvent {
  /** Monotonic per-task sequence — deterministic ordering (§10.4). */
  seq: number;
  eventId: string;
  type: string;
  message: string;
  priority: number;
  queuedAt: string;
  status: 'queued' | 'processing' | 'processed' | 'dropped';
  data?: Record<string, unknown>;
}

export interface ToolStats {
  callCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  avgMs: number;
  enabled: boolean;
}

/** v1.0.9 §15.2/§15.6 — 'stopped' joins the canonical execution statuses:
 *  a task stopped while a tool is active records the execution as stopped.
 *  Task Preview maps every value 1:1 (running → Running, timeout → Timed out,
 *  stopped → Stopped, …) via ExecutionStatusBadge — never a hard-coded
 *  running state. */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'stopped';

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
  /** v1.0.3: set when this call ran inside a parallel batch (Task Preview groups these). */
  batchId?: string;
  /** v1.0.3: planner parallelGroup the call belonged to. */
  parallelGroup?: number;
  /** v1.0.7 §1: the EFFECTIVE execution timeout enforced for this call (ms) —
   *  resolved from tool-specific config → global default, capped at 1 hour. */
  timeoutMs?: number;
  /** v1.0.9 §14: the EFFECTIVE Network Policy request timeout applied to
   *  each individual network request of this execution (ms) — resolved from
   *  request override → tool → task → global Settings → shipped default. */
  networkTimeoutMs?: number;
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
  /** v1.0.6 §9 — approval currently blocking execution (awaiting_approval). */
  pendingApproval?: PendingApproval | null;
  /** v1.0.6 §10 — live event queue (multi-event mode). Persisted with the
   *  state so queued events survive UI refresh/reconnect (§10.5). */
  eventQueue?: QueuedLiveEvent[];
  /** v1.0.6 — seq of the event currently being processed (queue UI). */
  currentEventSeq?: number;
  /** v1.0.6 §11 — paused flag mirrored from the task status column. */
  paused?: boolean;
  /** v1.0.11 — pre-plan recovery state machine snapshot (Task Preview).
   *  Present while a recovery subgoal is active, after a resume (status
   *  'resumed', kept for observability) and after exhaustion. */
  recovery?: TaskRecoveryState;
}

/** v1.0.11 — recovery of a FAILED pre-plan step. The main plan is frozen
 *  while recovery runs; the recovery subgoal carries its OWN pre-plan. */
export interface TaskRecoveryState {
  /** 'recovering' = the main plan is paused, a recovery attempt is executing;
   *  'resumed' = recovery succeeded, the main plan continues;
   *  'exhausted' = all attempts failed, the task ends honestly. */
  status: 'recovering' | 'resumed' | 'exhausted';
  /** Human-readable failure the recovery addresses (bounded). */
  reason: string;
  failedStepId?: string;
  failedStepTitle?: string;
  attempt: number;
  maxAttempts: number;
  subgoalId?: string;
  /** The recovery attempt's own pre-planned steps (PlanStep reuse). */
  steps: PlanStep[];
  startedAt: string;
  updatedAt: string;
  /** Set when status = 'resumed' — how the main plan continued. */
  resumeNote?: string;
}

// ---------- Task ----------

export type TaskMode = 'goal' | 'live';
/** v1.0.6 §15 — `awaiting_approval` and `paused` join the runtime states. */
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'awaiting_approval' | 'paused' | 'completed' | 'failed' | 'stopped' | 'cancelled';

/** v1.0.10 §2 — planner strategies.
 *  - 'pre-plan': the existing complete-plan planner (plans several steps up
 *    front, executes them in order, stops early when the goal is achieved).
 *  - 'one-by-one': plans exactly ONE next step, executes it, observes the
 *    result, verifies the goal, then plans the next step from the updated
 *    state. Never generates a hidden future list. */
export type PlannerType = 'pre-plan' | 'one-by-one';

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
  /** v1.0.7 — task-level tool execution timeout default (tool-specific
   *  ToolDefinition.timeoutMs still overrides this). Default 10000, max 1 h. */
  toolTimeoutMs?: number; // default 10000
  /** v1.0.9 §14 — task-level Network Policy request timeout (optional).
   *  Precedence: request → tool → THIS → global Settings → shipped default. */
  networkTimeoutMs?: number;
  liveIntervalMs?: number; // live mode scheduled tick interval, default 60000
  /** v1.0.3: explicit parallel tool execution policy (default true — independent
   *  plan steps sharing a parallelGroup may execute concurrently). */
  parallelToolCalls?: boolean;
  /** v1.0.3: hard cap on concurrently executing tool calls (default 4, max 8). */
  maxParallelToolCalls?: number;
  /** v1.0.6 §13 — task-level auto-execute override (undefined = use global
   *  setting first, then per-tool config). Separate from parallelToolCalls:
   *  parallel tools run one plan cycle concurrently; this decides whether a
   *  tool needs user approval before executing at all. */
  autoExecuteTools?: boolean;
  /** v1.0.6 §13 — accept multiple simultaneous live events into a queue and
   *  process them one-by-one (undefined = use the global setting, default
   *  false = single-event mode). Separate concern from parallelToolCalls. */
  allowMultipleEvents?: boolean;
  /** v1.0.10 §13 — per-task planner override. Resolution precedence:
   *  task plannerType → global default (Settings) → 'pre-plan'. Resolved and
   *  persisted at task creation so a later Settings change never switches the
   *  strategy of an existing task. */
  plannerType?: PlannerType;
  /** v1.0.10 §16/§18 — pre-plan step limit for THIS task (1..122). Relevant
   *  to pre-plan planning only; one-by-one planning always generates exactly
   *  one step per call. Default = the global Settings value (default 10). */
  prePlanMaxSteps?: number;
  /** v1.0.11 — per-task cap on recovery attempts per failed pre-plan step
   *  (2..4, default = the global Settings value, default 4). One attempt =
   *  observe failure → recovery subgoal → recovery pre-plan → execute →
   *  verify. Pre-plan planner only; one-by-one replans by design. */
  recoveryMaxAttempts?: number;
  /** v1.0.13 — per-task cap on SAFETY-LIMIT CONTINUATIONS (0..5, default 1;
   *  0 disables the continuation question). When the goal loop hits
   *  maxIterations/safetyLimit the runtime ASKS the operator instead of
   *  failing: continue → both limits grow by limitContinuationExtra and the
   *  task proceeds; deny/timeout → terminal exactly as before. */
  limitContinuations?: number;
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
  /** v1.0.7 §1 — global/default tool execution timeout. Default 10000 ms
   *  (10 s); values up to 3600000 ms (1 h) may be configured; the API rejects
   *  anything above and the runtime clamps as defense in depth. Tool-specific
   *  ToolDefinition.timeoutMs overrides this per tool. */
  toolTimeoutMs: number;
  /** v1.0.9 §14 — Global Network Policy: the timeout applied to EACH
   *  individual network request made inside a tool (fetch/XHR/virtual
   *  http(s)/URL imports/npm). Deliberately SEPARATE from toolTimeoutMs —
   *  neither setting overwrites the other. Default 60000 ms (60 s); bounds
   *  resolved from the central network.timeoutMs metadata (shipped
   *  1 s … 1 h). Precedence: request override → tool policy → task policy →
   *  this global setting → shipped default. */
  networkRequestTimeoutMs: number;
  liveIntervalMs: number;
  useMemory: boolean;
  /** v1.0.3: runtime default for the explicit parallel tool call policy. */
  parallelToolCalls: boolean;
  /** v1.0.3: runtime default cap for concurrently executing tool calls. */
  maxParallelToolCalls: number;
  /** v1.0.6 §9.3 — global Auto-Execute Tools override (default false).
   *  true → every tool executes without approval; false/unset → per-task
   *  config, then per-tool autoExecute (default false). */
  autoExecuteTools: boolean;
  /** v1.0.6 §10 — "Allow Multiple Events at Same Time" / "Read & Act All
   *  Events" (same configuration, two labels). Default false: single-event
   *  mode preserved. */
  allowMultipleEvents: boolean;
  logLevel: 'info' | 'debug' | 'error';
  realTimeTransport: 'sse'; // websocket adapter not installed in this environment (honest state)
  /** v1.0.10 §12.1 — global default planner strategy for NEW tasks (tasks may
   *  override per task). Default 'pre-plan' keeps existing behavior. */
  defaultPlannerType: PlannerType;
  /** v1.0.10 §16 — global default pre-plan maximum steps (default 10,
   *  hard maximum 122 via the central task.prePlanMaxSteps limits). */
  prePlanMaxSteps: number;
  /** v1.0.11 — global default cap on recovery attempts per failed pre-plan
   *  step (2..4 via the central task.recoveryMaxAttempts limits, default 4). */
  recoveryMaxAttempts: number;
  /** v1.0.13 — safety-limit continuation policy: when true (default), the
   *  goal loop ASKS the operator for a continuation instead of failing at
   *  maxIterations/safetyLimit (per-task limitContinuations caps still apply
   *  and 0 disables per task). */
  safetyLimitContinuation: boolean;
  /** v1.0.13 — budget granted to BOTH maxIterations and safetyLimit per
   *  granted continuation (1..500 via the central task.limitContinuationExtra
   *  limits, default 25). */
  safetyLimitContinuationExtra: number;
}

// ---------- Training (v1.0.2) ----------

export interface TrainingConfig {
  epochs: number; // 1..100
  batchSize: number; // 1..128
  learningRate: number; // 0.0001..1
  validationSplit: number; // 0..0.5 (fraction of examples held out)
  shuffle: boolean;
  earlyStoppingPatience?: number; // 0 = disabled
  vocabSize?: number; // hashed bag-of-words dimension (default 128)
  /** v1.0.10 §29 — semantic model version for the produced checkpoint
   *  (e.g. '1.0.1'). When absent the legacy tc-<job> version is kept. */
  modelVersion?: string;
}

export interface TrainingEpochMetrics {
  at: string;
  epoch: number;
  loss: number;
  valLoss: number | null;
  accuracy: number;
  valAccuracy: number | null;
  elapsedMs: number;
}

export interface TrainingLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type TrainingJobStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TrainingJobSummary {
  id: string;
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  status: TrainingJobStatus;
  config: TrainingConfig;
  epochs: number;
  epochsDone: number;
  error?: string | null;
  modelRecordId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface TrainingJobDetail extends TrainingJobSummary {
  metrics: TrainingEpochMetrics[];
  logs: TrainingLogLine[];
  finalMetrics?: {
    loss: number;
    valLoss: number | null;
    accuracy: number;
    valAccuracy: number | null;
    trainMs: number;
  } | null;
}

// ---------- Benchmark (v1.0.2) ----------

export type BenchmarkModelKey = string; // 'llm-core' | 'heuristic-fallback' | trained model id

export interface BenchmarkConfig {
  modelKey: BenchmarkModelKey;
  datasetId: string;
  suite: 'tool-selection'; // suite actually implemented by the engine
  limit?: number; // max test examples to run (default: all test-split examples)
  timeoutPerCaseMs?: number;
}

export interface BenchmarkMetrics {
  /** Examples actually evaluated (skipped examples excluded). */
  cases: number;
  toolSelectionAccuracy: number; // 0..1 — decision tool matches expectedTool
  noToolRate: number; // fraction of cases where CoreModule decided no_tool/cannot_execute
  paramAccuracy: number | null; // 0..1 — strict match of expectedParams (null when no expectedParams present)
  schemaValidity: number; // fraction of tool_call decisions whose params pass schema validation
  avgDecisionLatencyMs: number;
  p95DecisionLatencyMs: number;
  avgConfidence: number;
  avgCoreCallsPerCase: number; // always 1 decision per case (documented)
}

export interface BenchmarkCaseResult {
  request: string;
  expectedTool?: string;
  decidedTool?: string;
  status: 'tool_call' | 'no_tool' | 'clarification_required' | 'cannot_execute' | 'stop';
  correct: boolean;
  confidence: number;
  latencyMs: number;
  engine: string;
}

export interface BenchmarkRunSummary {
  id: string;
  label?: string | null;
  modelKey: BenchmarkModelKey;
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  metrics: BenchmarkMetrics;
  durationMs: number;
  error?: string | null;
  createdAt: string;
}

export interface BenchmarkRunDetail extends BenchmarkRunSummary {
  config: BenchmarkConfig;
  cases: BenchmarkCaseResult[];
}

// ---------- Model packages (v1.0.2) ----------

export interface ExportedModelMetadata {
  packageName: string;
  applicationVersion: string;
  modelVersion: string;
  architecture: string;
  parameterCount: number;
  datasetVersion: string | null;
  createdAt: string;
  tfjsCompatibility: string; // tfjs version the topology was produced with
  packageFormat: 'tfjs-zip' | 'nextool';
  notes?: string;
}

// ---------- Branding / icons (v1.0.2) ----------

export interface IconAsset {
  /** File name inside the icons package, e.g. "icon-192.png". */
  file: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface BrandingManifest {
  status: 'staged' | 'active';
  uploadedAt: string;
  activatedAt?: string | null;
  assets: IconAsset[];
  favicon: string | null; // favicon.ico file name
  appleTouch: string | null;
  p512: string | null;
  p192: string | null;
}
