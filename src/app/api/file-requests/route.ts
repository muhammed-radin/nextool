/**
 * NexTool v1.0.13 (§10) — fs.upload file-request console API.
 *
 * GET  /api/file-requests?taskId=… — list pending "Upload a file" requests
 *      (powers the console prompt: "[Choose file] [Cancel]").
 * POST /api/file-requests — resolve a request:
 *      { requestId, fileName, contentBase64 }   → deliver the chosen file
 *      { requestId, cancel: true }              → cancel (tool resolves null)
 *
 * The registry (tools/file-requests.ts) holds NO file content; the base64
 * payload is handed to the awaiting fs.upload handler, which writes it into
 * the shared VFS where the central vfs limits stay authoritative. Requests
 * self-expire after 120 s (bounded wait, PROMPT-like semantics) and are
 * flushed when their task stops.
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import {
  listPendingFileRequests,
  resolvePendingFileRequest,
  FILE_REQUEST_MAX_BASE64_CHARS,
} from '@/lib/nexool/tools/file-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId') ?? undefined;
  return ok({ requests: listPendingFileRequests(taskId || undefined) });
}

export async function POST(req: Request) {
  const body = await readJson<{
    requestId?: string;
    fileName?: string;
    contentBase64?: string;
    cancel?: boolean;
  }>(req);
  if (!body || typeof body.requestId !== 'string' || !body.requestId) {
    return fail('INVALID_PARAMS', 'Expected { requestId, fileName, contentBase64 } or { requestId, cancel: true }.', 400);
  }

  if (body.cancel === true) {
    const resolved = resolvePendingFileRequest(body.requestId, null, null);
    if (!resolved) return fail('NOT_FOUND', 'File request is unknown or already expired.', 404);
    return ok({ resolved: true, cancelled: true });
  }

  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  const contentBase64 = typeof body.contentBase64 === 'string' ? body.contentBase64 : '';
  if (!fileName) return fail('INVALID_PARAMS', 'fileName is required.', 400);
  if (!contentBase64) return fail('INVALID_PARAMS', 'contentBase64 is required.', 400);
  if (contentBase64.length > FILE_REQUEST_MAX_BASE64_CHARS) {
    return fail(
      'FS_TOO_LARGE',
      `Upload payload exceeds the ${FILE_REQUEST_MAX_BASE64_CHARS} base64-char console limit (~6 MiB binary).`,
      413,
    );
  }
  // Base64 shape check — decode failures surface honestly, never as garbage bytes.
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(contentBase64)) {
    return fail('INVALID_PARAMS', 'contentBase64 is not valid base64.', 400);
  }

  const resolved = resolvePendingFileRequest(body.requestId, fileName, contentBase64);
  if (!resolved) return fail('NOT_FOUND', 'File request is unknown or already expired (120 s window).', 404);
  return ok({ resolved: true, cancelled: false });
}
