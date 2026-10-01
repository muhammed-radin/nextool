/**
 * /api/settings — GET current settings, PUT partial update.
 * PUT body validated with settingsSchema (zod) — v1.0.1 §54; updateSettings clamps.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { getSettings, updateSettings } from '@/lib/nexool/settings';
import { settingsSchema } from '@/lib/nexool/schemas';
import type { NexToolSettings } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = await getSettings(true);
  return ok(settings);
}

export async function PUT(req: Request) {
  const parsed = await parseBody(req, settingsSchema);
  if (parsed.error) return parsed.error;
  const settings = await updateSettings(parsed.data as Partial<NexToolSettings>);
  return ok(settings);
}
