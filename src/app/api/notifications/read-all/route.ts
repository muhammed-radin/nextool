/**
 * POST /api/notifications/read-all — mark all notifications as read.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await db.notificationRecord.updateMany({ data: { read: true } });
  return ok({ ok: true });
}
