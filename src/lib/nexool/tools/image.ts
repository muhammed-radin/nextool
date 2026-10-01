/**
 * Image generation tool — uses z-ai-web-dev-sdk (backend only), stores file under public/generated.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ZAI from 'z-ai-web-dev-sdk';
import { db } from '@/lib/db';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';

export const IMAGE_SIZES = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
] as const;

/** image.generate — { prompt required, size?, style? } → { imagePath, prompt: finalPrompt, size }. */
export const imageGenerate: ToolHandler = async (params, ctx) => {
  const rawPrompt = params.prompt === undefined ? undefined : String(params.prompt);
  if (!rawPrompt || !rawPrompt.trim()) {
    throw new ToolFailure('Missing required param: prompt', 'INVALID_PARAMS');
  }
  const size = params.size === undefined ? '1024x1024' : String(params.size);
  if (!(IMAGE_SIZES as readonly string[]).includes(size)) {
    throw new ToolFailure(`size must be one of: ${IMAGE_SIZES.join(', ')}`, 'INVALID_PARAMS');
  }
  const style = params.style === undefined ? undefined : String(params.style);

  // Enrich the final prompt (constructive parameter), never just copy the raw sentence.
  const finalPrompt = [
    rawPrompt.trim(),
    style ? `Style: ${style}.` : '',
    'High quality, detailed, coherent composition.',
  ]
    .filter(Boolean)
    .join(' ');

  try {
    const zai = await ZAI.create();
    const response = await zai.images.generations.create({
      prompt: finalPrompt,
      size: size as (typeof IMAGE_SIZES)[number],
    });
    const base64 = response.data[0]?.base64;
    if (!base64) throw new ToolFailure('Image generation returned no data', 'TOOL_FAILURE');

    const id = crypto.randomUUID();
    const dir = path.join(process.cwd(), 'public', 'generated');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.png`);
    await writeFile(filePath, Buffer.from(base64, 'base64'));

    const imagePath = `/generated/${id}.png`;
    const row = await db.generatedImage.create({
      data: { id, path: imagePath, prompt: finalPrompt, size, taskId: ctx.taskId ?? null },
    });

    return {
      imagePath: row.path,
      prompt: finalPrompt,
      size,
    };
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    console.error('[image.generate] SDK failure:', err);
    throw new ToolFailure(
      `Image generation service unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
      'SERVICE_UNAVAILABLE',
    );
  }
};
