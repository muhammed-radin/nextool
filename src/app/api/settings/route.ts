/**
 * /api/settings — GET current settings, PUT partial update.
 */
import { ok, readJson } from '@/lib/nexool/api-helpers';
import { getSettings, updateSettings } from '@/lib/nexool/settings';
import type { NexToolSettings } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getSettings(true);
  return ok(settings);
}

export async function PUT(req: Request) {
  const body = await readJson<Partial<NexToolSettings>>(req);
  const settings = await updateSettings(body ?? {});
  return ok(settings);
}
