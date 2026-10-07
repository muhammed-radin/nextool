/**
 * NexTool v1.0.13 — FS Inspector: Virtual FS inspection (read-only operator view).
 *
 * GET /api/inspector/vfs?path=/&op=list|read|stat
 *
 * A console-only, strictly READ-ONLY window into the GLOBAL shared Virtual FS
 * (v1.0.12 §3). There is deliberately no mutation surface here — writes stay
 * the exclusive domain of tools/builtins that pass through the enforcement
 * points in `lib/nexool/tools/vfs`. Every operation goes through the same
 * secure path resolution the tools use, so traversal (`..`, %2e%2e), NUL
 * bytes, host-path shapes and planted symlinks are rejected with the
 * documented VirtualFsError codes (surfaced honestly as error envelopes).
 *
 * Responses always carry the live VFS `usage` snapshot so the operator sees
 * how much of the shared store the runtime is consuming.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { openGlobalVfs, normalizeVirtualPath, VirtualFsError } from '@/lib/nexool/tools/vfs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Operator listing cap — a directory dump is capped, not unbounded. */
const LIST_ENTRY_CAP = 500;
/** Preview cap: at most the first 64 KiB of decoded text is returned. */
const READ_PREVIEW_BYTES = 64 * 1024;
/** Files larger than 2 MiB are refused for preview (honest error, no slice). */
const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;

const OPS = new Set(['list', 'read', 'stat']);

/** Map documented VFS error codes onto honest HTTP statuses. */
function errorStatus(code: string): number {
  if (code === 'VFS_ACCESS') return 403;
  if (code === 'ENOENT') return 404;
  if (code === 'VFS_LIMIT') return 413;
  return 400;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get('op') ?? 'list';
  const path = url.searchParams.get('path') ?? '/';
  if (!OPS.has(op)) {
    return fail('INVALID_PARAMS', `Unsupported op "${op}" — use one of: list, read, stat.`, 400);
  }

  const vfs = openGlobalVfs();

  try {
    // Canonical virtual path — also re-validates (traversal/NUL/host shapes).
    const base = normalizeVirtualPath(path);

    if (op === 'list') {
      const raw = vfs.readdirWithTypes(base);
      const entries = raw.slice(0, LIST_ENTRY_CAP).map((entry) => {
        const childPath = base === '/' ? `/${entry.name}` : `${base}/${entry.name}`;
        try {
          const st = vfs.stat(childPath);
          return { name: entry.name, kind: entry.kind, size: st.size, updatedAt: st.updatedAt };
        } catch {
          // Entry vanished (or stat raced) between readdir and stat — keep the
          // row with a 0 size instead of dropping the listing.
          return { name: entry.name, kind: entry.kind, size: 0, updatedAt: undefined };
        }
      });
      return ok({ path: base, entries, usage: vfs.usage() });
    }

    if (op === 'read') {
      const st = vfs.stat(base);
      if (st.size > READ_MAX_FILE_BYTES) {
        return fail(
          'FS_TOO_LARGE',
          `File "${base}" is ${st.size} bytes — FS Inspector refuses to preview files larger than ${READ_MAX_FILE_BYTES} bytes (2 MiB).`,
          400,
        );
      }
      const content = vfs.readFile(base);
      const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
      const capped = text.length > READ_PREVIEW_BYTES ? text.slice(0, READ_PREVIEW_BYTES) : text;
      return ok({
        path: base,
        content: capped,
        truncated: st.size > READ_PREVIEW_BYTES,
        size: st.size,
        usage: vfs.usage(),
      });
    }

    // op === 'stat'
    const entry = vfs.stat(base);
    return ok({ path: base, entry, usage: vfs.usage() });
  } catch (err) {
    if (err instanceof VirtualFsError) {
      return fail(err.code, err.message, errorStatus(err.code));
    }
    return fail(
      'FS_INSPECTOR_ERROR',
      err instanceof Error ? err.message : 'Unexpected Virtual FS inspection failure.',
      500,
    );
  }
}
