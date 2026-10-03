/**
 * /api/prompts — tool prompt()/alert() interactions (v1.0.6 §1.5–§1.7).
 *
 * GET  ?taskId=… → pending prompts the console UI should render.
 * POST { promptId, value? , cancel? } → answer/cancel a pending prompt.
 *
 * A waiting prompt pauses ONLY its tool (the promise pends with a 120s
 * timeout) — the NexTool runtime keeps processing everything else.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingPrompts, resolvePendingPrompt } from '@/lib/nexool/tools/sandbox-interactive';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    promptId: z.string().trim().min(1).max(120),
    value: z.string().max(4000).optional(),
    cancel: z.boolean().optional(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ prompts: listPendingPrompts(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { promptId, value, cancel } = parsed.data;
  const resolved = resolvePendingPrompt(promptId, cancel ? null : (value ?? null));
  if (!resolved) {
    return ok({ resolved: false, reason: 'Prompt not found or already resolved (or expired).' });
  }
  return ok({ resolved: true });
}
