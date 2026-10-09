/**
 * POST /api/skills/import — import a skill folder ZIP (v1.0.16 §10.4).
 *
 * multipart/form-data with a `file` field: ONE top-level folder containing a
 * valid SKILL.md (references/, scripts/, assets/ optional). Imported content
 * is UNTRUSTED: it becomes instructions only, nothing is executed, and the
 * folder cannot escape the skills root (§10.6).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { importSkillZip } from '@/lib/nexool/skills/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ZIP_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail('INVALID_PARAMS', 'Expected multipart/form-data with a "file" field.', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return fail('INVALID_PARAMS', 'Missing "file" (a skill folder ZIP).', 400);
  if (file.size > MAX_ZIP_BYTES) return fail('INVALID_PARAMS', `Skill ZIP too large (${file.size} bytes; cap ${MAX_ZIP_BYTES}).`, 413);
  if (!file.name.toLowerCase().endsWith('.zip')) return fail('INVALID_PARAMS', 'The skill import must be a .zip archive.', 400);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = importSkillZip(file.name, bytes);
    if (!result.ok) return fail('SKILL_IMPORT_FAILED', result.error ?? 'Import failed', 400);
    return ok({ imported: result.imported }, 201);
  } catch (err) {
    return fail('SKILL_IMPORT_FAILED', err instanceof Error ? err.message : 'Import failed', 500);
  }
}
