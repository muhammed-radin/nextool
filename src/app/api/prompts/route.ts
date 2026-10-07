/**
 * /api/prompts — tool prompt() interactions (v1.0.6 §1.5–§1.7, v1.0.14 §22).
 *
 * GET  ?taskId=… → pending prompts the console UI should render (each entry
 *                  carries its requested inputType so the UI renders the
 *                  right control: text/textarea/number/date/color/file/...).
 * POST { promptId, value?, cancel?, file? } → answer/cancel a pending prompt.
 *       `file` carries structured metadata for `type: "file"` prompts — the
 *       tool receives a JSON string { name, mimeType, size, content? }.
 *
 * A waiting prompt pauses ONLY its tool (the promise pends with a 120s
 * timeout) — the NexTool runtime keeps processing everything else. v1.0.14:
 * Tool Editor tests pause the SAME way (§20/§21 — no auto-resolve).
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
    // v1.0.14 §22.1 — file prompt payload (content only for small files,
    // capped well below the 700 KB compose limit; never blind-huge blobs).
    file: z
      .object({
        name: z.string().trim().min(1).max(300),
        mimeType: z.string().max(200).optional(),
        size: z.number().int().min(0).max(2_147_483_647).optional(),
        content: z.string().max(700_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ prompts: listPendingPrompts(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { promptId, value, cancel, file } = parsed.data;
  const resolved = resolvePendingPrompt(promptId, cancel ? null : (value ?? null), file);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Prompt not found or already resolved (or expired).' });
  }
  return ok({ resolved: true });
}
