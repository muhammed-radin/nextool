/**
 * /api/skills — SKILLS SYSTEM (v1.0.16 §10).
 *
 * GET  → discovered skills (lightweight METADATA only: name, description,
 *        enabled, resources flags) + the catalog path. Progressive loading
 *        step 1-2: full SKILL.md bodies are NOT included here.
 * POST → management actions (single-user, self-hosted operator):
 *        { action: 'create', name, description, body? }  → new SKILL.md
 *        { action: 'reload' }                            → force rescan
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import {
  listSkills, saveSkill, invalidateSkillsCache, refreshCatalog,
} from '@/lib/nexool/skills/registry';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const skills = listSkills().map(({ dir: _dir, ...rest }) => {
      void _dir;
      return rest;
    });
    return ok({
      skills,
      catalog: 'skills/skills.md',
      skillsDir: 'skills/',
      count: skills.length,
      enabledCount: skills.filter((s) => s.enabled).length,
    });
  } catch (err) {
    return fail('SKILLS_LIST_FAILED', err instanceof Error ? err.message : 'Failed to list skills', 500);
  }
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    name: z.string().trim().min(3).max(64),
    description: z.string().trim().min(12).max(500),
    body: z.string().max(60_000).optional(),
  }),
  z.object({ action: z.literal('reload') }),
]);

export async function POST(req: Request) {
  const parsed = await parseBody(req, actionSchema);
  if (parsed.error) return parsed.error;
  try {
    if (parsed.data.action === 'reload') {
      invalidateSkillsCache();
      refreshCatalog();
      return ok({ reloaded: true, count: listSkills().length });
    }
    const { name, description, body } = parsed.data;
    const normalized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    const result = saveSkill(normalized, description, body ?? '');
    if (!result.ok) return fail('SKILL_INVALID', result.error ?? 'Invalid skill', 400);
    return ok({ created: normalized }, 201);
  } catch (err) {
    return fail('SKILL_CREATE_FAILED', err instanceof Error ? err.message : 'Failed to create skill', 500);
  }
}
