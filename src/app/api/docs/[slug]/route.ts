/**
 * GET /api/docs/[slug] — a single documentation page (markdown).
 */
import { fail, ok } from '@/lib/nexool/api-helpers';
import { readDoc } from '@/lib/nexool/docs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = await readDoc(slug);
  if (!doc) return fail('DOC_NOT_FOUND', `No documentation page named "${slug}".`, 404);
  return ok(doc);
}
