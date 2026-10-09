/**
 * NexTool v1.0.8 — THE central configuration-limit loader (spec §7).
 *
 *   config/configuration-limits.json   (the ONE authoritative limits file)
 *        ↓
 *   Limit Loader (this module — fs read + mtime cache + hot reload)
 *        ↓
 *   Limit Validator (schema + type + nullable + min<=default<=max)
 *        ↓
 *   Typed Resolved Limits  ──→  Settings · Backend · Runtime
 *
 * Every configurable limit in the application originates here:
 * network policy, Virtual FS limits, execution limits, child-process limits
 * and the task/settings clamps. NO subsystem may keep its own hard-coded
 * copy (spec §9/§24). A self-hosted administrator customizes limits by
 * editing the single JSON file — never TypeScript source (spec §7.9).
 *
 * Reload semantics (spec §12): the loader caches the parsed file and
 * re-validates it when the file mtime changes (checked at most once per
 * 2 s) — a changed file is picked up WITHOUT a rebuild; an application
 * restart always loads the current file. Invalid files fail CLEARLY with
 * a ConfigurationLimitsError that names the property and the problem —
 * the application never silently falls back to hard-coded values.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------- types ----------

export type LimitType = 'integer' | 'number' | 'boolean' | 'string' | 'enum' | 'array';

/** Metadata for ONE configurable property (spec §7.2/§7.3). */
export interface LimitProperty {
  type: LimitType;
  /** true → the value may be null. Each nullable property documents what null means. */
  nullable?: boolean;
  /** The shipped default (also the fallback when a settings value is absent). */
  default: unknown;
  /** Minimum allowed value (numeric types). */
  min?: number;
  /** Maximum allowed value (numeric types). */
  max?: number;
  /** Unit label shown in the UI and docs ("ms", "bytes", "count", "chars", "lines", "levels"). */
  unit?: string;
  /** What the property governs — rendered by the Settings UI. */
  description?: string;
  /** UI stepper increment. */
  step?: number;
  /** Allowed values for type "enum". */
  enum?: string[];
  /** For type "array": the item type ("string" today). Defaults to "string". */
  items?: 'string';
  /** Grouping hint ("network" | "vfs" | "execution" | "child-process" | "task"). */
  category?: string;
  /** Optional grouping marker for future migrations. */
  deprecated?: boolean;
  /** true → a change needs an application restart to apply. */
  requiresRestart?: boolean;
}

/** One section of the limits file (network / vfs / execution / childProcess / task …). */
export type LimitSection = Record<string, LimitProperty>;

export interface ConfigurationLimits {
  version: number;
  $meta?: {
    name?: string;
    description?: string;
    notes?: string[];
  };
  [section: string]: unknown;
}

/** Well-known sections consumed by typed helpers below. */
export interface ResolvedRuntimeLimits {
  version: number;
  network: {
    timeoutMs: number;
    maxResponseBytes: number;
    maxRedirects: number;
    maxRequestsPerExecution: number;
    allowUrlImports: boolean;
    /** v1.0.91 — relative fetch URLs resolve against the application origin. */
    selfOriginAccess: boolean;
  };
  vfs: {
    maxFileBytes: number;
    maxTotalBytes: number;
    maxEntries: number;
    maxDepth: number;
    maxPathLength: number;
  };
  execution: {
    timeoutMs: number;
    syncTimeoutMs: number;
    heapSentinelBytes: number;
    maxSourceChars: number;
    maxResultBytes: number;
    maxLogs: number;
    maxLogLineChars: number;
  };
  childProcess: {
    timeoutMs: number;
    maxOutputBytes: number;
    maxProcessesPerExecution: number;
    maxPipeStages: number;
    maxArgs: number;
    npmMaxPackages: number;
  };
  task: {
    maxIterations: number;
    maxSubtoolCalls: number;
    safetyLimit: number;
    taskTimeoutMs: number;
    toolTimeoutMs: number;
    liveIntervalMs: number;
    maxParallelToolCalls: number;
    eventQueueCap: number;
    /** v1.0.10 — pre-plan planner maximum steps (default 10, hard max 122). */
    prePlanMaxSteps: number;
    /** v1.0.11 — maximum recovery attempts per failed pre-plan step
     *  (default 4, allowed range 2..4). */
    recoveryMaxAttempts: number;
  };
  /** v1.1.0 — CoreModule LLM deadline + live-output buffering.
   *  `llmTimeoutMs === null` means NO application-level CoreModule timeout:
   *  the call runs until the provider itself answers or fails. */
  coreModule: {
    llmTimeoutMs: number | null;
    liveOutputBufferBytes: number;
  };
  /** v1.1.0 — Planner/Observer LLM deadlines (null = unlimited), separate
   *  from the CoreModule timeout, the task timeout and tool timeouts. */
  planner: {
    llmTimeoutMs: number | null;
    verifyTimeoutMs: number | null;
    recoveryMaxPlanSteps: number;
  };
  /** v1.1.0 — inspector terminal session limits. */
  terminal: {
    maxSessions: number;
    execTimeoutMs: number | null;
    maxOutputBytes: number;
    historyLimit: number;
  };
  /** v1.1.0 — VFS shell command policy. `allowedCommands === null` means
   *  every IMPLEMENTED VFS-shell command is permitted; an array restricts
   *  the shell to exactly those commands. This is a CAP list, never a path
   *  out of the VFS root — confinement stays enforced in code. */
  vfsTerminal: {
    allowedCommands: string[] | null;
  };
  /** v1.1.0 — Skills progressive-loading caps. */
  skills: {
    maxLoadedPerTask: number;
    maxInstructionChars: number;
    maxResourceBytes: number;
    maxZipBytes: number;
  };
  /** v1.1.0 — event bus retention + payload caps. */
  events: {
    recentRingSize: number;
    maxDataBytes: number;
  };
  /** v1.1.0 — Continue Task / fork-from-recent context seeding caps. */
  continuity: {
    maxContextChars: number;
    maxExecutionRows: number;
    maxObservations: number;
  };
  /** v1.0.11 — freedom-node escape gate (vfs vs fs semantics).
   *  `fs` governs the UNRESTRICTED freedom-node filesystem mode; the separate
   *  `vfs` section above governs the RESTRICTED virtual filesystem used by
   *  js-function/nodejs tools. The Settings UI deliberately exposes NO
   *  control for this section — it is configuration-file only (fail closed). */
  fs: {
    /** true → freedom-node executions are authorized at all. false → the
     *  runtime FAILS CLOSED: freedom-node executions are rejected. */
    enabled: boolean;
    /** false (default) → freedom-node uses the REAL host filesystem and is
     *  never redirected into the restricted tool VFS. true would re-enable
     *  restrictions for the freedom-node filesystem mode. */
    restricted: boolean;
  };
}

export class ConfigurationLimitsError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(
      `configuration-limits.json is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n- ${issues.join('\n- ')}`,
    );
    this.name = 'ConfigurationLimitsError';
    this.issues = issues;
  }
}

// ---------- loader with mtime cache + hot reload (§12) ----------

const RECHECK_MS = 2_000;

interface LimitsCache {
  path: string;
  statMtimeMs: number;
  statSize: number;
  checkedAt: number;
  raw: ConfigurationLimits;
}

const g = globalThis as unknown as {
  __nextoolLimitsCache?: LimitsCache;
  __nextoolLimitsOverridePath?: string;
};

function limitsFilePath(): string {
  return (
    process.env.NEXTOOL_LIMITS_FILE
    ?? g.__nextoolLimitsOverridePath
    ?? path.join(process.cwd(), 'config', 'configuration-limits.json')
  );
}

/** Point the loader at a different limits file (used by the dynamic-limit test). */
export function setConfigurationLimitsPath(p: string | undefined): void {
  g.__nextoolLimitsOverridePath = p;
  g.__nextoolLimitsCache = undefined;
}

/** Drop the cached file — the next access re-reads and re-validates. */
export function invalidateConfigurationLimitsCache(): void {
  g.__nextoolLimitsCache = undefined;
}

function readAndValidate(): LimitsCache {
  const filePath = limitsFilePath();
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigurationLimitsError([
      `cannot read the limits file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigurationLimitsError([`invalid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const issues = validateLimitsObject(raw);
  if (issues.length > 0) throw new ConfigurationLimitsError(issues);
  const stat = fs.statSync(filePath);
  return { path: filePath, statMtimeMs: stat.mtimeMs, statSize: stat.size, checkedAt: Date.now(), raw: raw as ConfigurationLimits };
}

/**
 * Load + validate the central limits (cached; re-validated when the file
 * changes on disk, checked at most once per 2 s). Throws a CLEAR
 * ConfigurationLimitsError when the file is missing/invalid — never a
 * silent hard-coded fallback (spec §7.7).
 */
export function getConfigurationLimits(): ConfigurationLimits {
  const cached = g.__nextoolLimitsCache;
  if (cached && Date.now() - cached.checkedAt < RECHECK_MS) return cached.raw;
  if (cached) {
    try {
      const stat = fs.statSync(cached.path);
      if (stat.mtimeMs === cached.statMtimeMs && stat.size === cached.statSize) {
        cached.checkedAt = Date.now();
        return cached.raw;
      }
    } catch {
      // file disappeared → fall through to a full reload which reports clearly
    }
  }
  const fresh = readAndValidate();
  g.__nextoolLimitsCache = fresh;
  return fresh.raw;
}

/**
 * Typed snapshot of the limits the runtime consumes. Every number here is
 * the validated `default` of the corresponding property — subsystems clamp
 * their *configured* values with the min/max of the same metadata.
 */
export function getResolvedLimits(): ResolvedRuntimeLimits {
  const raw = getConfigurationLimits();
  const num = (section: string, key: string): number => {
    const prop = (raw[section] as LimitSection | undefined)?.[key];
    if (!prop || typeof prop.default !== 'number') {
      throw new ConfigurationLimitsError([`missing numeric property ${section}.${key}`]);
    }
    return prop.default;
  };
  const bool = (section: string, key: string): boolean => {
    const prop = (raw[section] as LimitSection | undefined)?.[key];
    if (!prop || typeof prop.default !== 'boolean') {
      throw new ConfigurationLimitsError([`missing boolean property ${section}.${key}`]);
    }
    return prop.default;
  };
  /** nullable numeric — a validated null default is returned as null (unlimited). */
  const numOrNull = (section: string, key: string): number | null => {
    const prop = (raw[section] as LimitSection | undefined)?.[key];
    if (!prop) throw new ConfigurationLimitsError([`missing property ${section}.${key}`]);
    if (prop.default === null) {
      if (!prop.nullable) throw new ConfigurationLimitsError([`${section}.${key}: null default requires nullable: true`]);
      return null;
    }
    if (typeof prop.default !== 'number') {
      throw new ConfigurationLimitsError([`missing numeric property ${section}.${key}`]);
    }
    return prop.default;
  };
  /** nullable string-array — null means "unrestricted" for list caps. */
  const strArray = (section: string, key: string): string[] | null => {
    const prop = (raw[section] as LimitSection | undefined)?.[key];
    if (!prop) throw new ConfigurationLimitsError([`missing property ${section}.${key}`]);
    if (prop.default === null) {
      if (!prop.nullable) throw new ConfigurationLimitsError([`${section}.${key}: null default requires nullable: true`]);
      return null;
    }
    if (!Array.isArray(prop.default) || !prop.default.every((v) => typeof v === 'string')) {
      throw new ConfigurationLimitsError([`${section}.${key}: default must be an array of strings or null`]);
    }
    return prop.default as string[];
  };
  return {
    version: raw.version as number,
    network: {
      timeoutMs: num('network', 'timeoutMs'),
      maxResponseBytes: num('network', 'maxResponseBytes'),
      maxRedirects: num('network', 'maxRedirects'),
      maxRequestsPerExecution: num('network', 'maxRequestsPerExecution'),
      allowUrlImports: bool('network', 'allowUrlImports'),
      selfOriginAccess: bool('network', 'selfOriginAccess'),
    },
    vfs: {
      maxFileBytes: num('vfs', 'maxFileBytes'),
      maxTotalBytes: num('vfs', 'maxTotalBytes'),
      maxEntries: num('vfs', 'maxEntries'),
      maxDepth: num('vfs', 'maxDepth'),
      maxPathLength: num('vfs', 'maxPathLength'),
    },
    execution: {
      timeoutMs: num('execution', 'timeoutMs'),
      syncTimeoutMs: num('execution', 'syncTimeoutMs'),
      heapSentinelBytes: num('execution', 'heapSentinelBytes'),
      maxSourceChars: num('execution', 'maxSourceChars'),
      maxResultBytes: num('execution', 'maxResultBytes'),
      maxLogs: num('execution', 'maxLogs'),
      maxLogLineChars: num('execution', 'maxLogLineChars'),
    },
    childProcess: {
      timeoutMs: num('childProcess', 'timeoutMs'),
      maxOutputBytes: num('childProcess', 'maxOutputBytes'),
      maxProcessesPerExecution: num('childProcess', 'maxProcessesPerExecution'),
      maxPipeStages: num('childProcess', 'maxPipeStages'),
      maxArgs: num('childProcess', 'maxArgs'),
      npmMaxPackages: num('childProcess', 'npmMaxPackages'),
    },
    task: {
      maxIterations: num('task', 'maxIterations'),
      maxSubtoolCalls: num('task', 'maxSubtoolCalls'),
      safetyLimit: num('task', 'safetyLimit'),
      taskTimeoutMs: num('task', 'taskTimeoutMs'),
      toolTimeoutMs: num('task', 'toolTimeoutMs'),
      liveIntervalMs: num('task', 'liveIntervalMs'),
      maxParallelToolCalls: num('task', 'maxParallelToolCalls'),
      eventQueueCap: num('task', 'eventQueueCap'),
      prePlanMaxSteps: num('task', 'prePlanMaxSteps'),
      recoveryMaxAttempts: num('task', 'recoveryMaxAttempts'),
    },
    coreModule: {
      llmTimeoutMs: numOrNull('coreModule', 'llmTimeoutMs'),
      liveOutputBufferBytes: num('coreModule', 'liveOutputBufferBytes'),
    },
    planner: {
      llmTimeoutMs: numOrNull('planner', 'llmTimeoutMs'),
      verifyTimeoutMs: numOrNull('planner', 'verifyTimeoutMs'),
      recoveryMaxPlanSteps: num('planner', 'recoveryMaxPlanSteps'),
    },
    terminal: {
      maxSessions: num('terminal', 'maxSessions'),
      execTimeoutMs: numOrNull('terminal', 'execTimeoutMs'),
      maxOutputBytes: num('terminal', 'maxOutputBytes'),
      historyLimit: num('terminal', 'historyLimit'),
    },
    vfsTerminal: {
      allowedCommands: strArray('vfsTerminal', 'allowedCommands'),
    },
    skills: {
      maxLoadedPerTask: num('skills', 'maxLoadedPerTask'),
      maxInstructionChars: num('skills', 'maxInstructionChars'),
      maxResourceBytes: num('skills', 'maxResourceBytes'),
      maxZipBytes: num('skills', 'maxZipBytes'),
    },
    events: {
      recentRingSize: num('events', 'recentRingSize'),
      maxDataBytes: num('events', 'maxDataBytes'),
    },
    continuity: {
      maxContextChars: num('continuity', 'maxContextChars'),
      maxExecutionRows: num('continuity', 'maxExecutionRows'),
      maxObservations: num('continuity', 'maxObservations'),
    },
    fs: {
      enabled: bool('fs', 'enabled'),
      restricted: bool('fs', 'restricted'),
    },
  };
}

/**
 * v1.0.11 — the authoritative freedom-node escape gate, read SERVER-SIDE
 * from the central configuration file at every execution. There is no API,
 * no Settings control and no frontend path that can flip this — a
 * self-hosted administrator edits config/configuration-limits.json.
 * Fail closed: when the file cannot be read, freedom-node is NOT authorized.
 */
export function getFreedomFsConfig(): { enabled: boolean; restricted: boolean } {
  try {
    return getResolvedLimits().fs;
  } catch {
    return { enabled: false, restricted: true };
  }
}

/** Resolve ONE property's metadata (throws when the path does not exist). */
export function getLimitProperty(section: string, key: string): LimitProperty {
  const raw = getConfigurationLimits();
  const prop = (raw[section] as LimitSection | undefined)?.[key];
  if (!prop) {
    throw new ConfigurationLimitsError([`unknown configuration property "${section}.${key}"`]);
  }
  return prop;
}

/**
 * Clamp a configured value into a property's [min, max] — the shared
 * runtime-side enforcement used by settings updates, task config and the
 * sandbox layers (spec §8.5: backend and runtime agree on the same limits).
 */
export function clampToLimit(section: string, key: string, value: unknown): number {
  const prop = getLimitProperty(section, key);
  const n = Number(value);
  const min = prop.min ?? -Number.MAX_SAFE_INTEGER;
  const max = prop.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(n)) return prop.default as number;
  return Math.min(Math.max(Math.round(n), min), max);
}

// ---------- validation (§7.7/§7.8/§22) ----------

const VALID_TYPES: LimitType[] = ['integer', 'number', 'boolean', 'string', 'enum', 'array'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the parsed limits object. Returns a list of issues (empty = valid):
 *  - JSON parse errors and non-object roots
 *  - unknown/missing type, invalid nullable
 *  - numeric: missing default, min/max ordering, min <= default <= max
 *  - boolean: default must be boolean
 *  - enum: default must be one of the enum values
 */
export function validateLimitsObject(raw: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    return ['root must be a JSON object'];
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    issues.push('version must be a positive integer (got ' + JSON.stringify(raw.version) + ')');
  }
  for (const [section, value] of Object.entries(raw)) {
    if (section === 'version' || section === '$meta') continue;
    if (!isPlainObject(value)) {
      issues.push(`section "${section}" must be an object of properties`);
      continue;
    }
    for (const [key, prop] of Object.entries(value)) {
      const path = `${section}.${key}`;
      if (!isPlainObject(prop)) {
        issues.push(`${path}: property metadata must be an object`);
        continue;
      }
      const type = prop.type;
      if (typeof type !== 'string' || !VALID_TYPES.includes(type as LimitType)) {
        issues.push(`${path}: type must be one of ${VALID_TYPES.join(' | ')} (got ${JSON.stringify(type)})`);
        continue;
      }
      if (prop.nullable !== undefined && typeof prop.nullable !== 'boolean') {
        issues.push(`${path}: nullable must be a boolean when present`);
      }
      if ('default' in prop === false || prop.default === undefined) {
        issues.push(`${path}: default is required`);
        continue;
      }
      if (type === 'integer' || type === 'number') {
        const d = prop.default;
        if (d === null) {
          // nullable numeric — null is a documented "unlimited" value
          if (!prop.nullable) {
            issues.push(`${path}: null default requires nullable: true`);
          }
          continue;
        }
        if (typeof d !== 'number' || !Number.isFinite(d)) {
          issues.push(`${path}: default must be a finite number (got ${JSON.stringify(d)})`);
          continue;
        }
        if (type === 'integer' && !Number.isInteger(d)) {
          issues.push(`${path}: default must be an integer for type "integer" (got ${d})`);
        }
        const min = prop.min;
        const max = prop.max;
        if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
          issues.push(`${path}: min must be a finite number`);
        }
        if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
          issues.push(`${path}: max must be a finite number`);
        }
        if (typeof min === 'number' && typeof max === 'number' && min > max) {
          issues.push(`${path}: min (${min}) must be <= max (${max})`);
        }
        if (typeof min === 'number' && d < min) {
          issues.push(`${path}: default (${d}) must be >= min (${min})`);
        }
        if (typeof max === 'number' && d > max) {
          issues.push(`${path}: default (${d}) must be <= max (${max})`);
        }
      } else if (type === 'array') {
        const d = prop.default;
        if (d === null) {
          if (!prop.nullable) {
            issues.push(`${path}: null default requires nullable: true`);
          }
        } else if (!Array.isArray(d)) {
          issues.push(`${path}: default must be an array (or null when nullable)`);
        } else if ((prop.items ?? 'string') !== 'string') {
          issues.push(`${path}: items must be "string"`);
        } else if (!d.every((v) => typeof v === 'string')) {
          issues.push(`${path}: every array item must be a string`);
        }
      } else if (type === 'boolean') {
        if (typeof prop.default !== 'boolean') {
          issues.push(`${path}: default must be a boolean (got ${JSON.stringify(prop.default)})`);
        }
      } else if (type === 'enum') {
        const values = prop.enum;
        if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) {
          issues.push(`${path}: enum requires a non-empty array of string values`);
        } else if (!values.includes(String(prop.default))) {
          issues.push(`${path}: default (${JSON.stringify(prop.default)}) must be one of ${values.join(' | ')}`);
        }
      } else if (type === 'string') {
        if (typeof prop.default !== 'string') {
          issues.push(`${path}: default must be a string (got ${JSON.stringify(prop.default)})`);
        }
      }
    }
  }
  return issues;
}
