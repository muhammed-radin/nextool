/**
 * GET  /api/icons — current branding manifest (staged or active, null when none)
 * POST /api/icons — upload + validate an icons ZIP (multipart "file") → staged
 * PATCH /api/icons — { action: "activate", packageId } → active (used by metadata)
 * DELETE /api/icons — discard the staged package (active packages survive)
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import {
  stageIconPackage, activateIconPackage, discardIconPackage, getActiveBranding,
} from '@/lib/nexool/branding';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024;

async function readManifest(): Promise<unknown> {
  const row = await db.setting.findUnique({ where: { key: 'branding.icons' } });
  return row ? JSON.parse(row.value) : null;
}

export async function GET() {
  try {
    const [manifest, active] = await Promise.all([readManifest(), getActiveBranding()]);
    return ok({ manifest, active });
  } catch (err) {
    return fail('ICONS_GET_FAILED', err instanceof Error ? err.message : 'Failed to read branding state', 500);
  }
}

export async function POST(req: Request) {
  try {
    const form = await req.formData().catch(() => null);
    if (!form) return fail('INVALID_PARAMS', 'Expected multipart/form-data with a "file" field', 400);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('INVALID_PARAMS', 'Field "file" (icons.zip) is required', 400);
    if (file.size > MAX_BYTES) return fail('INVALID_PARAMS', `Package exceeds ${MAX_BYTES / 1024 / 1024} MiB limit`, 400);
    if (!file.name.toLowerCase().endsWith('.zip')) {
      return fail('INVALID_PARAMS', 'Icons must be uploaded as a ZIP package (e.g. icons.zip with favicon.ico + icon-<size>.png)', 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await stageIconPackage(bytes);
    return ok(result, 201);
  } catch (err) {
    return fail('ICONS_INVALID', err instanceof Error ? err.message : 'Icon package rejected', 400);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { action?: string; packageId?: string } | null;
    if (body?.action !== 'activate' || !body.packageId) {
      return fail('INVALID_PARAMS', 'Expected { action: "activate", packageId }', 400);
    }
    const manifest = await activateIconPackage(body.packageId);
    if (!manifest) return fail('NOT_FOUND', 'No staged icon package found — upload one first', 404);
    return ok(manifest);
  } catch (err) {
    return fail('ICONS_ACTIVATE_FAILED', err instanceof Error ? err.message : 'Icon activation failed', 400);
  }
}

export async function DELETE() {
  try {
    const discarded = await discardIconPackage();
    return ok({ discarded });
  } catch (err) {
    return fail('ICONS_DISCARD_FAILED', err instanceof Error ? err.message : 'Discard failed', 500);
  }
}
