/**
 * GET /api/state — GlobalLiveState (servers + runtime status + active task counts).
 */
import { ok } from '@/lib/nexool/api-helpers';
import { getGlobalState } from '@/lib/nexool/main/nexool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const state = await getGlobalState();
  return ok(state);
}
