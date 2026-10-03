/**
 * GET /api/docs — documentation index (list of markdown docs in /docs).
 */
import { ok } from '@/lib/nexool/api-helpers';
import { listDocs } from '@/lib/nexool/docs';
import { APP_VERSION } from '@/lib/nexool/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const docs = await listDocs();
  return ok({ version: APP_VERSION, count: docs.length, docs });
}
