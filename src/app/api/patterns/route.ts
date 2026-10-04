/**
 * NexTool v1.0.10 — GET /api/patterns
 *
 * Read access to the structured pattern store (§32-§36):
 *   GET /api/patterns                      → patterns + stats
 *   GET /api/patterns?type=outcome         → filter by pattern type
 *   GET /api/patterns?minConfidence=0.5    → only reliable patterns
 *   GET /api/patterns?format=examples      → pattern-derived training examples
 *                                            (§37: additional evidence, never
 *                                             mandatory for inference)
 */
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/nexool/api-helpers';
import { patternsToDatasetExamples, type PatternRow } from '@/lib/nexool/patterns/extractor';

const PATTERN_TYPES = ['sequence', 'outcome', 'verification', 'failure-recovery', 'live', 'early-completion'];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get('type');
    const minConfidence = Number(url.searchParams.get('minConfidence') ?? '0');
    const format = url.searchParams.get('format');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '200'), 1), 1000);

    if (type !== null && !PATTERN_TYPES.includes(type)) {
      return fail('INVALID_PARAMS', `Unknown pattern type "${type}". Valid: ${PATTERN_TYPES.join(', ')}`, 400);
    }

    const rows = await db.patternRecord.findMany({
      where: {
        ...(type ? { patternType: type } : {}),
        ...(Number.isFinite(minConfidence) && minConfidence > 0 ? { confidence: { gte: minConfidence } } : {}),
      },
      orderBy: [{ confidence: 'desc' }, { frequency: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    });

    if (format === 'examples') {
      const patternRows: PatternRow[] = rows.map((r) => ({
        signature: r.signature,
        patternType: r.patternType,
        actionTool: r.actionTool,
        confidence: r.confidence,
        successCount: r.successCount,
        failureCount: r.failureCount,
        sourceRequest: r.sourceRequest,
      }));
      const examples = patternsToDatasetExamples(patternRows, minConfidence > 0 ? minConfidence : undefined);
      return ok({ format: 'examples', count: examples.length, examples });
    }

    const all = await db.patternRecord.findMany({ select: { patternType: true, confidence: true } });
    const byType: Record<string, number> = {};
    for (const r of all) byType[r.patternType] = (byType[r.patternType] ?? 0) + 1;

    return ok({
      patterns: rows.map((r) => ({
        id: r.id,
        signature: r.signature,
        patternType: r.patternType,
        inputConditions: JSON.parse(r.inputConditions ?? '{}') as Record<string, unknown>,
        actionTool: r.actionTool,
        resultSummary: r.resultSummary,
        outcome: r.outcome,
        confidence: r.confidence,
        frequency: r.frequency,
        successCount: r.successCount,
        failureCount: r.failureCount,
        contradictionCount: r.contradictionCount,
        taskMode: r.taskMode,
        plannerType: r.plannerType,
        sourceRequest: r.sourceRequest ?? undefined,
        updatedAt: r.updatedAt.toISOString(),
      })),
      stats: {
        total: all.length,
        byType,
        highConfidence: all.filter((r) => r.confidence >= 0.5).length,
      },
    });
  } catch (err) {
    console.error('[api/patterns] GET failed:', err);
    return fail('PATTERNS_QUERY_FAILED', err instanceof Error ? err.message : 'Failed to query patterns', 500);
  }
}
