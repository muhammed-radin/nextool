/**
 * NexTool Q1 v1.0.10 test suite — Major Planner Architecture + AI Training
 * Upgrade.
 *
 * Covers the v1.0.10 acceptance criteria:
 *   §2-§11  one-by-one planner: exactly ONE step per call, multi-step outputs
 *           sanitized (extra steps discarded), deterministic fallback, latest
 *           state context, planner strategy resolution precedence
 *   §12-§20 planner configuration: global default, per-task override,
 *           prePlanMaxSteps central limits (default 10, max 122), server-side
 *           validation, backward compatibility
 *   §16     pre-plan max steps now configurable (was hard-coded 8)
 *   §32-§39 pattern learning: structured pattern extraction, evidence-based
 *           confidence (single event → low confidence), repetition strengthens,
 *           contradictions weaken, pattern → training-example conversion
 *   §29     trained model version support (1.0.1 semantic version)
 *   §47-§53 deterministic parts of the planner/training/pattern tests
 *
 * Run: bun test tests/nextool-v1010.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  resolvePlannerType,
  sanitizeOneStepResponse,
  sanitizeSingleStep,
  buildOneByOneFallbackStep,
  buildOneByOneContext,
} from '../src/lib/nexool/main/planner-strategy';
import { DEFAULT_PRE_PLAN_MAX_STEPS } from '../src/lib/nexool/main/planner';
import {
  deriveConfidence,
  patternsToDatasetExamples,
  PATTERN_EXAMPLE_MIN_CONFIDENCE,
} from '../src/lib/nexool/patterns/extractor';
import { getConfigurationLimits, clampToLimit, validateLimitsObject } from '../src/lib/nexool/config-limits';
import { resolveTrainingConfig } from '../src/lib/nexool/training/engine';
import {
  taskConfigSchema,
  settingsSchema,
  createTaskSchema,
  trainingConfigSchema,
} from '../src/lib/nexool/schemas';
import type { PlanStep, Subgoal } from '../src/lib/nexool/types';
import seedDataset from '../config/training/seed-dataset-v1.0.1.json';

// ===========================================================================
// §12/§13 — planner strategy resolution precedence
// ===========================================================================

describe('v1.0.10 §13 — planner strategy resolution precedence', () => {
  test('task override beats the global default', () => {
    expect(resolvePlannerType('one-by-one', 'pre-plan')).toBe('one-by-one');
    expect(resolvePlannerType('pre-plan', 'one-by-one')).toBe('pre-plan');
  });

  test('missing task value falls back to the global default', () => {
    expect(resolvePlannerType(undefined, 'one-by-one')).toBe('one-by-one');
    expect(resolvePlannerType(undefined, 'pre-plan')).toBe('pre-plan');
  });

  test('fallback is pre-plan when neither task nor global default is set (§13)', () => {
    expect(resolvePlannerType(undefined, undefined)).toBe('pre-plan');
  });

  test('invalid values never win — garbage falls back to pre-plan', () => {
    expect(resolvePlannerType('agentic' as never, 'pre-plan')).toBe('pre-plan');
    expect(resolvePlannerType('agentic' as never, undefined)).toBe('pre-plan');
  });
});

// ===========================================================================
// §6 — the one-by-one step contract: EXACTLY ONE step
// ===========================================================================

describe('v1.0.10 §6 — one-by-one single-step contract', () => {
  test('a proper single-step object is accepted', () => {
    const out = sanitizeOneStepResponse({
      title: 'Check API health',
      detail: 'Query api-01 health status before taking another action.',
      kind: 'action',
    }, 0);
    expect(out).not.toBeNull();
    expect(out!.step.title).toBe('Check API health');
    expect(out!.step.kind).toBe('action');
    expect(out!.step.id).toBe('step_1');
    expect(out!.discarded).toBe(0);
  });

  test('a multi-step response is COLLAPSED to exactly one step (rest discarded)', () => {
    const out = sanitizeOneStepResponse({
      steps: [
        { title: 'Check API health', kind: 'action' },
        { title: 'Inspect CPU', kind: 'action' },
        { title: 'Inspect memory', kind: 'action' },
      ],
    }, 0);
    expect(out).not.toBeNull();
    expect(out!.step.title).toBe('Check API health');
    expect(out!.discarded).toBe(2);
  });

  test('a raw array response also collapses to one step', () => {
    const out = sanitizeOneStepResponse([
      { title: 'First valid step' },
      { title: 'Second step that must be discarded' },
    ], 0);
    expect(out).not.toBeNull();
    expect(out!.step.title).toBe('First valid step');
    expect(out!.discarded).toBe(1);
  });

  test('{"step": {...}} wrapper form is accepted', () => {
    const out = sanitizeOneByOneWrapper();
    expect(out).not.toBeNull();
    expect(out!.step.title).toBe('Wrapped step');
  });

  function sanitizeOneByOneWrapper() {
    return sanitizeOneStepResponse({ step: { title: 'Wrapped step', kind: 'verification' } }, 0);
  }

  test('empty/garbage output yields no step (caller uses the fallback)', () => {
    expect(sanitizeOneStepResponse({}, 0)).toBeNull();
    expect(sanitizeOneStepResponse({ steps: [{ detail: 'no title' }] }, 0)).toBeNull();
    expect(sanitizeOneStepResponse(null, 0)).toBeNull();
    expect(sanitizeOneStepResponse('not json', 0)).toBeNull();
  });

  test('kind is coerced into the allowed enum; titles are trimmed and capped', () => {
    const step = sanitizeSingleStep({ title: '  x '.repeat(80), kind: 'nonsense' }, 0);
    expect(step).not.toBeNull();
    expect(step!.kind).toBe('action');
    expect(step!.title.length).toBeLessThanOrEqual(200);
    expect(step!.title.startsWith('x')).toBe(true);
  });

  test('step ids follow the sequence position passed in (step_N+1)', () => {
    const step = sanitizeSingleStep({ title: 'Next step' }, 3);
    expect(step!.id).toBe('step_4');
  });
});

// ===========================================================================
// §43 — deterministic fallback: ONE valid immediate step, never zero
// ===========================================================================

describe('v1.0.10 §43 — one-by-one deterministic fallback', () => {
  const state = {
    plan: [] as PlanStep[],
    subgoals: [] as Subgoal[],
    previousActions: [],
    observations: [],
    iterationCount: 0,
    toolCallCount: 0,
  };

  test('without observations: fulfill-request fallback step', () => {
    const ctx = buildOneByOneContext({ request: 'Check api-01 health', goal: 'Check api-01 health', taskMode: 'goal', reasoningLevel: 3, state });
    const step = buildOneByOneFallbackStep(ctx, 0);
    expect(step.title).toContain('Fulfill request');
    expect(step.status).toBe('pending');
    expect(step.kind).toBe('action');
  });

  test('with a last observation: fallback references the latest state (§5)', () => {
    const ctx = buildOneByOneContext({
      request: 'Check api-01 health',
      goal: 'Check api-01 health',
      taskMode: 'goal',
      reasoningLevel: 3,
      state: { ...state, lastObservation: 'Server api-01 health: unhealthy (cpu 91%)' },
    });
    const step = buildOneByOneFallbackStep(ctx, 1);
    expect(step.id).toBe('step_2');
    expect(step.detail).toContain('unhealthy');
  });

  test('after a failure: fallback NEVER blindly repeats — it references the failure (§10)', () => {
    const ctx = buildOneByOneContext({
      request: 'Restart the service',
      goal: 'Restart the service',
      taskMode: 'goal',
      reasoningLevel: 3,
      state: { ...state, lastObservation: 'Execution failed' },
      knownFailures: ['server.restart: permission denied (failed)'],
    });
    const step = buildOneByOneFallbackStep(ctx, 2);
    expect(step.detail).toContain('permission denied');
    expect(step.title.toLowerCase()).not.toContain('restart the service');
  });
});

// ===========================================================================
// §16/§17 — pre-plan max steps: configurable, default 10, hard max 122
// ===========================================================================

describe('v1.0.10 §16/§17 — configuration-limits task.prePlanMaxSteps', () => {
  test('the central limits file defines task.prePlanMaxSteps {default 10, min 1, max 122}', () => {
    const limits = getConfigurationLimits();
    const section = limits.task as Record<string, { type?: string; default?: number; min?: number; max?: number }>;
    const prop = section.prePlanMaxSteps;
    expect(prop).toBeDefined();
    expect(prop.default).toBe(10);
    expect(prop.min).toBe(1);
    expect(prop.max).toBe(122);
    expect(prop.type).toBe('integer');
  });

  test('clamping enforces 1..122 (§16/§19)', () => {
    expect(clampToLimit('task', 'prePlanMaxSteps', 0)).toBe(1);
    expect(clampToLimit('task', 'prePlanMaxSteps', 123)).toBe(122);
    expect(clampToLimit('task', 'prePlanMaxSteps', 25)).toBe(25);
    expect(clampToLimit('task', 'prePlanMaxSteps', 10)).toBe(10);
  });

  test('the shipped default is 10 (NOT the old hard-coded 8)', () => {
    expect(DEFAULT_PRE_PLAN_MAX_STEPS).toBe(10);
  });

  test('the limits file itself stays valid', () => {
    expect(validateLimitsObject(JSON.parse(JSON.stringify(getConfigurationLimits())))).toEqual([]);
  });
});

// ===========================================================================
// §19/§20/§53 — server-side validation + backward compatibility
// ===========================================================================

describe('v1.0.10 §19 — server-side task config validation', () => {
  test('plannerType accepts pre-plan and one-by-one', () => {
    expect(taskConfigSchema.safeParse({ plannerType: 'pre-plan' }).success).toBe(true);
    expect(taskConfigSchema.safeParse({ plannerType: 'one-by-one' }).success).toBe(true);
  });

  test('plannerType rejects unknown strategies (§19)', () => {
    expect(taskConfigSchema.safeParse({ plannerType: 'agentic' }).success).toBe(false);
    expect(taskConfigSchema.safeParse({ plannerType: '' }).success).toBe(false);
    expect(taskConfigSchema.safeParse({ plannerType: 42 }).success).toBe(false);
  });

  test('prePlanMaxSteps accepts 1 and 122, rejects 0 and 123 (§19)', () => {
    expect(taskConfigSchema.safeParse({ prePlanMaxSteps: 1 }).success).toBe(true);
    expect(taskConfigSchema.safeParse({ prePlanMaxSteps: 122 }).success).toBe(true);
    expect(taskConfigSchema.safeParse({ prePlanMaxSteps: 50 }).success).toBe(true);
    expect(taskConfigSchema.safeParse({ prePlanMaxSteps: 0 }).success).toBe(false);
    expect(taskConfigSchema.safeParse({ prePlanMaxSteps: 123 }).success).toBe(false);
    expect(taskConfigSchema.safeParse({ prePlanMaxSteps: 1.5 }).success).toBe(false);
  });

  test('legacy configs WITHOUT planner fields still validate (§20/§53 backward compat)', () => {
    const legacy = { mode: 'goal', reasoningLevel: 4, enabledTools: ['echo.echo'] };
    expect(taskConfigSchema.safeParse(legacy).success).toBe(true);
    expect(createTaskSchema.safeParse({ request: 'Do the thing', config: legacy }).success).toBe(true);
    expect(createTaskSchema.safeParse({ request: 'Do the thing' }).success).toBe(true);
  });

  test('full v1.0.10 task config validates end-to-end (§18 example)', () => {
    const cfg = { plannerType: 'pre-plan', prePlanMaxSteps: 25, mode: 'goal', reasoningLevel: 3 };
    expect(taskConfigSchema.safeParse(cfg).success).toBe(true);
  });
});

describe('v1.0.10 §12.1 — global settings validation', () => {
  test('defaultPlannerType accepts the two strategies and rejects others', () => {
    expect(settingsSchema.safeParse({ defaultPlannerType: 'one-by-one' }).success).toBe(true);
    expect(settingsSchema.safeParse({ defaultPlannerType: 'pre-plan' }).success).toBe(true);
    expect(settingsSchema.safeParse({ defaultPlannerType: 'hybrid' }).success).toBe(false);
  });

  test('prePlanMaxSteps settings bounds mirror the central limits', () => {
    expect(settingsSchema.safeParse({ prePlanMaxSteps: 10 }).success).toBe(true);
    expect(settingsSchema.safeParse({ prePlanMaxSteps: 122 }).success).toBe(true);
    expect(settingsSchema.safeParse({ prePlanMaxSteps: 123 }).success).toBe(false);
    expect(settingsSchema.safeParse({ prePlanMaxSteps: 0 }).success).toBe(false);
  });
});

// ===========================================================================
// §32-§36 — pattern learning: structure, quality, fitting safeguards
// ===========================================================================

describe('v1.0.10 §36 — pattern confidence is evidence-based', () => {
  test('a single accidental event can NEVER become high-confidence knowledge', () => {
    const c = deriveConfidence(1, 0, 0);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(1 / 3 + 0.001); // evidence caps at 1/3 for one observation
    expect(c).toBeLessThan(PATTERN_EXAMPLE_MIN_CONFIDENCE);
  });

  test('repetition strengthens a consistent pattern (§36)', () => {
    const once = deriveConfidence(1, 0, 0);
    const thrice = deriveConfidence(3, 0, 0);
    const tenTimes = deriveConfidence(10, 0, 0);
    expect(thrice).toBeGreaterThan(once);
    expect(tenTimes).toBeGreaterThanOrEqual(thrice);
    expect(tenTimes).toBeLessThanOrEqual(1);
  });

  test('contradictions weaken a pattern (§36: weaker when contradicted)', () => {
    const strong = deriveConfidence(6, 0, 0);
    const contradicted = deriveConfidence(6, 0, 2);
    expect(contradicted).toBeLessThan(strong);
  });

  test('failures lower the success-rate component', () => {
    expect(deriveConfidence(3, 3, 0)).toBeLessThan(deriveConfidence(3, 0, 0));
  });

  test('no evidence → zero confidence (never invent knowledge)', () => {
    expect(deriveConfidence(0, 0, 0)).toBe(0);
  });
});

describe('v1.0.10 §37/§52 — patterns are additional evidence, not mandatory', () => {
  test('low-confidence patterns are never converted into training examples', () => {
    const examples = patternsToDatasetExamples([
      { signature: 'early-completion:echo.echo', patternType: 'early-completion', actionTool: 'echo.echo', confidence: 0.33, successCount: 1, failureCount: 0, sourceRequest: 'run the echo verification' },
    ]);
    expect(examples).toEqual([]);
  });

  test('reliable single-action patterns convert into dataset examples', () => {
    const examples = patternsToDatasetExamples([
      { signature: 'early-completion:server.health', patternType: 'early-completion', actionTool: 'server.health', confidence: 0.8, successCount: 5, failureCount: 0, sourceRequest: 'check whether api-01 is healthy' },
      { signature: 'outcome:unhealthy-detected->restart', patternType: 'outcome', actionTool: 'server.restart', confidence: 0.7, successCount: 4, failureCount: 0, sourceRequest: 'recover the unhealthy production api' },
    ]);
    expect(examples.length).toBe(2);
    expect(examples[0]).toEqual({ category: 'pattern-learned', request: 'check whether api-01 is healthy', expectedTool: 'server.health', split: 'train' });
  });

  test('multi-tool transitions are NOT converted (would fabricate request→tool semantics)', () => {
    const examples = patternsToDatasetExamples([
      { signature: 'sequence:server.health->server.restart', patternType: 'sequence', actionTool: 'server.restart', confidence: 0.9, successCount: 9, failureCount: 0, sourceRequest: 'recover api-01' },
      { signature: 'failure-recovery:server.restart->server.health', patternType: 'failure-recovery', actionTool: 'server.health', confidence: 0.9, successCount: 9, failureCount: 0, sourceRequest: 'recover api-01' },
    ]);
    expect(examples).toEqual([]);
  });

  test('patterns without a source request never convert', () => {
    const examples = patternsToDatasetExamples([
      { signature: 'early-completion:time.now', patternType: 'early-completion', actionTool: 'time.now', confidence: 0.9, successCount: 5, failureCount: 0, sourceRequest: null },
    ]);
    expect(examples).toEqual([]);
  });
});

// ===========================================================================
// §29 — trained model semantic version (1.0.1)
// ===========================================================================

describe('v1.0.10 §29 — training config supports the 1.0.1 model version', () => {
  test('modelVersion accepts semver-like values (1.0.1)', () => {
    const cfg = trainingConfigSchema.safeParse({ epochs: 20, modelVersion: '1.0.1' });
    expect(cfg.success).toBe(true);
  });

  test('modelVersion rejects non-semver values', () => {
    expect(trainingConfigSchema.safeParse({ modelVersion: 'tc-abc123' }).success).toBe(false);
    expect(trainingConfigSchema.safeParse({ modelVersion: '' }).success).toBe(false);
  });

  test('resolveTrainingConfig keeps a provided semantic version', () => {
    const resolved = resolveTrainingConfig({ modelVersion: '1.0.1' });
    expect(resolved.modelVersion).toBe('1.0.1');
    expect(resolved.epochs).toBe(20);
  });

  test('resolveTrainingConfig leaves the version undefined when unset (legacy fallback)', () => {
    expect(resolveTrainingConfig({}).modelVersion).toBeUndefined();
    expect(resolveTrainingConfig({ modelVersion: 'garbage' }).modelVersion).toBeUndefined();
  });
});

// ===========================================================================
// §23/§24/§25 — the expanded seed dataset: shape, coverage, no leakage
// ===========================================================================

describe('v1.0.10 §23-§26 — expanded seed training dataset', () => {
  const VALID_TOOLS = new Set([
    'server.health', 'server.restart', 'service.restart', 'server.list', 'system.info',
    'math.evaluate', 'text.analyze', 'time.now', 'uuid.generate', 'echo.echo', 'delay.wait',
    'memory.store', 'memory.recall', 'notification.send', 'image.generate',
  ]);
  const examples = (seedDataset as { examples: { category: string; request: string; expectedTool?: string; expectedParams?: Record<string, unknown>; split?: string }[] }).examples;

  test('the dataset is substantially expanded (>= 150 examples)', () => {
    expect(examples.length).toBeGreaterThanOrEqual(150);
  });

  test('every example carries category/request/expectedTool/split and a REAL registered tool', () => {
    for (const ex of examples) {
      expect(typeof ex.category).toBe('string');
      expect(ex.category.length).toBeGreaterThan(0);
      expect(typeof ex.request).toBe('string');
      expect(ex.request.length).toBeGreaterThan(0);
      expect(VALID_TOOLS.has(ex.expectedTool ?? '')).toBe(true);
      expect(['train', 'validation', 'test']).toContain(ex.split ?? '');
    }
  });

  test('train/validation/test splits all exist (§25) and train dominates', () => {
    const counts = { train: 0, validation: 0, test: 0 };
    for (const ex of examples) counts[(ex.split ?? 'train') as keyof typeof counts] += 1;
    expect(counts.train).toBeGreaterThan(counts.validation);
    expect(counts.train).toBeGreaterThan(counts.test);
    expect(counts.validation).toBeGreaterThan(0);
    expect(counts.test).toBeGreaterThan(0);
  });

  test('no identical request appears twice — no leakage between splits (§25)', () => {
    const seen = new Set<string>();
    for (const ex of examples) {
      const key = ex.request.trim().toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('balanced coverage: every registered tool appears in train AND test', () => {
    const inTrain = new Set(examples.filter((e) => e.split === 'train').map((e) => e.expectedTool));
    const inTest = new Set(examples.filter((e) => e.split === 'test').map((e) => e.expectedTool));
    for (const tool of VALID_TOOLS) {
      expect(inTrain.has(tool)).toBe(true);
      expect(inTest.has(tool)).toBe(true);
    }
  });

  test('parameter generation examples exist (§26) and stay inside the real schemas', () => {
    const allowedKeys: Record<string, Set<string>> = {
      'server.health': new Set(['serverId']),
      'server.restart': new Set(['serverId']),
      'service.restart': new Set(['serverId']),
      'server.list': new Set([]),
      'system.info': new Set([]),
      'math.evaluate': new Set(['expression']),
      'text.analyze': new Set(['text']),
      'time.now': new Set(['timezone']),
      'uuid.generate': new Set(['count']),
      'echo.echo': new Set(['message']),
      'delay.wait': new Set(['ms']),
      'memory.store': new Set(['key', 'value', 'tags']),
      'memory.recall': new Set(['key', 'query']),
      'notification.send': new Set(['title', 'body', 'level']),
      'image.generate': new Set(['prompt', 'size', 'style']),
    };
    let withParams = 0;
    for (const ex of examples) {
      if (!ex.expectedParams) continue;
      withParams += 1;
      const allowed = allowedKeys[ex.expectedTool ?? ''] ?? new Set();
      for (const key of Object.keys(ex.expectedParams)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    expect(withParams).toBeGreaterThanOrEqual(80);
  });

  test('robustness material exists: typos, ambiguous phrasing, conversational wording (§24)', () => {
    const text = examples.map((e) => e.request.toLowerCase()).join('\n');
    expect(/helthy|restrat|wether|moniter|gnerate/.test(text)).toBe(true); // typo-robustness
    expect(examples.some((e) => e.category === 'ambiguous')).toBe(true);
    expect(examples.some((e) => e.category === 'conversational')).toBe(true);
  });
});
