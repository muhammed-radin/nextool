/**
 * NexTool v1.0.13 §2 — FS Inspector: Virtual FS file manager (operator).
 *
 * GET  /api/inspector/vfs?path=/&op=list|read|stat|download[&paths=<json>]
 * POST /api/inspector/vfs            — JSON mutations: mkdir | write | rename |
 *                                      delete | copy | move | duplicate | zip |
 *                                      search | info
 * POST /api/inspector/vfs (multipart)— op=upload&path=/dest + files
 *
 * A full file-manager window into the GLOBAL shared Virtual FS (v1.0.12 §3)
 * used by the restricted node/js-function and MCP environments. Every
 * operation goes through the SAME secure path resolution the tools use
 * (normalizeVirtualPath + resolveSecure), so traversal (`..`, %2e%2e), NUL
 * bytes, host-path shapes and planted symlinks are rejected with the
 * documented VirtualFsError codes. The central configuration-limits.json
 * `vfs` limits stay the ONLY authority for sizes/counts — the inspector never
 * bypasses them (writes over budget fail with VFS_LIMIT, honestly).
 *
 * Responses to list/read/stat/download carry the live VFS `usage` snapshot so
 * the operator sees how much of the shared store the runtime is consuming.
 */
import fsSync from 'node:fs';
import nodePath from 'node:path';
import { ok, fail } from '@/lib/nexool/api-helpers';
import { getVfsRoot, normalizeVirtualPath, openGlobalVfs, VirtualFsError, VirtualFsSession } from '@/lib/nexool/tools/vfs';
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
import { mimeishType } from '@/lib/nexool/inspector/mime';
import { createZip } from '@/lib/nexool/tools/zip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type EntryKind = 'file' | 'dir';

function errorStatus(code: string): number {
  if (code === 'VFS_ACCESS') return 403;
  if (code === 'ENOENT') return 404;
  if (code === 'VFS_LIMIT') return 413;
  return 400;
}

function errResponse(err: unknown) {
  if (err instanceof VirtualFsError) {
    return fail(err.code, err.message, errorStatus(err.code));
  }
  return fail('FS_INSPECTOR_ERROR', err instanceof Error ? err.message : 'Unexpected Virtual FS failure.', 500);
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new VirtualFsError('INVALID_PARAMS', `"${field}" must be a non-empty string.`);
  }
  return v;
}

function requirePathArray(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new VirtualFsError('INVALID_PARAMS', '"paths" must be a non-empty array of path strings.');
  }
  return v as string[];
}

function requireName(v: unknown): string {
  const name = requireString(v, 'newName').trim();
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new VirtualFsError('INVALID_PARAMS', `"${name}" is not a valid file/folder name.`);
  }
  return name;
}

/** Parent dir of a normalized VFS path ('' for root-level → '/'). */
function parentOf(v: string): string {
  const idx = v.lastIndexOf('/');
  return idx <= 0 ? '/' : v.slice(0, idx);
}

function childOf(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** VFS-aware "name (copy)" collision policy (no fs.existsSync — use stat). */
function uniqueVfsName(vfs: VirtualFsSession, dir: string, name: string): string {
  if (!vfs.exists(childOf(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${i})${ext}`;
    if (!vfs.exists(childOf(dir, candidate))) return candidate;
  }
  throw new VirtualFsError('FS_ERROR', `Could not find a free name for "${name}".`);
}

/** Recursively collect VFS files (virtual paths) for archive building, capped. */
function collectVfsTree(vfs: VirtualFsSession, vpath: string, zipRoot: string, out: { vpath: string; zip: string }[], budget: { bytes: number }): void {
  if (out.length > 20000) throw new VirtualFsError('FS_TOO_LARGE', 'Selection too large (more than 20000 entries).');
  const st = vfs.stat(vpath);
  if (st.kind === 'file') {
    budget.bytes += st.size;
    if (budget.bytes > ZIP_MAX_TOTAL_BYTES) {
      throw new VirtualFsError('FS_TOO_LARGE', `Selection exceeds the ${ZIP_MAX_TOTAL_BYTES / (1024 * 1024)} MiB archive budget.`);
    }
    out.push({ vpath, zip: zipRoot });
    return;
  }
  const children = vfs.readdirWithTypes(vpath);
  if (children.length === 0) {
    out.push({ vpath: `${vpath}/`, zip: `${zipRoot}/` });
    return;
  }
  for (const child of children) {
    collectVfsTree(vfs, childOf(vpath, child.name), `${zipRoot}/${child.name}`, out, budget);
  }
}

// ---------------- GET ----------------

const GET_OPS = new Set(['list', 'read', 'stat', 'download']);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get('op') ?? 'list';
  const rawPath = url.searchParams.get('path') ?? '/';
  if (!GET_OPS.has(op)) {
    return fail('INVALID_PARAMS', `Unsupported op "${op}" — use one of: list, read, stat, download.`, 400);
  }

  const vfs = openGlobalVfs();

  try {
    const base = normalizeVirtualPath(rawPath);

    if (op === 'list') {
      const st = vfs.stat(base);
      if (st.kind !== 'dir') {
        throw new VirtualFsError('ENOTDIR', `ENOTDIR: '${base}' is not a directory — listing requires a directory path.`);
      }
      const raw = vfs.readdirWithTypes(base).slice(0, LIST_ENTRY_CAP);
      const entries = raw.map((entry) => {
        const childPath = childOf(base, entry.name);
        try {
          const meta = vfs.stat(childPath);
          return { name: entry.name, kind: entry.kind, size: meta.kind === 'file' ? meta.size : 0, updatedAt: meta.updatedAt };
        } catch {
          return { name: entry.name, kind: entry.kind, size: 0, updatedAt: undefined };
        }
      });
      return ok({ path: base, entries, usage: vfs.usage() });
    }

    if (op === 'read') {
      const st = vfs.stat(base);
      if (st.kind !== 'file') {
        throw new VirtualFsError(st.kind === 'dir' ? 'EISDIR' : 'FS_NOT_FILE', st.kind === 'dir'
          ? `EISDIR: illegal operation on a directory, read '${base}'`
          : `'${base}' is not a regular file.`);
      }
      if (st.size > READ_MAX_FILE_BYTES) {
        return fail('FS_TOO_LARGE', `File "${base}" is ${st.size} bytes — the inspector reads files up to ${READ_MAX_FILE_BYTES} bytes (2 MiB) for preview/edit.`, 400);
      }
      const buf = vfs.readFile(base, 'buffer') as Buffer;
      const textual = looksTextual(buf, true);
      const preview = buf.subarray(0, READ_PREVIEW_BYTES);
      return ok({
        path: base,
        name: base.slice(base.lastIndexOf('/') + 1) || base,
        mime: mimeishType(base),
        textual,
        encoding: textual ? 'text' : 'base64',
        content: textual ? preview.toString('utf8') : preview.toString('base64'),
        truncated: st.size > READ_PREVIEW_BYTES,
        size: st.size,
        usage: vfs.usage(),
      });
    }

    if (op === 'download') {
      const pathsParam = url.searchParams.get('paths');
      const targets = pathsParam
        ? requirePathArray(JSON.parse(pathsParam) as unknown).map((p) => normalizeVirtualPath(p))
        : [base];
      if (targets.length === 1 && vfs.stat(targets[0]).kind === 'file') {
        const buf = vfs.readFile(targets[0], 'buffer') as Buffer;
        const name = targets[0].slice(targets[0].lastIndexOf('/') + 1) || 'file';
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: {
            'Content-Type': mimeishType(name) || 'application/octet-stream',
            'Content-Length': String(buf.length),
            'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]+/g, '_')}"`,
            'Cache-Control': 'no-store',
          },
        });
      }
      // Folder or multi-selection → ZIP (hierarchy preserved, rooted per item).
      const budget = { bytes: 0 };
      const collected: { vpath: string; zip: string }[] = [];
      for (const t of targets) {
        const st = vfs.stat(t);
        const root = t === '/' ? 'vfs' : t.slice(t.lastIndexOf('/') + 1);
        collectVfsTree(vfs, t, root, collected, budget);
      }
      const inputs = collected.map((f) =>
        f.zip.endsWith('/')
          ? { path: f.zip.replace(/\/+$/, '') + '/', data: Buffer.alloc(0) }
          : { path: f.zip, data: vfs.readFile(f.vpath, 'buffer') as Buffer },
      );
      const zip = createZip(inputs);
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': String(zip.length),
          'Content-Disposition': `attachment; filename="${targets.length === 1 ? `${targets[0] === '/' ? 'vfs' : targets[0].slice(targets[0].lastIndexOf('/') + 1)}.zip` : 'selection.zip'}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // op === 'stat' (+ info-grade metadata when the entry is a file)
    const entry = vfs.stat(base);
    let checksum: string | undefined;
    let mime: string | undefined;
    if (entry.kind === 'file' && entry.size <= CHECKSUM_MAX_FILE_BYTES) {
      try {
        checksum = sha256Hex(vfs.readFile(base, 'buffer') as Buffer);
        mime = mimeishType(base);
      } catch {
        checksum = undefined;
      }
    }
    return ok({
      path: base,
      entry: {
        ...entry,
        name: base.slice(base.lastIndexOf('/') + 1) || '/',
        environment: 'vfs',
        ...(mime ? { mime } : {}),
        ...(checksum ? { checksum } : {}),
        ...(entry.kind === 'file' ? { permissions: 'virtual' } : {}),
      },
      usage: vfs.usage(),
    });
  } catch (err) {
    return errResponse(err);
  }
}

// ---------------- POST (mutations) ----------------

const POST_OPS = new Set(['mkdir', 'write', 'rename', 'delete', 'copy', 'move', 'duplicate', 'zip', 'search', 'info']);

export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') ?? '';

  // ---- multipart upload (device → VFS) ----
  if (contentType.includes('multipart/form-data')) {
    try {
      const form = await req.formData();
      if (form.get('op') !== 'upload') return fail('INVALID_PARAMS', 'Unsupported multipart op — use op=upload.', 400);
      const vfs = openGlobalVfs();
      const dest = normalizeVirtualPath(requireString(form.get('path'), 'path'));
      const destStat = vfs.stat(dest);
      if (destStat.kind !== 'dir') throw new VirtualFsError('ENOTDIR', `'${dest}' is not a directory.`);
      const files = form.getAll('files').filter((f): f is File => f instanceof File);
      if (files.length === 0) return fail('INVALID_PARAMS', 'No files were uploaded ("files" field is empty).', 400);
      const results: { name: string; path: string; size: number; savedAs: string }[] = [];
      for (const file of files) {
        if (file.size > UPLOAD_MAX_FILE_BYTES) {
          throw new VirtualFsError('FS_TOO_LARGE', `"${file.name}" exceeds the ${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MiB per-file upload cap.`);
        }
        const buf = Buffer.from(await file.arrayBuffer());
        const safeName = nodePath.basename(file.name.replace(/\\/g, '/'));
        if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('\0')) {
          throw new VirtualFsError('INVALID_PARAMS', `"${file.name}" is not a valid file name.`);
        }
        const savedAs = uniqueVfsName(vfs, dest, safeName);
        vfs.writeFile(childOf(dest, savedAs), buf);
        const meta = vfs.stat(childOf(dest, savedAs));
        results.push({ name: safeName, path: meta.path, size: meta.size, savedAs });
      }
      return ok({ uploaded: results.length, files: results, usage: vfs.usage() });
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

  const vfs = openGlobalVfs();

  try {
    switch (op) {
      case 'mkdir': {
        const target = normalizeVirtualPath(requireString(body.path, 'path'));
        if (vfs.exists(target)) throw new VirtualFsError('EEXIST', `'${target}' already exists.`);
        vfs.mkdir(target, { recursive: true });
        return ok({ path: vfs.stat(target).path, created: true, usage: vfs.usage() });
      }

      case 'write': {
        const target = normalizeVirtualPath(requireString(body.path, 'path'));
        const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
        const content = typeof body.content === 'string' ? body.content : '';
        const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
        if (data.length > WRITE_MAX_FILE_BYTES) {
          throw new VirtualFsError('FS_TOO_LARGE', `Write payload exceeds the ${WRITE_MAX_FILE_BYTES / (1024 * 1024)} MiB cap.`);
        }
        vfs.writeFile(target, data);
        const meta = vfs.stat(target);
        return ok({ path: meta.path, size: meta.size, updatedAt: meta.updatedAt, saved: true, usage: vfs.usage() });
      }

      case 'rename': {
        const source = vfs.stat(normalizeVirtualPath(requireString(body.path, 'path'))).path;
        const newName = requireName(body.newName);
        const target = childOf(parentOf(source), newName);
        if (vfs.exists(target)) throw new VirtualFsError('EEXIST', `'${newName}' already exists in this folder.`);
        vfs.rename(source, target);
        return ok({ path: vfs.stat(target).path, renamed: true, usage: vfs.usage() });
      }

      case 'delete': {
        const results: { path: string; ok: boolean; code?: string; message?: string }[] = [];
        for (const p of requirePathArray(body.paths)) {
          try {
            const target = normalizeVirtualPath(p);
            if (target === '/') throw new VirtualFsError('VFS_ACCESS', 'Refusing to delete the VFS root.');
            vfs.rm(target, { recursive: true, force: false });
            results.push({ path: target, ok: true });
          } catch (err) {
            results.push({
              path: String(p),
              ok: false,
              code: err instanceof VirtualFsError ? err.code : 'FS_ERROR',
              message: err instanceof Error ? err.message : 'delete failed',
            });
          }
        }
        return ok({ deleted: results.filter((r) => r.ok).length, results, usage: vfs.usage() });
      }

      case 'copy':
      case 'move': {
        const destDir = normalizeVirtualPath(requireString(body.dest, 'dest'));
        if (vfs.stat(destDir).kind !== 'dir') throw new VirtualFsError('ENOTDIR', `'${destDir}' is not a directory.`);
        const results: { from: string; to: string; ok: boolean; code?: string; message?: string }[] = [];
        for (const p of requirePathArray(body.paths)) {
          try {
            const source = vfs.stat(normalizeVirtualPath(p)).path;
            if (source === destDir) throw new VirtualFsError('EINVAL', 'Source and destination are the same folder.');
            if (op === 'move' && (destDir === source || destDir.startsWith(`${source}/`))) {
              throw new VirtualFsError('EINVAL', 'Refusing to move a folder into itself or its descendant.');
            }
            const savedAs = uniqueVfsName(vfs, destDir, source.slice(source.lastIndexOf('/') + 1));
            const target = childOf(destDir, savedAs);
            if (op === 'copy') vfs.copy(source, target);
            else vfs.rename(source, target);
            results.push({ from: source, to: target, ok: true });
          } catch (err) {
            results.push({
              from: String(p),
              to: destDir,
              ok: false,
              code: err instanceof VirtualFsError ? err.code : 'FS_ERROR',
              message: err instanceof Error ? err.message : `${op} failed`,
            });
          }
        }
        return ok({ [op === 'copy' ? 'copied' : 'moved']: results.filter((r) => r.ok).length, results, usage: vfs.usage() });
      }

      case 'duplicate': {
        const results: { from: string; to: string; ok: boolean; code?: string; message?: string }[] = [];
        for (const p of requirePathArray(body.paths)) {
          try {
            const source = vfs.stat(normalizeVirtualPath(p)).path;
            const savedAs = uniqueVfsName(vfs, parentOf(source), source.slice(source.lastIndexOf('/') + 1));
            const target = childOf(parentOf(source), savedAs);
            vfs.copy(source, target);
            results.push({ from: source, to: target, ok: true });
          } catch (err) {
            results.push({ from: String(p), to: '', ok: false, code: err instanceof VirtualFsError ? err.code : 'FS_ERROR', message: err instanceof Error ? err.message : 'duplicate failed' });
          }
        }
        return ok({ duplicated: results.filter((r) => r.ok).length, results, usage: vfs.usage() });
      }

      case 'zip': {
        const targets = requirePathArray(body.paths).map((p) => normalizeVirtualPath(p));
        for (const t of targets) vfs.stat(t); // validate existence
        const budget = { bytes: 0 };
        const collected: { vpath: string; zip: string }[] = [];
        for (const t of targets) {
          const root = t === '/' ? 'vfs' : t.slice(t.lastIndexOf('/') + 1);
          collectVfsTree(vfs, t, root, collected, budget);
        }
        const inputs = collected.map((f) =>
          f.zip.endsWith('/')
            ? { path: f.zip.replace(/\/+$/, '') + '/', data: Buffer.alloc(0) }
            : { path: f.zip, data: vfs.readFile(f.vpath, 'buffer') as Buffer },
        );
        const zip = createZip(inputs);
        if (typeof body.dest === 'string' && body.dest.trim()) {
          const destDir = normalizeVirtualPath(body.dest);
          if (vfs.stat(destDir).kind !== 'dir') throw new VirtualFsError('ENOTDIR', `'${destDir}' is not a directory.`);
          const base = targets.length === 1 ? (targets[0] === '/' ? 'vfs' : targets[0].slice(targets[0].lastIndexOf('/') + 1)) : 'selection';
          const savedAs = uniqueVfsName(vfs, destDir, `${base}.zip`);
          const target = childOf(destDir, savedAs);
          vfs.writeFile(target, zip);
          return ok({ path: vfs.stat(target).path, size: vfs.stat(target).size, written: true, usage: vfs.usage() });
        }
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

      case 'search': {
        // v1.0.15 §30/§30.1 — an empty/missing path means "search from the
        // VFS root" ('/') — never an INVALID_PARAMS from the default landing
        // state. Explicit wrong types are rejected with a structured error.
        if (body.path !== undefined && body.path !== null && typeof body.path !== 'string') {
          throw new VirtualFsError('INVALID_PARAMS', '"path" must be a string.');
        }
        const rawSearchPath = typeof body.path === 'string' ? body.path.trim() : '';
        const start = vfs.stat(normalizeVirtualPath(rawSearchPath === '' ? '/' : rawSearchPath)).path;
        const query = requireString(body.query, 'query');
        const depth = typeof body.depth === 'number' && Number.isFinite(body.depth)
          ? Math.max(0, Math.min(SEARCH_MAX_DEPTH, Math.floor(body.depth)))
          : 5;
        const filesOnly = body.filesOnly === true;
        const foldersOnly = body.foldersOnly === true;
        const caseSensitive = body.caseSensitive === true;
        if (filesOnly && foldersOnly) throw new VirtualFsError('INVALID_PARAMS', '"filesOnly" and "foldersOnly" are mutually exclusive.');
        const needle = caseSensitive ? query : query.toLowerCase();
        if (vfs.stat(start).kind !== 'dir') throw new VirtualFsError('ENOTDIR', `'${start}' is not a directory.`);
        const matches: { name: string; folder: string; path: string; kind: EntryKind; size?: number }[] = [];
        const walk = (dir: string, level: number) => {
          if (level > depth || matches.length >= SEARCH_RESULT_CAP) return;
          for (const entry of vfs.readdirWithTypes(dir)) {
            if (matches.length >= SEARCH_RESULT_CAP) return;
            const child = childOf(dir, entry.name);
            const hay = caseSensitive ? entry.name : entry.name.toLowerCase();
            if (hay.includes(needle) && (!filesOnly || entry.kind === 'file') && (!foldersOnly || entry.kind === 'dir')) {
              let size: number | undefined;
              try {
                const meta = vfs.stat(child);
                if (meta.kind === 'file') size = meta.size;
              } catch { /* raced */ }
              matches.push({ name: entry.name, folder: dir, path: child, kind: entry.kind, ...(size !== undefined ? { size } : {}) });
            }
            if (entry.kind === 'dir') walk(child, level + 1);
          }
        };
        walk(start, 0);
        return ok({
          query,
          path: start,
          depth,
          matched: matches.length,
          truncated: matches.length >= SEARCH_RESULT_CAP,
          matches,
          usage: vfs.usage(),
        });
      }

      case 'info': {
        const target = vfs.stat(normalizeVirtualPath(requireString(body.path, 'path'))).path;
        const entry = vfs.stat(target);
        let checksum: string | undefined;
        let mime: string | undefined;
        if (entry.kind === 'file' && entry.size <= CHECKSUM_MAX_FILE_BYTES) {
          try {
            checksum = sha256Hex(vfs.readFile(target, 'buffer') as Buffer);
            mime = mimeishType(target);
          } catch {
            checksum = undefined;
          }
        }
        return ok({
          path: target,
          entry: {
            name: target.slice(target.lastIndexOf('/') + 1) || '/',
            kind: entry.kind,
            size: entry.size,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            environment: 'vfs',
            permissions: entry.kind === 'file' ? 'virtual' : undefined,
            ...(mime ? { mime } : {}),
            ...(checksum ? { checksum } : {}),
          },
          usage: vfs.usage(),
        });
      }

      default:
        return fail('INVALID_PARAMS', `Unhandled op "${String(op)}".`, 400);
    }
  } catch (err) {
    return errResponse(err);
  }
}

// Silence unused warnings for helpers kept for parity with the fs route.
void getVfsRoot;
void fsSync;
