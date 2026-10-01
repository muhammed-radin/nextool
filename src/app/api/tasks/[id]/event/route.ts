/**
 * POST /api/tasks/[id]/event — inject a runtime event (wakes live mode when priority <= 5).
 * Body: { type: string, payload?: object, priority?: number, source?: EventSource }
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { injectEvent } from '@/lib/nexool/main/nexool';
import type { EventSource } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCES: EventSource[] = ['runtime', 'planner', 'observer', 'core', 'tool', 'environment', 'user', 'system'];

interface Body {
  type?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  source?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Body>(req);
  if (!body?.type || typeof body.type !== 'string') {
    return fail('INVALID_PARAMS', 'type (string) is required');
  }
  const source = SOURCES.includes(body.source as EventSource) ? (body.source as EventSource) : 'user';
  const priority = typeof body.priority === 'number' ? body.priority : 5;
  const event = await injectEvent(id, body.type, body.payload ?? {}, priority, source);
  return ok(event, 201);
}
