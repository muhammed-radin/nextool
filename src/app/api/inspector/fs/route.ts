/**
 * NexTool v1.0.13 — FS Inspector: REAL filesystem inspection (read-only, confined to the runtime working directory).
 *
 * GET /api/inspector/fs?path=&op=list|read|stat
 *
 * Operator window onto the HOST filesystem the NexTool runtime actually runs
 * in. Single-user self-hosted console: nothing inside the runtime working
 * directory is hidden, but NOTHING outside it is ever reachable.
 *
 * Containment model (defense in depth):
 *  1. NUL bytes are rejected outright; every other traversal shape (`..`,
 *     `a//b`, `a/./b`, `a/../b`) is normalized by path.resolve against the
 *     runtime cwd.
 *  2. The resolved candidate is canonicalized with fs.realpathSync — this
 *     FOLLOWS symlinks, so a link planted inside the cwd that points outside
 *     resolves to its real (outside) location.
 *  3. The canonical path must equal the cwd realpath or live under it
 *     (cwdRealpath + sep). Anything else → FS_ACCESS, never a partial result.
 *
 * Read-only by construction: only readdir / lstat / readFileSync are used;
 * there is no write, rename or delete surface here. File previews are capped
 * at 64 KiB; files larger than 2 MiB are refused with an honest error.
 */
import fsSync from 'node:fs';
import nodePath from 'node:path';
import { ok, fail } from '@/lib/nexool/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Operator listing cap — a directory dump is capped, not unbounded. */
const LIST_ENTRY_CAP = 500;
/** Preview cap: at most the first 64 KiB of the file is returned. */
const READ_PREVIEW_BYTES = 64 * 1024;
/** Files larger than 2 MiB are refused for preview (honest error, no slice). */
const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;

const OPS = new Set(['list', 'read', 'stat']);

/** Honest error with a stable machine code for error envelopes. */
class FsInspectorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FsInspectorError';
    this.code = code;
  }
}

function cwdRealpath(): string {
  return fsSync.realpathSync(process.cwd());
}

/** `''` renders as the display root; anything else as a cwd-relative path. */
function displayPath(rel: string): string {
  return rel === '' ? '.' : rel;
}

/**
 * Containment gate. Returns the canonical host path plus its cwd-relative
 * display path, or throws FS_ACCESS / ENOENT / FS_ERROR.
 */
function resolveConfined(rawPath: string): { real: string; rel: string } {
  if (rawPath.includes('\0')) {
    throw new FsInspectorError('FS_ACCESS', 'NUL bytes in paths are not permitted.');
  }
  const root = cwdRealpath();
  // resolve() also normalizes `..`, duplicate and dot segments — empty-segment
  // traversal tricks collapse here before anything touches the disk.
  const candidate = nodePath.resolve(root, rawPath);
  let real: string;
  try {
    real = fsSync.realpathSync(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EIO';
    if (code === 'ENOENT') {
      throw new FsInspectorError(
        'ENOENT',
        `ENOENT: no such file or directory, open '${displayPath(nodePath.relative(root, candidate))}'`,
      );
    }
    throw new FsInspectorError('FS_ERROR', `${code}: cannot access the requested path.`);
  }
  // The ONLY containment decision: canonical path must stay inside the
  // canonical cwd. Symlinks that escape die here (their realpath lands
  // outside); host absolute paths outside the cwd die here too.
  if (real !== root && !real.startsWith(root + nodePath.sep)) {
    throw new FsInspectorError(
      'FS_ACCESS',
      'Access outside the NexTool runtime working directory is not permitted.',
    );
  }
  return { real, rel: nodePath.relative(root, real) };
}

function lstatOrThrow(real: string, display: string): fsSync.Stats {
  try {
    return fsSync.lstatSync(real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EIO';
    if (code === 'ENOENT') {
      throw new FsInspectorError('ENOENT', `ENOENT: no such file or directory, lstat '${display}'`);
    }
    throw new FsInspectorError('FS_ERROR', `${code}: cannot stat '${display}'.`);
  }
}

type EntryKind = 'file' | 'dir' | 'link';

function kindOf(dirent: fsSync.Dirent): EntryKind {
  if (dirent.isSymbolicLink()) return 'link';
  if (dirent.isDirectory()) return 'dir';
  return 'file';
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get('op') ?? 'list';
  const rawPath = url.searchParams.get('path') ?? '';
  if (!OPS.has(op)) {
    return fail('INVALID_PARAMS', `Unsupported op "${op}" — use one of: list, read, stat.`, 400);
  }

  try {
    const { real, rel } = resolveConfined(rawPath);
    const display = displayPath(rel);

    if (op === 'list') {
      let st: fsSync.Stats;
      try {
        st = fsSync.statSync(real);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EIO';
        throw new FsInspectorError('FS_ERROR', `${code}: cannot stat '${display}'.`);
      }
      if (!st.isDirectory()) {
        throw new FsInspectorError('ENOTDIR', `ENOTDIR: '${display}' is not a directory — listing requires a directory path.`);
      }
      let dirents: fsSync.Dirent[];
      try {
        dirents = fsSync.readdirSync(real, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EIO';
        throw new FsInspectorError('FS_ERROR', `${code}: cannot list '${display}'.`);
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      const entries: { name: string; kind: EntryKind; size: number; updatedAt: string }[] = [];
      for (const dirent of dirents.slice(0, LIST_ENTRY_CAP)) {
        const kind = kindOf(dirent);
        if (kind === 'link') {
          // Never follow links for metadata — report size 0, lstat mtime only.
          try {
            const lst = fsSync.lstatSync(nodePath.join(real, dirent.name));
            entries.push({ name: dirent.name, kind, size: 0, updatedAt: new Date(lst.mtimeMs).toISOString() });
          } catch {
            /* raced removal — skip entries that throw */
          }
          continue;
        }
        try {
          const lst = fsSync.lstatSync(nodePath.join(real, dirent.name));
          entries.push({ name: dirent.name, kind, size: lst.size, updatedAt: new Date(lst.mtimeMs).toISOString() });
        } catch {
          /* raced removal — skip entries that throw */
        }
      }
      return ok({ root: '.', path: rel, entries });
    }

    if (op === 'read') {
      const lst = lstatOrThrow(real, display);
      if (lst.isSymbolicLink()) {
        throw new FsInspectorError('FS_NOT_FILE', `"${display}" is a symbolic link — previews are limited to regular files.`);
      }
      if (!lst.isFile()) {
        throw new FsInspectorError(
          lst.isDirectory() ? 'EISDIR' : 'FS_NOT_FILE',
          lst.isDirectory()
            ? `EISDIR: illegal operation on a directory, read '${display}'`
            : `"${display}" is not a regular file — previews are limited to regular files.`,
        );
      }
      if (lst.size > READ_MAX_FILE_BYTES) {
        return fail(
          'FS_TOO_LARGE',
          `File "${display}" is ${lst.size} bytes — FS Inspector refuses to preview files larger than ${READ_MAX_FILE_BYTES} bytes (2 MiB).`,
          400,
        );
      }
      let buf: Buffer;
      try {
        buf = fsSync.readFileSync(real);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EIO';
        throw new FsInspectorError('FS_ERROR', `${code}: cannot read '${display}'.`);
      }
      const content = buf.subarray(0, READ_PREVIEW_BYTES).toString('utf8');
      return ok({
        root: '.',
        path: rel,
        content,
        truncated: lst.size > READ_PREVIEW_BYTES,
        size: lst.size,
      });
    }

    // op === 'stat'
    const lst = lstatOrThrow(real, display);
    const kind: EntryKind | 'other' = lst.isSymbolicLink() ? 'link' : lst.isDirectory() ? 'dir' : lst.isFile() ? 'file' : 'other';
    let linkTarget: string | undefined;
    if (kind === 'link') {
      try {
        linkTarget = fsSync.readlinkSync(real);
      } catch {
        linkTarget = undefined;
      }
    }
    return ok({
      root: '.',
      path: rel,
      entry: {
        name: rel === '' ? '.' : nodePath.basename(real),
        kind,
        size: kind === 'link' ? 0 : lst.size,
        createdAt: new Date(lst.birthtimeMs > 0 ? lst.birthtimeMs : lst.mtimeMs).toISOString(),
        updatedAt: new Date(lst.mtimeMs).toISOString(),
        ...(linkTarget !== undefined ? { linkTarget } : {}),
      },
    });
  } catch (err) {
    if (err instanceof FsInspectorError) {
      const status = err.code === 'FS_ACCESS' ? 403 : err.code === 'ENOENT' ? 404 : 400;
      return fail(err.code, err.message, status);
    }
    return fail(
      'FS_INSPECTOR_ERROR',
      err instanceof Error ? err.message : 'Unexpected filesystem inspection failure.',
      500,
    );
  }
}
