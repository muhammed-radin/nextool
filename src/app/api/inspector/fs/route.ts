/**
 * NexTool v1.0.13 §2 — FS Inspector: REAL filesystem file manager (operator).
 *
 * GET  /api/inspector/fs?path=&op=list|read|stat|download[&paths=<json array>]
 * POST /api/inspector/fs            — JSON mutations: mkdir | write | rename |
 *                                     delete | copy | move | duplicate | zip |
 *                                     search | info
 * POST /api/inspector/fs (multipart)— op=upload&path=<dest dir> + files
 *
 * Operator window onto the HOST filesystem the NexTool runtime runs in.
 * Single-user self-hosted console: the operator explicitly opened the real-FS
 * inspector (spec §19), so full file management IS the product surface — but
 * NOTHING outside the runtime working directory is ever reachable.
 *
 * Containment model (defense in depth, lib/nexool/inspector/fs-containment):
 *  1. NUL bytes rejected; every traversal shape normalized by path.resolve.
 *  2. Existing paths canonicalized with fs.realpathSync (FOLLOWS symlinks).
 *  3. Creation targets canonicalize their nearest EXISTING ancestor.
 *  4. The canonical path must live inside the cwd realpath — anything else →
 *     FS_ACCESS, never a partial result.
 */
import fsSync from 'node:fs';
import nodePath from 'node:path';
import { Readable } from 'node:stream';
import { ok, fail } from '@/lib/nexool/api-helpers';
import {
  FsInspectorError,
  cwdRealpath,
  displayPath,
  resolveConfined,
  resolveConfinedTarget,
  fsErrorStatus,
} from '@/lib/nexool/inspector/fs-containment';
import {
  LIST_ENTRY_CAP,
  READ_PREVIEW_BYTES,
  READ_MAX_FILE_BYTES,
  WRITE_MAX_FILE_BYTES,
  ZIP_MAX_TOTAL_BYTES,
  SEARCH_MAX_DEPTH,
  SEARCH_RESULT_CAP,
  CHECKSUM_MAX_FILE_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  looksTextual,
  sha256Hex,
} from '@/lib/nexool/inspector/server-utils';
import { isImageLike, isTextLike, mimeishType } from '@/lib/nexool/inspector/mime';
import { createZip } from '@/lib/nexool/tools/zip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type EntryKind = 'file' | 'dir' | 'link';

function kindOf(dirent: fsSync.Dirent): EntryKind {
  if (dirent.isSymbolicLink()) return 'link';
  if (dirent.isDirectory()) return 'dir';
  return 'file';
}

function errResponse(err: unknown) {
  if (err instanceof FsInspectorError) {
    return fail(err.code, err.message, fsErrorStatus(err.code));
  }
  return fail('FS_INSPECTOR_ERROR', err instanceof Error ? err.message : 'Unexpected filesystem failure.', 500);
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new FsInspectorError('INVALID_PARAMS', `"${field}" must be a non-empty string.`);
  }
  return v;
}

function requirePathArray(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new FsInspectorError('INVALID_PARAMS', '"paths" must be a non-empty array of path strings.');
  }
  return v as string[];
}

/** Validated new entry name (no separators, no dot tricks). */
function requireName(v: unknown): string {
  const name = requireString(v, 'newName').trim();
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new FsInspectorError('INVALID_PARAMS', `"${name}" is not a valid file/folder name.`);
  }
  return name;
}

/** Copy/move destination folder must be a confined, existing directory. */
function requireDestDir(dest: unknown): { real: string; rel: string } {
  const d = resolveConfined(requireString(dest, 'dest'));
  if (!fsSync.statSync(d.real).isDirectory()) {
    throw new FsInspectorError('ENOTDIR', `"${displayPath(d.rel)}" is not a directory.`);
  }
  return d;
}

/** "name (copy)", "name (copy 2)" … collision policy shared by copy/duplicate/upload. */
function uniqueName(dirReal: string, name: string): string {
  if (!fsSync.existsSync(nodePath.join(dirReal, name))) return name;
  const ext = nodePath.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${i})${ext}`;
    if (!fsSync.existsSync(nodePath.join(dirReal, candidate))) return candidate;
  }
  throw new FsInspectorError('FS_ERROR', `Could not find a free name for "${name}".`);
}

/** Recursively collect REAL paths + zip-relative archive names, capped. */
function collectTree(real: string, rel: string, archiveRoot: string, out: { real: string; zip: string }[], budget: { bytes: number }): void {
  if (out.length > 20000) throw new FsInspectorError('FS_TOO_LARGE', 'Selection too large (more than 20000 entries).');
  const st = fsSync.lstatSync(real);
  if (st.isSymbolicLink()) return; // never follow links into archives
  if (st.isFile()) {
    budget.bytes += st.size;
    if (budget.bytes > ZIP_MAX_TOTAL_BYTES) {
      throw new FsInspectorError('FS_TOO_LARGE', `Selection exceeds the ${ZIP_MAX_TOTAL_BYTES / (1024 * 1024)} MiB archive budget.`);
    }
    out.push({ real, zip: archiveRoot });
    return;
  }
  if (st.isDirectory()) {
    const children = fsSync.readdirSync(real, { withFileTypes: true });
    if (children.length === 0) {
      out.push({ real: `${real}/`, zip: `${archiveRoot}/` }); // keep empty dirs
      return;
    }
    for (const child of children) {
      collectTree(nodePath.join(real, child.name), nodePath.join(rel, child.name), `${archiveRoot}${archiveRoot.endsWith('/') ? '' : '/'}${child.name}`, out, budget);
    }
  }
}

/** Build a ZIP Buffer from a selection of confined paths. */
function zipSelection(paths: string[]): Buffer {
  const budget = { bytes: 0 };
  const files: { real: string; zip: string }[] = [];
  for (const p of paths) {
    const { real, rel } = resolveConfined(p);
    const root = displayPath(rel) === '.' ? '' : nodePath.basename(real);
    collectTree(real, rel, root || '.', files, budget);
  }
  const inputs = files.map((f) => {
    if (f.zip.endsWith('/')) return { path: f.zip.replace(/\/+$/, '') + '/', data: Buffer.alloc(0) };
    const data = fsSync.readFileSync(f.real);
    return { path: f.zip, data };
  });
  return createZip(inputs);
}

// ---------------- GET ----------------

const GET_OPS = new Set(['list', 'read', 'stat', 'download']);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get('op') ?? 'list';
  const rawPath = url.searchParams.get('path') ?? '';
  if (!GET_OPS.has(op)) {
    return fail('INVALID_PARAMS', `Unsupported op "${op}" — use one of: list, read, stat, download.`, 400);
  }

  try {
    const { real, rel } = resolveConfined(rawPath);
    const display = displayPath(rel);

    if (op === 'list') {
      const st = fsSync.statSync(real);
      if (!st.isDirectory()) {
        throw new FsInspectorError('ENOTDIR', `ENOTDIR: '${display}' is not a directory — listing requires a directory path.`);
      }
      const dirents = fsSync.readdirSync(real, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      const entries: { name: string; kind: EntryKind; size: number; updatedAt: string }[] = [];
      for (const dirent of dirents.slice(0, LIST_ENTRY_CAP)) {
        const kind = kindOf(dirent);
        try {
          const lst = fsSync.lstatSync(nodePath.join(real, dirent.name));
          entries.push({ name: dirent.name, kind, size: kind === 'link' ? 0 : lst.size, updatedAt: new Date(lst.mtimeMs).toISOString() });
        } catch {
          /* raced removal — skip */
        }
      }
      return ok({ root: '.', path: rel, entries });
    }

    if (op === 'read') {
      const lst = fsSync.lstatSync(real);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        throw new FsInspectorError(lst.isDirectory() ? 'EISDIR' : 'FS_NOT_FILE', lst.isDirectory()
          ? `EISDIR: illegal operation on a directory, read '${display}'`
          : `"${display}" is not a regular file — reads are limited to regular files.`);
      }
      if (lst.size > READ_MAX_FILE_BYTES) {
        return fail('FS_TOO_LARGE', `File "${display}" is ${lst.size} bytes — the inspector reads files up to ${READ_MAX_FILE_BYTES} bytes (2 MiB) for preview/edit.`, 400);
      }
      const buf = fsSync.readFileSync(real);
      const textual = looksTextual(buf, true);
      const preview = buf.subarray(0, READ_PREVIEW_BYTES);
      return ok({
        root: '.',
        path: rel,
        name: nodePath.basename(real),
        mime: mimeishType(nodePath.basename(real)),
        textual,
        encoding: textual ? 'text' : 'base64',
        content: textual ? preview.toString('utf8') : preview.toString('base64'),
        truncated: lst.size > READ_PREVIEW_BYTES,
        size: lst.size,
      });
    }

    if (op === 'download') {
      // Multi-selection / folder → ZIP blob download.
      const pathsParam = url.searchParams.get('paths');
      if (pathsParam) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(pathsParam);
        } catch {
          return fail('INVALID_PARAMS', '"paths" must be a JSON array of path strings.', 400);
        }
        const zip = zipSelection(requirePathArray(parsed));
        return new Response(new Uint8Array(zip), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Length': String(zip.length),
            'Content-Disposition': 'attachment; filename="selection.zip"',
            'Cache-Control': 'no-store',
          },
        });
      }
      const lst = fsSync.lstatSync(real);
      if (lst.isDirectory()) {
        const zip = zipSelection([rawPath]);
        return new Response(new Uint8Array(zip), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Length': String(zip.length),
            'Content-Disposition': `attachment; filename="${(nodePath.basename(real) || 'folder').replace(/[^\w.\- ]+/g, '_')}.zip"`,
            'Cache-Control': 'no-store',
          },
        });
      }
      if (lst.isSymbolicLink() || !lst.isFile()) {
        throw new FsInspectorError('FS_NOT_FILE', `"${display}" is not a downloadable file.`);
      }
      const nodeStream = fsSync.createReadStream(real);
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': mimeishType(nodePath.basename(real)) || 'application/octet-stream',
          'Content-Length': String(lst.size),
          'Content-Disposition': `attachment; filename="${nodePath.basename(real).replace(/[^\w.\- ]+/g, '_')}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // op === 'stat' (also powers the info dialog with checksum when reasonable)
    const lst = fsSync.lstatSync(real);
    const kind: EntryKind | 'other' = lst.isSymbolicLink() ? 'link' : lst.isDirectory() ? 'dir' : lst.isFile() ? 'file' : 'other';
    let linkTarget: string | undefined;
    if (kind === 'link') {
      try {
        linkTarget = fsSync.readlinkSync(real);
      } catch {
        linkTarget = undefined;
      }
    }
    let checksum: string | undefined;
    let mime: string | undefined;
    if (kind === 'file' && lst.size <= CHECKSUM_MAX_FILE_BYTES) {
      try {
        checksum = sha256Hex(fsSync.readFileSync(real));
      } catch {
        checksum = undefined;
      }
      mime = mimeishType(nodePath.basename(real));
    }
    const perms = `0${(lst.mode & 0o777).toString(8)}`;
    return ok({
      root: '.',
      path: rel,
      entry: {
        name: rel === '' ? '.' : nodePath.basename(real),
        kind,
        size: kind === 'link' ? 0 : lst.size,
        createdAt: new Date(lst.birthtimeMs > 0 ? lst.birthtimeMs : lst.mtimeMs).toISOString(),
        updatedAt: new Date(lst.mtimeMs).toISOString(),
        environment: 'fs',
        ...(mime ? { mime } : {}),
        ...(checksum ? { checksum } : {}),
        ...(kind !== 'link' ? { permissions: perms } : {}),
        ...(linkTarget !== undefined ? { linkTarget } : {}),
      },
    });
  } catch (err) {
    return errResponse(err);
  }
}

// ---------------- POST (mutations) ----------------

const POST_OPS = new Set(['mkdir', 'write', 'rename', 'delete', 'copy', 'move', 'duplicate', 'zip', 'search', 'info']);

/** Post-op ZIP → returned as a file (attachment) or written to dest. */
function zipResponse(zip: Buffer, name: string, wroteTo?: string): Response {
  return new Response(new Uint8Array(zip), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]+/g, '_')}.zip"`,
      'Cache-Control': 'no-store',
      ...(wroteTo ? { 'X-Nexool-Zip-Path': wroteTo } : {}),
    },
  });
}

export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') ?? '';

  // ---- multipart upload ----
  if (contentType.includes('multipart/form-data')) {
    try {
      const form = await req.formData();
      const op = form.get('op');
      if (op !== 'upload') return fail('INVALID_PARAMS', 'Unsupported multipart op — use op=upload.', 400);
      const dest = requireDestDir(form.get('path'));
      const files = form.getAll('files').filter((f): f is File => f instanceof File);
      if (files.length === 0) return fail('INVALID_PARAMS', 'No files were uploaded ("files" field is empty).', 400);
      const results: { name: string; path: string; size: number; savedAs: string }[] = [];
      for (const file of files) {
        if (file.size > UPLOAD_MAX_FILE_BYTES) {
          throw new FsInspectorError('FS_TOO_LARGE', `"${file.name}" exceeds the ${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MiB per-file upload cap.`);
        }
        const buf = Buffer.from(await file.arrayBuffer());
        const safeName = nodePath.basename(file.name.replace(/\\/g, '/'));
        if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('\0')) {
          throw new FsInspectorError('INVALID_PARAMS', `"${file.name}" is not a valid file name.`);
        }
        const savedAs = uniqueName(dest.real, safeName);
        fsSync.writeFileSync(nodePath.join(dest.real, savedAs), buf);
        results.push({ name: safeName, path: nodePath.join(dest.rel, savedAs), size: buf.length, savedAs });
      }
      return ok({ uploaded: results.length, files: results });
    } catch (err) {
      return errResponse(err);
    }
  }

  // ---- JSON mutations ----
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail('INVALID_PARAMS', 'Request body must be valid JSON.', 400);
  }
  const op = body.op;
  if (typeof op !== 'string' || !POST_OPS.has(op)) {
    return fail('INVALID_PARAMS', `Unsupported op "${String(op)}" — use one of: ${[...POST_OPS].join(', ')}.`, 400);
  }

  try {
    switch (op) {
      case 'mkdir': {
        const target = resolveConfinedTarget(requireString(body.path, 'path'));
        if (fsSync.existsSync(target.real)) {
          throw new FsInspectorError('EEXIST', `"${displayPath(target.rel)}" already exists.`);
        }
        fsSync.mkdirSync(target.real, { recursive: true });
        return ok({ path: target.rel, created: true });
      }

      case 'write': {
        const target = resolveConfinedTarget(requireString(body.path, 'path'));
        const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
        const content = typeof body.content === 'string' ? body.content : '';
        const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
        if (data.length > WRITE_MAX_FILE_BYTES) {
          throw new FsInspectorError('FS_TOO_LARGE', `Write payload exceeds the ${WRITE_MAX_FILE_BYTES / (1024 * 1024)} MiB cap.`);
        }
        fsSync.mkdirSync(nodePath.dirname(target.real), { recursive: true });
        fsSync.writeFileSync(target.real, data);
        const st = fsSync.statSync(target.real);
        return ok({ path: target.rel, size: st.size, updatedAt: new Date(st.mtimeMs).toISOString(), saved: true });
      }

      case 'rename': {
        const source = resolveConfined(requireString(body.path, 'path'));
        const newName = requireName(body.newName);
        const target = resolveConfinedTarget(`${nodePath.dirname(source.real)}/${newName}`);
        if (fsSync.existsSync(target.real)) {
          throw new FsInspectorError('EEXIST', `"${newName}" already exists in this folder.`);
        }
        fsSync.renameSync(source.real, target.real);
        return ok({ path: target.rel, renamed: true });
      }

      case 'delete': {
        const results: { path: string; ok: boolean; code?: string; message?: string }[] = [];
        for (const p of requirePathArray(body.paths)) {
          try {
            const target = resolveConfined(p);
            if (displayPath(target.rel) === '.') {
              throw new FsInspectorError('FS_ACCESS', 'Refusing to delete the runtime working directory itself.');
            }
            fsSync.rmSync(target.real, { recursive: true, force: false });
            results.push({ path: displayPath(target.rel), ok: true });
          } catch (err) {
            results.push({
              path: String(p),
              ok: false,
              code: err instanceof FsInspectorError ? err.code : 'FS_ERROR',
              message: err instanceof Error ? err.message : 'delete failed',
            });
          }
        }
        return ok({ deleted: results.filter((r) => r.ok).length, results });
      }

      case 'copy':
      case 'move': {
        const destDir = requireDestDir(body.dest);
        const paths = requirePathArray(body.paths);
        const results: { from: string; to: string; ok: boolean; code?: string; message?: string }[] = [];
        for (const p of paths) {
          try {
            const source = resolveConfined(p);
            if (source.real === destDir.real) throw new FsInspectorError('EINVAL', 'Source and destination are the same folder.');
            if (op === 'move' && (destDir.real === source.real || destDir.real.startsWith(source.real + nodePath.sep))) {
              throw new FsInspectorError('EINVAL', 'Refusing to move a folder into itself or its descendant.');
            }
            const savedAs = uniqueName(destDir.real, nodePath.basename(source.real));
            const targetReal = nodePath.join(destDir.real, savedAs);
            if (op === 'copy') copyRecursiveSync(source.real, targetReal);
            else fsSync.renameSync(source.real, targetReal);
            results.push({ from: displayPath(source.rel), to: nodePath.join(destDir.rel, savedAs), ok: true });
          } catch (err) {
            results.push({
              from: String(p),
              to: displayPath(destDir.rel),
              ok: false,
              code: err instanceof FsInspectorError ? err.code : 'FS_ERROR',
              message: err instanceof Error ? err.message : `${op} failed`,
            });
          }
        }
        return ok({ [op === 'copy' ? 'copied' : 'moved']: results.filter((r) => r.ok).length, results });
      }

      case 'duplicate': {
        const results: { from: string; to: string; ok: boolean; code?: string; message?: string }[] = [];
        for (const p of requirePathArray(body.paths)) {
          try {
            const source = resolveConfined(p);
            const parentReal = nodePath.dirname(source.real);
            const savedAs = uniqueName(parentReal, nodePath.basename(source.real));
            copyRecursiveSync(source.real, nodePath.join(parentReal, savedAs));
            results.push({ from: displayPath(source.rel), to: `${nodePath.dirname(source.rel) === '' ? '.' : nodePath.dirname(source.rel)}/${savedAs}`, ok: true });
          } catch (err) {
            results.push({ from: String(p), to: '', ok: false, code: err instanceof FsInspectorError ? err.code : 'FS_ERROR', message: err instanceof Error ? err.message : 'duplicate failed' });
          }
        }
        return ok({ duplicated: results.filter((r) => r.ok).length, results });
      }

      case 'zip': {
        const paths = requirePathArray(body.paths);
        const zip = zipSelection(paths);
        // Optional dest folder → write the archive there; otherwise stream it back.
        if (typeof body.dest === 'string' && body.dest.trim()) {
          const destDir = requireDestDir(body.dest);
          const base = paths.length === 1 ? nodePath.basename(resolveConfined(paths[0]).real) || 'archive' : 'selection';
          const savedAs = uniqueName(destDir.real, `${base}.zip`);
          const target = resolveConfinedTarget(`${destDir.real}/${savedAs}`);
          fsSync.writeFileSync(target.real, zip);
          return ok({ path: target.rel, size: zip.length, written: true });
        }
        return zipResponse(zip, 'selection');
      }

      case 'search': {
        // v1.0.15 §30/§30.1 — ROOT CAUSE FIX for "path" must be a non-empty
        // string (INVALID_PARAMS): the FS Inspector LANDS on the real-FS root,
        // whose canonical relative path is '' — that is the ROOT, not a
        // missing value. An empty/missing path therefore means "search from
        // the current FS root/working directory" ('.') and must NEVER reach
        // the filesystem APIs as an empty string. §30.2 — an explicitly
        // invalid value (wrong type / whitespace-only) still gets a structured
        // validation error instead of a generic low-level throw.
        if (body.path !== undefined && body.path !== null && typeof body.path !== 'string') {
          throw new FsInspectorError('INVALID_PARAMS', '"path" must be a string.');
        }
        const rawSearchPath = typeof body.path === 'string' ? body.path.trim() : '';
        const start = resolveConfined(rawSearchPath === '' ? '.' : rawSearchPath);
        const query = requireString(body.query, 'query');
        const depth = typeof body.depth === 'number' && Number.isFinite(body.depth)
          ? Math.max(0, Math.min(SEARCH_MAX_DEPTH, Math.floor(body.depth)))
          : 5;
        const filesOnly = body.filesOnly === true;
        const foldersOnly = body.foldersOnly === true;
        const caseSensitive = body.caseSensitive === true;
        const needle = caseSensitive ? query : query.toLowerCase();
        const startReal = fsSync.statSync(start.real);
        if (!startReal.isDirectory()) {
          throw new FsInspectorError('ENOTDIR', `"${displayPath(start.rel)}" is not a directory.`);
        }
        const matches: { name: string; folder: string; path: string; kind: EntryKind; size?: number }[] = [];
        const walk = (dirReal: string, dirRel: string, level: number) => {
          if (level > depth || matches.length >= SEARCH_RESULT_CAP) return;
          let children: fsSync.Dirent[];
          try {
            children = fsSync.readdirSync(dirReal, { withFileTypes: true });
          } catch {
            return; // unreadable — skip, keep scanning siblings
          }
          for (const child of children) {
            if (matches.length >= SEARCH_RESULT_CAP) return;
            const childReal = nodePath.join(dirReal, child.name);
            const childRel = dirRel === '' ? child.name : `${dirRel}/${child.name}`;
            const kind = kindOf(child);
            const hay = caseSensitive ? child.name : child.name.toLowerCase();
            if (hay.includes(needle) && (!filesOnly || kind === 'file') && (!foldersOnly || kind === 'dir')) {
              let size: number | undefined;
              try {
                if (kind === 'file') size = fsSync.lstatSync(childReal).size;
              } catch { /* raced */ }
              matches.push({ name: child.name, folder: displayPath(dirRel), path: childRel, kind, ...(size !== undefined ? { size } : {}) });
            }
            if (kind === 'dir') walk(childReal, childRel, level + 1);
          }
        };
        walk(start.real, start.rel, 0);
        return ok({
          query,
          path: start.rel,
          depth,
          matched: matches.length,
          truncated: matches.length >= SEARCH_RESULT_CAP,
          matches,
        });
      }

      case 'info': {
        const target = resolveConfined(requireString(body.path, 'path'));
        const lst = fsSync.lstatSync(target.real);
        const kind: EntryKind | 'other' = lst.isSymbolicLink() ? 'link' : lst.isDirectory() ? 'dir' : lst.isFile() ? 'file' : 'other';
        let checksum: string | undefined;
        let mime: string | undefined;
        if (kind === 'file' && lst.size <= CHECKSUM_MAX_FILE_BYTES) {
          const buf = fsSync.readFileSync(target.real);
          checksum = sha256Hex(buf);
          mime = mimeishType(nodePath.basename(target.real));
        }
        return ok({
          path: target.rel,
          entry: {
            name: nodePath.basename(target.real) || '.',
            kind,
            size: kind === 'link' ? 0 : lst.size,
            createdAt: new Date(lst.birthtimeMs > 0 ? lst.birthtimeMs : lst.mtimeMs).toISOString(),
            updatedAt: new Date(lst.mtimeMs).toISOString(),
            environment: 'fs',
            permissions: `0${(lst.mode & 0o777).toString(8)}`,
            ...(mime ? { mime } : {}),
            ...(checksum ? { checksum } : {}),
          },
        });
      }

      default:
        return fail('INVALID_PARAMS', `Unhandled op "${String(op)}".`, 400);
    }
  } catch (err) {
    return errResponse(err);
  }
}

/** Recursive copy that NEVER follows directory symlinks (safe within cwd). */
function copyRecursiveSync(from: string, to: string): void {
  const st = fsSync.lstatSync(from);
  if (st.isSymbolicLink()) return; // do not copy links
  if (st.isDirectory()) {
    fsSync.mkdirSync(to, { recursive: true });
    for (const child of fsSync.readdirSync(from, { withFileTypes: true })) {
      copyRecursiveSync(nodePath.join(from, child.name), nodePath.join(to, child.name));
    }
    return;
  }
  if (st.isFile()) fsSync.copyFileSync(from, to);
}
