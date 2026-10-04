/**
 * NexTool v1.0.10 §32-§39 — Structured pattern learning.
 *
 * Pipeline (§35):
 *
 *   Tool Result → Observer (normalized observation) → Pattern Extraction
 *               → Pattern Store (PatternRecord) → Training Dataset (optional)
 *
 * Design rules (from the spec):
 *  - Patterns are STRUCTURED records (type, conditions, context, action,
 *    result, outcome, confidence/frequency, source, task mode, planner mode)
 *    — never raw logs (§34).
 *  - The Observer stays responsible for deciding what actually happened; the
 *    pattern layer learns from VERIFIED observations only (§35).
 *  - Quality/fitting safeguards (§36): a single accidental event can never
 *    become high-confidence knowledge. Evidence = frequency + success rate +
 *    repeatability; contradictions WEAKEN a pattern, repetitions STRENGTHEN it.
 *  - Pattern information is ADDITIONAL EVIDENCE for training/evaluation —
 *    never a mandatory runtime dependency (§37): inference works unchanged
 *    when no pattern exists.
 *  - Bounded, sanitized content only: no sensitive payloads are stored (§34).
 *
 * All extraction is deterministic and non-blocking (fire-and-forget callers).
 */
import { db } from '@/lib/db';
import type { ToolExecution } from '../types';

const REQUEST_SNIPPET_CAP = 300;
const SUMMARY_CAP = 240;

/** Evidence math (§36) — exported for deterministic unit tests. */
export function deriveConfidence(successCount: number, failureCount: number, contradictionCount: number): number {
  const favorable = successCount;
  const unfavorable = failureCount;
  const total = favorable + unfavorable;
  if (total <= 0) return 0;
  const successRate = favorable / total;
  const evidence = Math.min(1, total / 3); // one event → ≤ 0.33 → never "high confidence"
  const penalty = 0.15 * contradictionCount;
  return Math.round(Math.max(0, successRate * evidence - penalty) * 10_000) / 10_000;
}

function sanitizeRequest(request: string | undefined): string | undefined {
  if (typeof request !== 'string') return undefined;
  const cleaned = request.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, REQUEST_SNIPPET_CAP) : undefined;
}

function sanitizeSummary(text: string | undefined): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CAP);
}

interface PatternFold {
  signature: string;
  patternType: 'sequence' | 'outcome' | 'verification' | 'failure-recovery' | 'live' | 'early-completion';
  actionTool: string;
  success: boolean;
  conditions: Record<string, unknown>;
  context: Record<string, unknown>;
  resultSummary: string;
  taskMode: string;
  plannerType: string;
  sourceRequest?: string;
}

/** Fold one deterministic observation into the pattern store (upsert). */
async function foldPattern(fold: PatternFold): Promise<void> {
  const successDelta = fold.success ? 1 : 0;
  const failureDelta = fold.success ? 0 : 1;
  try {
    const existing = await db.patternRecord.findUnique({ where: { signature: fold.signature } });
    if (!existing) {
      const successCount = successDelta;
      const failureCount = failureDelta;
      const frequency = 1;
      await db.patternRecord.create({
        data: {
          signature: fold.signature,
          patternType: fold.patternType,
          inputConditions: JSON.stringify(fold.conditions),
          context: JSON.stringify(fold.context),
          actionTool: fold.actionTool,
          resultSummary: sanitizeSummary(fold.resultSummary),
          outcome: successDelta ? 'positive' : 'negative',
          confidence: deriveConfidence(successCount, failureCount, 0),
          frequency,
          successCount,
          failureCount,
          contradictionCount: 0,
          source: 'task-execution',
          taskMode: fold.taskMode,
          plannerType: fold.plannerType,
          sourceRequest: sanitizeRequest(fold.sourceRequest) ?? null,
        },
      });
      return;
    }
    const successCount = existing.successCount + successDelta;
    const failureCount = existing.failureCount + failureDelta;
    const frequency = existing.frequency + 1;
    // A contradiction is a NEGATIVE fold on a pattern that had been positive —
    // it weakens the stored knowledge (§36: weaker when contradicted).
    const contradictionDelta = !fold.success && existing.successCount > existing.failureCount ? 1 : 0;
    await db.patternRecord.update({
      where: { signature: fold.signature },
      data: {
        successCount,
        failureCount,
        frequency,
        contradictionCount: existing.contradictionCount + contradictionDelta,
        confidence: deriveConfidence(successCount, failureCount, existing.contradictionCount + contradictionDelta),
        outcome: successCount > failureCount ? 'positive' : successCount < failureCount ? 'negative' : existing.outcome,
        resultSummary: sanitizeSummary(fold.resultSummary) || existing.resultSummary,
        taskMode: fold.taskMode,
        plannerType: fold.plannerType,
        sourceRequest: sanitizeRequest(fold.sourceRequest) ?? existing.sourceRequest,
      },
    });
  } catch (err) {
    console.error('[patterns] fold failed for signature:', fold.signature, err);
  }
}

const RESTART_TOOLS = new Set(['server.restart', 'service.restart']);
const HEALTH_TOOL = 'server.health';

export interface PatternObservationInput {
  taskId: string;
  taskMode: string;
  plannerType: string;
  request: string;
  tool: string;
  execution: ToolExecution;
  observation: string;
  /** The action executed right before this one (previousActions tail-1). */
  previousAction?: { action: string; status: string; at: string };
}

/**
 * §33/§35 — extract patterns from ONE normalized observation. Deterministic
 * rules only (no LLM): pair sequences, verification, outcome and
 * failure-recovery shapes. Live tasks record their transitions as live
 * patterns so observe → detect change → subgoal → action cycles become
 * reusable knowledge (§33 "Live pattern").
 */
export async function recordPatternObservation(input: PatternObservationInput): Promise<void> {
  try {
    const { tool, execution, observation, previousAction } = input;
    const success = execution.status === 'completed';
    const prevTool = previousAction?.action;
    const prevOk = previousAction?.status === 'completed';
    const obsLower = observation.toLowerCase();
    const base = {
      taskMode: input.taskMode,
      plannerType: input.plannerType,
      sourceRequest: input.request,
      context: { taskId: input.taskId },
    };

    // 1) Pair sequence (A → B), both actions known.
    if (prevTool && prevTool !== tool) {
      if (prevOk && success) {
        const isVerification = tool === HEALTH_TOOL && prevTool !== HEALTH_TOOL;
        await foldPattern({
          ...base,
          signature: `${input.taskMode === 'live' && input.plannerType === 'one-by-one' ? 'live' : 'sequence'}:${prevTool}->${tool}`,
          patternType: input.taskMode === 'live' && input.plannerType === 'one-by-one' ? 'live' : isVerification ? 'verification' : 'sequence',
          actionTool: tool,
          success: true,
          conditions: { fromTool: prevTool, toTool: tool, fromStatus: 'completed' },
          resultSummary: observation,
        });
      } else if (prevOk && !success) {
        // "A then B" co-occurrence contradicted as a successful transition.
        await foldPattern({
          ...base,
          signature: `sequence:${prevTool}->${tool}`,
          patternType: 'sequence',
          actionTool: tool,
          success: false,
          conditions: { fromTool: prevTool, toTool: tool, fromStatus: 'completed' },
          resultSummary: execution.error?.message ?? observation,
        });
      } else if (!prevOk && success) {
        // Failure-recovery (§33): tool A failed → tool B succeeded.
        await foldPattern({
          ...base,
          signature: `failure-recovery:${prevTool}->${tool}`,
          patternType: 'failure-recovery',
          actionTool: tool,
          success: true,
          conditions: { failedTool: prevTool, recoveryTool: tool },
          resultSummary: observation,
        });
      } else if (!prevOk && !success) {
        // B did NOT recover from A's failure — weakens the recovery pattern.
        await foldPattern({
          ...base,
          signature: `failure-recovery:${prevTool}->${tool}`,
          patternType: 'failure-recovery',
          actionTool: tool,
          success: false,
          conditions: { failedTool: prevTool, recoveryTool: tool },
          resultSummary: execution.error?.message ?? observation,
        });
      }
    }

    // 2) Outcome pattern: unhealthy/degraded observed → restart attempted (§33).
    if (RESTART_TOOLS.has(tool) && /(unhealthy|degraded|stopped|down)/i.test(obsLower)) {
      await foldPattern({
        ...base,
        signature: 'outcome:unhealthy-detected->restart',
        patternType: 'outcome',
        actionTool: tool,
        success: true,
        conditions: { health: 'unhealthy-or-degraded', action: 'restart' },
        resultSummary: observation,
      });
    }

    // 3) Outcome pattern: restart → verified healthy (recovery loop closure).
    if (tool === HEALTH_TOOL && success && /(healthy)/i.test(obsLower) && prevTool && RESTART_TOOLS.has(prevTool)) {
      await foldPattern({
        ...base,
        signature: 'outcome:restart->verified-healthy',
        patternType: 'outcome',
        actionTool: tool,
        success: true,
        conditions: { after: 'restart', health: 'healthy' },
        resultSummary: observation,
      });
    }
  } catch (err) {
    console.error('[patterns] observation extraction failed:', err);
  }
}

export interface TaskOutcomeInput {
  taskId: string;
  taskMode: string;
  plannerType: string;
  outcome: 'completed' | 'failed' | 'stopped' | 'cancelled' | 'limit_reached';
  steps: number;
  toolCalls: number;
  planStepsPlanned: number;
  previousActions: { action: string; status: string; at: string }[];
  lastObservation?: string;
  request: string;
}

/**
 * §33 — task-outcome patterns. The most valuable one is the EARLY-COMPLETION
 * pattern: the first observation proved the goal and the remaining pre-planned
 * steps were discarded — that behavior is intentional and reusable.
 */
export async function recordTaskOutcomePatterns(input: TaskOutcomeInput): Promise<void> {
  try {
    const lastAction = input.previousActions[input.previousActions.length - 1];
    const base = {
      taskMode: input.taskMode,
      plannerType: input.plannerType,
      sourceRequest: input.request,
      context: { taskId: input.taskId },
    };
    if (input.outcome === 'completed' && input.steps <= 1 && input.toolCalls <= 1 && lastAction) {
      await foldPattern({
        ...base,
        signature: `early-completion:${lastAction.action}`,
        patternType: 'early-completion',
        actionTool: lastAction.action,
        success: true,
        conditions: { steps: input.steps, toolCalls: input.toolCalls, plannedSteps: input.planStepsPlanned },
        resultSummary: input.lastObservation ?? 'First observation proved the goal — remaining steps discarded.',
      });
    }
    if (input.outcome === 'completed' && input.planStepsPlanned > input.steps && input.steps >= 1) {
      await foldPattern({
        ...base,
        signature: 'early-completion:discarded-planned-steps',
        patternType: 'early-completion',
        actionTool: lastAction?.action ?? 'unknown',
        success: true,
        conditions: { plannedSteps: input.planStepsPlanned, executedSteps: input.steps },
        resultSummary: `Goal achieved after ${input.steps} of ${input.planStepsPlanned} planned steps — unused steps discarded.`,
      });
    }
  } catch (err) {
    console.error('[patterns] outcome extraction failed:', err);
  }
}

// ---------- pattern → training examples (§37, §52) ----------

export const PATTERN_EXAMPLE_MIN_CONFIDENCE = 0.5;

export interface PatternRow {
  signature: string;
  patternType: string;
  actionTool: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  sourceRequest: string | null;
}

/**
 * Convert RELIABLE patterns into additional training examples (additional
 * evidence — never mandatory). Only single-action patterns map cleanly onto
 * the request → tool classification task:
 *  - early-completion:<tool>   (the one tool that fulfilled the request)
 *  - outcome:unhealthy-detected→restart (recovery tasks → restart)
 * Sequence/verification/failure-recovery patterns stay structured knowledge
 * (API-visible) — converting a multi-tool transition into a request→tool
 * example would fabricate semantics, so it is deliberately not done.
 */
export function patternsToDatasetExamples(
  patterns: PatternRow[],
  minConfidence: number = PATTERN_EXAMPLE_MIN_CONFIDENCE,
): { category: string; request: string; expectedTool: string; split: 'train' }[] {
  const examples: { category: string; request: string; expectedTool: string; split: 'train' }[] = [];
  for (const p of patterns) {
    if (!p.sourceRequest) continue;
    const successRate = p.successCount + p.failureCount > 0 ? p.successCount / (p.successCount + p.failureCount) : 0;
    if (p.confidence < minConfidence || successRate < 0.6) continue;
    const convertible =
      (p.patternType === 'early-completion' && p.signature.startsWith('early-completion:') && p.signature !== 'early-completion:discarded-planned-steps')
      || (p.signature === 'outcome:unhealthy-detected->restart' && p.actionTool !== 'unknown');
    if (!convertible) continue;
    examples.push({
      category: 'pattern-learned',
      request: p.sourceRequest,
      expectedTool: p.actionTool,
      split: 'train',
    });
  }
  return examples;
}
