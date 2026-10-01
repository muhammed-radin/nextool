/**
 * POST /api/env/event — inject an environment event into the virtual fleet
 * and broadcast it to all live tasks so Live Mode wakes immediately.
 * Body validated with envEventSchema (zod) — v1.0.1 §54.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { crashServer, degradeServer, recoverServer, getServer, listServers } from '@/lib/nexool/environment';
import { getGlobalState, injectEvent } from '@/lib/nexool/main/nexool';
import { db } from '@/lib/db';
import { envEventSchema } from '@/lib/nexool/schemas';
import type { VirtualServer } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseBody(req, envEventSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const type = body.type;

  let serverId = body.serverId;
  if (!serverId) {
    serverId = listServers().find((s) => (type === 'server.recover' ? s.health !== 'healthy' : s.health === 'healthy'))?.id;
  }
  if (!serverId || !getServer(serverId)) {
    return fail('INVALID_PARAMS', `Unknown or missing serverId. Known servers: ${listServers().map((s) => s.id).join(', ')}`);
  }

  switch (type) {
    case 'server.crash':
      crashServer(serverId);
      break;
    case 'server.degrade':
      degradeServer(serverId);
      break;
    case 'server.recover':
      recoverServer(serverId);
      break;
  }

  // broadcast to all active live tasks so their wait is interrupted (priority 2 for crash)
  const priority = type === 'server.crash' ? 2 : 4;
  try {
    const liveTasks = await db.task.findMany({
      where: { mode: 'live', status: { in: ['running', 'waiting', 'queued'] } },
      select: { id: true },
    });
    await Promise.all(
      liveTasks.map((t) =>
        injectEvent(t.id, `environment.${type}`, { serverId, envType: type }, priority, 'environment'),
      ),
    );
  } catch (err) {
    console.error('[env/event] broadcast failed:', err);
  }

  const state = await getGlobalState();
  const affected: VirtualServer | undefined = state.servers.find((s) => s.id === serverId);
  return ok({ ...state, affected });
}
