/**
 * NexTool v1.0.13 (§10) — fs.download delivery route.
 *
 * GET /api/fsdownloads/<token>
 *
 * Streams a VFS file registered by the `fs.download` tool. The token registry
 * (tools/fs-downloads.ts) is the single authority: it validates expiry and
 * RE-VERIFIES on EVERY request that the target is still a plain file inside
 * the shared VFS root (deleted/renamed targets die here; host paths outside
 * the boundary are unreachable by construction).
 *
 * Single-user self-hosted console: any holder of the unguessable, 10-minute
 * token may download the registered file — exactly the semantics the tool
 * promises ("hand a produced file to the operator as a browser download").
 */
import { resolveVfsDownloadHostPath } from '@/lib/nexool/tools/fs-downloads';
import fsSync from 'node:fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || typeof token !== 'string') {
    return Response.json(
      { ok: false, error: { code: 'INVALID_PARAMS', message: 'Missing download token.' } },
      { status: 400 },
    );
  }

  const resolved = resolveVfsDownloadHostPath(token);
  if (!resolved) {
    return Response.json(
      {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Download link is invalid or expired (tokens live for 10 minutes and re-verify the VFS target on every request).',
        },
      },
      { status: 404 },
    );
  }

  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(resolved.hostPath);
  } catch {
    return Response.json(
      { ok: false, error: { code: 'NOT_FOUND', message: 'The registered file no longer exists in the shared VFS.' } },
      { status: 404 },
    );
  }
  if (!stat.isFile()) {
    return Response.json(
      { ok: false, error: { code: 'FS_NOT_FILE', message: 'The registered VFS entry is no longer a plain file.' } },
      { status: 400 },
    );
  }

  // Node stream → Web stream for the Next.js Response.
  const { createReadStream } = fsSync;
  const nodeStream = createReadStream(resolved.hostPath);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Content-Disposition': `attachment; filename="${resolved.name.replace(/[^\w.\- ]+/g, '_')}"`,
    'Cache-Control': 'no-store',
  });
  return new Response(webStream, { status: 200, headers });
}
