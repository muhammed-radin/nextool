/**
 * /api/skills/[name] — one skill (v1.0.16 §10.4).
 *
 * GET    → full detail: SKILL.md content, resources, validation state.
 *          ?resource=references/x.md → confined resource read (step 5 of the
 *          progressive loading contract; escapes are refused).
 * PUT    → { content? } (SKILL.md rewrite with frontmatter) | { enabled? }
 * DELETE → remove the skill folder (built-ins included — the operator owns
 *          the machine; the next `reload`/restart can re-seed built-ins).
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { deleteSkill, getSkill, readSkillResource, saveSkill, setSkillEnabled } from '@/lib/nexool/skills/registry';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ name: string }> };

export async function GET(req: Request, { params }: Params) {
  const { name } = await params;
  const resource = new URL(req.url).searchParams.get('resource');
  if (resource) {
    const res = readSkillResource(name, resource);
    if (!res) return fail('ENOTFOUND', `Resource "${resource}" not found inside skill "${name}" (or refused as a path escape).`, 404);
    return ok(res);
  }
  const skill = getSkill(name);
  if (!skill) return fail('ENOTFOUND', `Skill "${name}" not found.`, 404);
  const { dir: _dir, ...rest } = skill;
  void _dir;
  return ok(rest);
}

const putSchema = z
  .object({
    content: z.string().max(120_000).optional(),
    enabled: z.boolean().optional(),
    description: z.string().trim().min(12).max(500).optional(),
  })
  .strict();

export async function PUT(req: Request, { params }: Params) {
  const { name } = await params;
  const parsed = await parseBody(req, putSchema);
  if (parsed.error) return parsed.error;
  const { content, enabled, description } = parsed.data;

  if (typeof enabled === 'boolean') {
    setSkillEnabled(name, enabled);
  }
  if (typeof content === 'string') {
    const result = saveSkill(name, description ?? getSkill(name)?.description ?? '', content);
    if (!result.ok) return fail('SKILL_INVALID', result.error ?? 'Invalid SKILL.md', 400);
  } else if (description) {
    const current = getSkill(name);
    if (!current) return fail('ENOTFOUND', `Skill "${name}" not found.`, 404);
    const body = current.content.replace(/^---[\s\S]*?---\r?\n?/, '');
    const result = saveSkill(name, description, body);
    if (!result.ok) return fail('SKILL_INVALID', result.error ?? 'Invalid SKILL.md', 400);
  }
  const updated = getSkill(name);
  if (!updated) return fail('ENOTFOUND', `Skill "${name}" not found.`, 404);
  const { dir: _dir, ...rest } = updated;
  void _dir;
  return ok(rest);
}

export async function DELETE(_req: Request, { params }: Params) {
  const { name } = await params;
  const result = deleteSkill(name);
  if (!result.ok) return fail('SKILL_DELETE_FAILED', result.error ?? 'Failed to delete skill', 404);
  return ok({ deleted: name });
}
