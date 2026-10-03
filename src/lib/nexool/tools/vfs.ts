/**
 * NexTool v1.0.8 — Virtual File System for tool workspaces (spec §2.1–§2.9, v1.0.8 §5/§16).
 *
 * A REAL, persistent filesystem that belongs to the tool runtime — NOT the
 * NexTool project. Backed by the `VirtualFile` SQLite table (never the host
 * filesystem), one isolated workspace per tool:
 *
 *   /input  /output  /tmp  /data  /workspace   (created on first use)
 *
 * Guarantees:
 *  - `require("fs")` / `import fs from "fs"` inside the nodejs sandbox resolve
 *    to THIS module (§2.4) — host `fs` is unreachable from tool code.
 *  - Every path is decoded, normalized and validated (§2.6): `..` traversal,
 *    encoded traversal (%2e%2e), NUL bytes, absolute host paths, URL file:
 *    paths and symlink-style escapes are all rejected with a clear error.
 *  - Files are actually stored and retrieved (§2.7) with create/read/update/
 *    delete/list/rename/copy/metadata support and real safety limits (§2.9).
 *  - Lifecycle (§2.8): storage is PERSISTENT PER TOOL and isolated per tool;
 *    each execution loads a workspace snapshot and writes through to the
 *    database. Concurrent executions of the same tool are last-write-wins
 *    (documented).
 *
 * v1.0.8 (§5/§16): ALL limits are resolved dynamically from the central
 * configuration (config/configuration-limits.json via getVfsLimits()) —
 * the implementation contains NO hard-coded size/count/depth constants.
 * New defaults: file 2 MiB, total 700 MiB, 4000 entries, depth 56.
 * A lowered limit never corrupts or deletes existing files (§5.4): new
 * operations that violate the limit fail clearly instead.
 */

import { db } from '@/lib/db';
import { getResolvedLimits, type ResolvedRuntimeLimits } from '../config-limits';

export type VfsLimits = ResolvedRuntimeLimits['vfs'];

/**
 * §5.2/§16 — resolve the CURRENT Virtual FS limits from the central
 * configuration at every enforcement point. Self-hosted limit edits apply to
 * new operations without a rebuild (§5.3); there is deliberately no cached
 * snapshot that could keep enforcing stale values.
 */
export function getVfsLimits(): VfsLimits {
  return getResolvedLimits().vfs;
}

/** §2.9 — documented DEFAULT limits (shipped values, informational). Kept for
 *  backwards compatibility — enforcement always uses getVfsLimits(). */
export const VFS_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 700 * 1024 * 1024,
  maxFileCount: 4000,
  maxPathLength: 512,
  maxDepth: 56,
} as const;

/** §2.1 — the standard workspace scaffold, created on first use. */
export const VFS_WORKSPACE_DIRECTORIES = ['/input', '/output', '/tmp', '/data', '/workspace'] as const;

export interface VfsEntryMeta {
  path: string;
  kind: 'file' | 'dir';
  size: number;
  createdAt: string;
  updatedAt: string;
}

export class VirtualFsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code === 'VFS_ACCESS' ? 'VirtualFSAccessError' : 'VirtualFsError';
    this.code = code;
  }
}

/** §2.5 — escape attempts get the documented error, never a silent redirect. */
export function hostAccessError(detail?: string): VirtualFsError {
  return new VirtualFsError(
    'VFS_ACCESS',
    `VirtualFSAccessError: Access to the NexTool host filesystem is not permitted.${detail ? ` (${detail})` : ''}`,
  );
}

interface StoredEntry {
  kind: 'file' | 'dir';
  /** 'utf8' | 'base64' */
  encoding: string;
  content: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function normalizeVirtualPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new VirtualFsError('EINVAL', 'Path must be a non-empty string.');
  }
  if (input.includes('\0')) {
    throw hostAccessError('NUL byte in path');
  }
  let raw = input;
  // Encoded traversal (§2.6) — decode before validating.
  if (/%2e|%2f|%5c|%00/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      throw hostAccessError('malformed percent-encoding');
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || raw.startsWith('file:')) {
    throw hostAccessError('URL filesystem paths are not permitted');
  }
  if (raw.includes('\\')) {
    throw hostAccessError('backslash paths are not permitted');
  }
  const limits = getVfsLimits(); // §5.2 — dynamic, never hard-coded
  const absolute = raw.startsWith('/');
  const segments = raw.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (out.length === 0) {
        // `..` beyond the virtual root — an escape attempt, not a redirect.
        throw hostAccessError(`path traversal "${raw}"`);
      }
      out.pop();
      continue;
    }
    if (out.length >= limits.maxDepth) {
      throw new VirtualFsError('VFS_LIMIT', `Path exceeds the maximum depth of ${limits.maxDepth}.`);
    }
    out.push(seg);
  }
  const normalized = '/' + out.join('/');
  if (normalized.length > limits.maxPathLength) {
    throw new VirtualFsError('VFS_LIMIT', `Path exceeds the maximum length of ${limits.maxPathLength} characters.`);
  }
  return normalized === '//' ? '/' : normalized;
}

/** One tool workspace session — in-memory snapshot with write-through persistence. */
export class VirtualFsSession {
  readonly toolId: string;
  private entries = new Map<string, StoredEntry>();
  private totalBytes = 0;

  private constructor(toolId: string) {
    this.toolId = toolId;
  }

  static async load(toolId: string): Promise<VirtualFsSession> {
    const session = new VirtualFsSession(toolId);
    try {
      const rows = await db.virtualFile.findMany({
        where: { toolId },
        orderBy: { path: 'asc' },
        // §5.4 — load MORE than the configured cap so pre-existing entries
        // stay visible/readable even when an administrator lowers maxEntries.
        take: Math.max(getVfsLimits().maxEntries * 2, 1000),
      });
      for (const row of rows) {
        session.entries.set(row.path, {
          kind: row.kind === 'dir' ? 'dir' : 'file',
          encoding: row.encoding,
          content: row.content,
          size: row.size,
          createdAt: row.createdAt.getTime(),
          updatedAt: row.updatedAt.getTime(),
        });
        if (row.kind !== 'dir') session.totalBytes += row.size;
      }
    } catch (err) {
      console.error(`[vfs] snapshot load failed for ${toolId}:`, err);
    }
    await session.ensureWorkspaceScaffold();
    return session;
  }

  /** §2.1 — the standard workspace scaffold, created on first use. */
  async ensureWorkspaceScaffold(): Promise<void> {
    for (const dir of VFS_WORKSPACE_DIRECTORIES) {
      if (!this.entries.has(dir)) {
        this.entries.set(dir, { kind: 'dir', encoding: 'utf8', content: '', size: 0, createdAt: Date.now(), updatedAt: Date.now() });
        void this.persist(dir).catch(() => {});
      }
    }
  }

  // ---------- persistence (write-through, best effort) ----------

  private async persist(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry) return;
    try {
      await db.virtualFile.upsert({
        where: { toolId_path: { toolId: this.toolId, path } },
        update: { kind: entry.kind, encoding: entry.encoding, content: entry.content, size: entry.size },
        create: { toolId: this.toolId, path, kind: entry.kind, encoding: entry.encoding, content: entry.content, size: entry.size },
      });
    } catch (err) {
      console.error(`[vfs] persist failed for ${this.toolId}:${path}:`, err);
    }
  }

  private async remove(path: string): Promise<void> {
    try {
      await db.virtualFile.deleteMany({ where: { toolId: this.toolId, path } });
    } catch (err) {
      console.error(`[vfs] remove failed for ${this.toolId}:${path}:`, err);
    }
  }

  // ---------- lookups ----------

  private isImplicitDir(path: string): boolean {
    if (path === '/') return true;
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  exists(path: string): boolean {
    const p = normalizeVirtualPath(path);
    if (p === '/') return true;
    const entry = this.entries.get(p);
    if (entry) return true;
    return this.isImplicitDir(p);
  }

  stat(path: string): VfsEntryMeta {
    const p = normalizeVirtualPath(path);
    if (p === '/') return { path: '/', kind: 'dir', size: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const entry = this.entries.get(p);
    if (entry) return { path: p, kind: entry.kind, size: entry.size, createdAt: new Date(entry.createdAt).toISOString(), updatedAt: new Date(entry.updatedAt).toISOString() };
    if (this.isImplicitDir(p)) {
      return { path: p, kind: 'dir', size: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    }
    throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
  }

  lstat(path: string): VfsEntryMeta {
    return this.stat(path); // no symlinks exist inside the VFS (§2.6)
  }

  realpath(path: string): string {
    const p = normalizeVirtualPath(path); // throws on traversal — §2.6
    if (!this.exists(p)) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, realpath '${path}'`);
    }
    return p;
  }

  // ---------- reads ----------

  readFile(path: string, encoding?: string): string | Buffer {
    const p = normalizeVirtualPath(path);
    const entry = this.entries.get(p);
    if (!entry || entry.kind !== 'file') {
      if (entry?.kind === 'dir' || this.isImplicitDir(p)) {
        throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
      }
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    }
    // §5.4 — reads of PRE-EXISTING larger files are never corrupted by a
    // lowered limit; the read cap is the configured per-file maximum.
    const limits = getVfsLimits();
    if (entry.size > limits.maxFileBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: file exceeds the maximum read size of ${limits.maxFileBytes} bytes (configured vfs.maxFileBytes).`);
    }
    const buf = entry.encoding === 'base64' ? Buffer.from(entry.content, 'base64') : Buffer.from(entry.content, 'utf8');
    if (!encoding || encoding === 'buffer') return buf;
    return buf.toString(encoding as BufferEncoding);
  }

  readdir(path: string): string[] {
    const p = normalizeVirtualPath(path);
    if (!this.exists(p) || (!this.entries.get(p) && !this.isImplicitDir(p))) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, scandir '${path}'`);
    }
    const prefix = p === '/' ? '/' : `${p}/`;
    const names = new Set<string>();
    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix) || key === p) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      names.add(rest.split('/')[0]);
    }
    return [...names].sort();
  }

  readdirWithTypes(path: string): { name: string; kind: 'file' | 'dir' }[] {
    return this.readdir(path).map((name) => {
      const full = (path === '/' ? '' : normalizeVirtualPath(path)) + '/' + name;
      const entry = this.entries.get(full);
      return { name, kind: entry?.kind === 'file' ? 'file' as const : 'dir' as const };
    });
  }

  // ---------- writes ----------

  private assertCanStore(bytes: number, replacingBytes = 0): void {
    const limits = getVfsLimits(); // §5.2 — resolved at every write
    if (this.entries.size + 1 > limits.maxEntries) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: at most ${limits.maxEntries} entries per tool workspace are allowed.`);
    }
    if (bytes > limits.maxFileBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: file exceeds the maximum size of ${limits.maxFileBytes} bytes.`);
    }
    if (this.totalBytes - replacingBytes + bytes > limits.maxTotalBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: workspace exceeds the maximum total size of ${limits.maxTotalBytes} bytes.`);
    }
  }

  writeFile(path: string, data: string | Buffer | Uint8Array, encoding?: string): void {
    const p = normalizeVirtualPath(path);
    if (p === '/') throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, open '${path}'`);
    const buf = Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength) : Buffer.from(String(data), 'utf8');
    if (buf.length > getVfsLimits().maxFileBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: write exceeds the maximum file size of ${getVfsLimits().maxFileBytes} bytes.`);
    }
    const existing = this.entries.get(p);
    if (existing?.kind === 'dir') {
      throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, open '${path}'`);
    }
    this.assertCanStore(buf.length, existing?.size ?? 0);
    // writeFile creates missing parent directories implicitly (documented).
    // utf8 storage only when the bytes survive a utf8 round trip losslessly.
    const useBase64 = encoding === 'base64' || !buf.equals(Buffer.from(buf.toString('utf8'), 'utf8'));
    this.entries.set(p, {
      kind: 'file',
      encoding: useBase64 ? 'base64' : 'utf8',
      content: useBase64 ? buf.toString('base64') : buf.toString('utf8'),
      size: buf.length,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    if (!existing) this.totalBytes += buf.length;
    else this.totalBytes = this.totalBytes - existing.size + buf.length;
    void this.persist(p);
  }

  appendFile(path: string, data: string | Buffer | Uint8Array): void {
    const p = normalizeVirtualPath(path);
    const existing = this.entries.get(p);
    if (!existing || existing.kind !== 'file') {
      this.writeFile(p, data);
      return;
    }
    const prev = existing.encoding === 'base64' ? Buffer.from(existing.content, 'base64') : Buffer.from(existing.content, 'utf8');
    const add = Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength) : Buffer.from(String(data), 'utf8');
    this.writeFile(p, Buffer.concat([prev, add]));
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    const p = normalizeVirtualPath(path);
    if (p === '/') return;
    const recursive = options?.recursive === true;
    if (this.entries.get(p)?.kind === 'file') {
      throw new VirtualFsError('EEXIST', `EEXIST: file already exists, mkdir '${path}'`);
    }
    if (this.exists(p)) {
      if (recursive) return;
      throw new VirtualFsError('EEXIST', `EEXIST: file already exists, mkdir '${path}'`);
    }
    const parents: string[] = [];
    let cursor = parentOf(p);
    while (cursor !== '/' && !this.exists(cursor)) {
      parents.unshift(cursor);
      cursor = parentOf(cursor);
    }
    if (!recursive && parents.length > 0) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, mkdir '${path}'`);
    }
    for (const dir of [...parents, p]) {
      this.entries.set(dir, { kind: 'dir', encoding: 'utf8', content: '', size: 0, createdAt: Date.now(), updatedAt: Date.now() });
      void this.persist(dir);
    }
  }

  unlink(path: string): void {
    const p = normalizeVirtualPath(path);
    const entry = this.entries.get(p);
    if (!entry) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, unlink '${path}'`);
    }
    if (entry.kind === 'dir') {
      throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, unlink '${path}' — use rm with recursive.`);
    }
    this.entries.delete(p);
    this.totalBytes -= entry.size;
    void this.remove(p);
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const p = normalizeVirtualPath(path);
    if (p === '/') throw hostAccessError('refusing to remove the workspace root');
    const entry = this.entries.get(p);
    if (!entry && !this.isImplicitDir(p)) {
      if (options?.force) return;
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, rm '${path}'`);
    }
    const isDir = !entry || entry.kind === 'dir';
    const prefix = `${p}/`;
    const children = [...this.entries.keys()].filter((k) => k.startsWith(prefix));
    if (isDir && children.length > 0 && options?.recursive !== true) {
      throw new VirtualFsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rm '${path}' — pass { recursive: true }.`);
    }
    for (const child of children) {
      const e = this.entries.get(child);
      if (e && e.kind === 'file') this.totalBytes -= e.size;
      this.entries.delete(child);
      void this.remove(child);
    }
    if (entry) {
      if (entry.kind === 'file') this.totalBytes -= entry.size;
      this.entries.delete(p);
      void this.remove(p);
    }
  }

  rename(oldPath: string, newPath: string): void {
    const from = normalizeVirtualPath(oldPath);
    const to = normalizeVirtualPath(newPath);
    const entry = this.entries.get(from);
    if (!entry && !this.isImplicitDir(from)) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`);
    }
    if (to.startsWith(from === '/' ? '/' : `${from}/`)) {
      throw new VirtualFsError('EINVAL', `EINVAL: cannot move a directory into itself, rename '${oldPath}' -> '${newPath}'`);
    }
    const prefix = `${from}/`;
    const children = [...this.entries.entries()].filter(([k]) => k.startsWith(prefix));
    const target = this.entries.get(to);
    if (target?.kind === 'file' || (children.length > 0 && target)) {
      throw new VirtualFsError('ENOTEMPTY', `ENOTEMPTY: destination already exists, rename '${oldPath}' -> '${newPath}'`);
    }
    for (const [k, v] of children) {
      this.entries.delete(k);
      const nextPath = to + k.slice(from.length);
      this.entries.set(nextPath, v);
      void this.remove(k);
      void this.persist(nextPath);
    }
    if (entry) {
      this.entries.delete(from);
      this.entries.set(to, entry);
      void this.remove(from);
      void this.persist(to);
    }
  }

  copy(from: string, to: string): void {
    const src = normalizeVirtualPath(from);
    const dst = normalizeVirtualPath(to);
    const entry = this.entries.get(src);
    if (!entry && !this.isImplicitDir(src)) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, copy '${from}' -> '${to}'`);
    }
    const prefix = `${src}/`;
    const children = [...this.entries.entries()].filter(([k]) => k.startsWith(prefix));
    if (entry?.kind === 'file') {
      this.writeFile(dst, this.readFile(src) as Buffer);
      return;
    }
    // directory copy (recursive by definition)
    if (this.entries.get(dst)?.kind === 'file') {
      throw new VirtualFsError('ENOTDIR', `ENOTDIR: destination is a file, copy '${from}' -> '${to}'`);
    }
    if (!this.exists(dst)) this.mkdir(dst, { recursive: true });
    for (const [k, v] of children) {
      const nextPath = dst + k.slice(src.length);
      if (v.kind === 'file') {
        this.writeFile(nextPath, this.readFile(k) as Buffer);
      } else if (!this.exists(nextPath)) {
        this.mkdir(nextPath, { recursive: true });
      }
    }
  }

  // ---------- metadata (§2.7) ----------

  listAll(): VfsEntryMeta[] {
    return [...this.entries.values()]
      .map((e, i) => ({ path: [...this.entries.keys()][i], kind: e.kind, size: e.size, createdAt: new Date(e.createdAt).toISOString(), updatedAt: new Date(e.updatedAt).toISOString() }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  usage(): { usedBytes: number; files: number; limits: VfsLimits } {
    // §16 — reported limits are the CURRENT configured values.
    return { usedBytes: this.totalBytes, files: [...this.entries.values()].filter((e) => e.kind === 'file').length, limits: getVfsLimits() };
  }

  // ---------- sync helpers (power require() and fs.*Sync) ----------

  readFileSync(path: string, encoding?: string): string | Buffer {
    return this.readFile(path, encoding);
  }

  writeFileSync(path: string, data: string | Buffer | Uint8Array): void {
    this.writeFile(path, data);
  }

  existsSync(path: string): boolean {
    return this.exists(path);
  }
}

/** Load (and lazily scaffold) a tool's persistent workspace. */
export async function openVirtualFs(toolId: string): Promise<VirtualFsSession> {
  return VirtualFsSession.load(toolId);
}
