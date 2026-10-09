/**
 * GET /api/skills/[name]/export — download the skill folder as a ZIP
 * (SKILL.md + references/scripts/assets) for backup/sharing (§10.4).
 */
import { fail } from '@/lib/nexool/api-helpers';
import { exportSkillZip } from '@/lib/nexool/skills/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const result = exportSkillZip(name);
  if (!result) return fail('ENOTFOUND', `Skill "${name}" not found.`, 404);
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'Content-Length': String(result.bytes.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
