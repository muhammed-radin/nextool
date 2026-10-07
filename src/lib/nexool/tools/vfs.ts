/**
 * NexTool v1.0.12 — GLOBAL SHARED Virtual File System (Phase 3, spec §3.1–§3.13).
 *
 * ONE persistent VFS owned by the NexTool RUNTIME — no longer by an individual
 * tool (v1.0.12 §3.12 removed the per-tool VFS architecture). Every tool that
 * runs in a restricted environment (`js-function`, `nodejs`) receives THE SAME
 * session, so files written by one tool are visible to every other tool and
 * to later executions/tasks (§3.3/§3.4).
 *
 * Storage is the REAL filesystem under one authoritative host root
 * (the real `VFS/` directory, §3.6/v1.0.14 §24) — never process memory — so the tree survives
 * application restarts and deployments that persist the working directory
 * (§3.5). The host path is an implementation detail: restricted tool code
 * only ever sees VIRTUAL absolute paths whose root is `/`.
 *
 * Security model (§3.2/§3.7/§3.8):
 *  - The VFS ROOT is the isolation boundary. Everything under it is shared;
 *    nothing outside it is reachable from restricted tool code.
 *  - Every path is decoded, normalized and validated: `..` traversal,
 *    encoded traversal (%2e%2e), NUL bytes, backslashes, URL `file:` paths,
 *    Windows drive letters and absolute HOST paths (the host cwd prefix) are
 *    rejected with the documented VirtualFSAccessError.
 *  - Symlinks can never become an escape route: every operation walks its
 *    path component-by-component with lstat() and REFUSES to traverse any
 *    symbolic link planted inside the root (e.g. by a freedom-node tool or a
 *    host operator). Operations never follow links out of the root.
 *  - Limits stay authoritative in the central configuration
 *    (config/configuration-limits.json via getVfsLimits(), §3.9/§5.2 of
 *    v1.0.8): max file size, max total size, max entries, max depth, max path
 *    length are resolved live at every enforcement point. With ONE shared
 *    store these caps now apply to the WHOLE VFS (not per tool).
 *
 * `freedom-node` is EXEMPT (§3.10): it does not touch this service at all and
 * keeps complete host freedom (v1.0.11 §23/§31).
 *
 * Compatibility: the historical exports (normalizeVirtualPath, VirtualFsError,
 * VirtualFsSession, openVirtualFs, getVfsLimits, VFS_LIMITS,
 * VFS_WORKSPACE_DIRECTORIES) keep their names and shapes. `openVirtualFs()`
 * is now SYNCHRONOUS (await-ed call sites keep working) and ignores the
 * legacy per-tool id — all callers receive the same shared session.
 */

import fsSync from 'node:fs';
import nodePath from 'node:path';
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

/**
 * v1.0.14 §24 — the LEGACY VFS root (pre-v1.0.14 releases stored the real
 * directory under data/vfs). Migrated once, automatically, on first VFS use:
 * detect existing data → move it into the real VFS/ root → verify → switch.
 * Existing files are preserved (never deleted) and the migration is logged
 * as a runtime event trail via console (see docs/vfs.md).
 */
const LEGACY_VFS_ROOT = nodePath.resolve(process.cwd(), 'data', 'vfs');

function migrateLegacyVfsRoot(): void {
  const root = getVfsRoot();
  let legacyEntries: string[] = [];
  try {
    legacyEntries = fsSync.readdirSync(LEGACY_VFS_ROOT);
  } catch {
    return; // no legacy root — nothing to migrate (fresh install)
  }
  // root already migrated / in use → never touch anything
  if (fsSync.existsSync(root)) {
    const existing = fsSync.readdirSync(root);
    if (existing.length > 0) {
      if (legacyEntries.length > 0) {
        console.warn(`[vfs] legacy data/vfs still exists alongside the active VFS/ root — left untouched (no data deleted).`);
      }
      return;
    }
  }
  if (legacyEntries.length === 0) {
    // legacy scaffold only (no user data) — just remove the empty legacy dir
    try { fsSync.rmdirSync(LEGACY_VFS_ROOT); } catch { /* non-fatal */ }
    return;
  }
  try {
    fsSync.mkdirSync(root, { recursive: true });
    let moved = 0;
    for (const entry of legacyEntries) {
      const from = nodePath.join(LEGACY_VFS_ROOT, entry);
      const to = nodePath.join(root, entry);
      if (fsSync.existsSync(to)) continue; // never overwrite existing files
      fsSync.renameSync(from, to);
      moved += 1;
    }
    console.log(`[vfs] v1.0.14 migration: moved ${moved} entr${moved === 1 ? 'y' : 'ies'} from data/vfs to the real VFS/ root.`);
    // remove the now-empty legacy directory (best-effort)
    try {
      const rest = fsSync.readdirSync(LEGACY_VFS_ROOT);
      if (rest.length === 0) fsSync.rmdirSync(LEGACY_VFS_ROOT);
    } catch { /* non-fatal */ }
  } catch (err) {
    console.error('[vfs] legacy VFS migration failed (existing data/vfs preserved):', err);
  }
}

/**
 * §3.6 / v1.0.14 §24 — the ONE authoritative host root of the shared VFS:
 * the REAL directory `VFS/` inside the project storage root. It is a genuine
 * host filesystem directory with a sandbox boundary imposed around it —
 * NOT a simulated store. Lives next to the other persistent runtime data
 * (db/); deployment storage that persists the working directory persists
 * the VFS. Never exposed to restricted tool code.
 */
export function getVfsRoot(): string {
  return nodePath.resolve(process.cwd(), 'VFS');
}

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

/**
 * §3.7 — normalize a VIRTUAL path and reject every escape shape BEFORE it can
 * touch the disk. Returns a virtual absolute path rooted at `/`; never a host
 * path. Encoded traversal is decoded first, so `%2e%2e` cannot slip through.
 */
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
  // §3.7 — Windows drive-letter absolute paths are HOST paths.
  if (/^[a-zA-Z]:\//.test(raw)) {
    throw hostAccessError(`absolute host path "${input}"`);
  }
  const limits = getVfsLimits(); // §5.2 — dynamic, never hard-coded
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
  // §3.7 — an absolute HOST path (the runtime working directory prefix) must
  // never round-trip into the VFS: reject it instead of creating a same-named
  // virtual folder that could shadow/confuse host locations.
  const hostCwdVirtual = '/' + process.cwd().split(/[\\/]+/).filter(Boolean).join('/');
  if (normalized === hostCwdVirtual || normalized.startsWith(`${hostCwdVirtual}/`)) {
    throw hostAccessError(`absolute host path "${input}"`);
  }
  return normalized === '//' ? '/' : normalized;
}

/** The shared session label kept for legacy diagnostics (§3.12: one VFS). */
const SHARED_SESSION_LABEL = '__global_shared_vfs__';

/**
 * §3.13 — the GLOBAL VFS service. One instance (per process) serves EVERY
 * restricted tool; all state lives on disk under the VFS root, so a fresh
 * service object (or a full application restart) resumes the same tree.
 */
export class VirtualFsSession {
  /** Test/instance seam — the private constructor is only reachable here. */
  static createFresh(): VirtualFsSession {
    return new VirtualFsSession(getVfsRoot());
  }

  /** Legacy per-tool id field — always the shared label since v1.0.12. */
  readonly toolId: string;
  /** Host root (resolved). Internal — never surfaced to restricted tools. */
  private readonly rootReal: string;

  private constructor(root: string) {
    this.toolId = SHARED_SESSION_LABEL;
    this.rootReal = root;
    fsSync.mkdirSync(this.rootReal, { recursive: true });
    // Defend against a planted root symlink: pin the boundary to the REAL
    // location the root resolves to.
    try {
      this.rootReal = fsSync.realpathSync(this.rootReal);
    } catch {
      /* mkdir just created it — realpath must exist */
    }
    this.ensureWorkspaceScaffold();
  }

  /** §2.1 — the standard workspace scaffold, created on first use. */
  ensureWorkspaceScaffold(): void {
    for (const dir of VFS_WORKSPACE_DIRECTORIES) {
      try {
        fsSync.mkdirSync(this.hostPathOf(dir), { recursive: true });
      } catch (err) {
        console.error(`[vfs] scaffold failed for ${dir}:`, err);
      }
    }
  }

  // ---------- §3.8 security: secure host-path resolution ----------

  private hostPathOf(virtualPath: string): string {
    const v = normalizeVirtualPath(virtualPath);
    return v === '/' ? this.rootReal : nodePath.join(this.rootReal, v.slice(1));
  }

  /**
   * Walk the path component-by-component from the REAL root. Any component
   * that exists as a symbolic link is REFUSED (a planted symlink must never
   * become an escape route, §3.8). Missing components are allowed only at the
   * tail — a real filesystem cannot have entries below a missing directory,
   * and (unlike a link) a missing name cannot resolve elsewhere.
   */
  private resolveSecure(input: string): string {
    const v = normalizeVirtualPath(input);
    if (v === '/') return this.rootReal;
    let cur = this.rootReal;
    const segs = v.slice(1).split('/');
    for (let i = 0; i < segs.length; i++) {
      cur = nodePath.join(cur, segs[i]);
      let st: fsSync.Stats;
      try {
        st = fsSync.lstatSync(cur);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Nothing at/below this component exists on disk — return the
          // remaining joined path; the actual operation will report ENOENT.
          return nodePath.join(cur, ...segs.slice(i + 1));
        }
        throw new VirtualFsError(code ?? 'EIO', `${code ?? 'EIO'}: cannot access '${input}'`);
      }
      if (st.isSymbolicLink()) {
        throw hostAccessError(`symbolic link "${segs.slice(0, i + 1).join('/')}" inside the VFS is not permitted`);
      }
    }
    return cur;
  }

  private isDirHost(host: string): boolean {
    try {
      return fsSync.statSync(host).isDirectory();
    } catch {
      return false;
    }
  }

  // ---------- lookups ----------

  exists(path: string): boolean {
    try {
      const host = this.resolveSecure(path);
      return fsSync.existsSync(host);
    } catch {
      // Traversal/symlink/host-path attempts report "does not exist" for a
      // plain boolean probe — the throwing APIs carry the detailed error.
      return false;
    }
  }

  private toMeta(virtualPath: string, st: fsSync.Stats): VfsEntryMeta {
    const created = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    return {
      path: virtualPath,
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(st.mtimeMs).toISOString(),
    };
  }

  stat(path: string): VfsEntryMeta {
    const v = normalizeVirtualPath(path);
    const host = this.resolveSecure(path);
    let st: fsSync.Stats;
    try {
      st = fsSync.statSync(host);
    } catch {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
    }
    return this.toMeta(v, st);
  }

  lstat(path: string): VfsEntryMeta {
    // No symlink ever resolves inside the VFS (§3.8) — lstat === stat.
    return this.stat(path);
  }

  realpath(path: string): string {
    const v = normalizeVirtualPath(path); // throws on traversal — §3.7
    if (!this.exists(v)) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, realpath '${path}'`);
    }
    return v; // the VIRTUAL path is the truth tools are allowed to see
  }

  // ---------- reads ----------

  readFile(path: string, encoding?: string): string | Buffer {
    const host = this.resolveSecure(path);
    let st: fsSync.Stats;
    try {
      st = fsSync.lstatSync(host);
    } catch {
      if (this.isDirHost(host)) {
        throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
      }
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, open '${path}'`);
    }
    if (st.isDirectory()) {
      throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`);
    }
    // §5.4 — reads of PRE-EXISTING larger files are never corrupted by a
    // lowered limit; the read cap is the configured per-file maximum.
    const limits = getVfsLimits();
    if (st.size > limits.maxFileBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: file exceeds the maximum read size of ${limits.maxFileBytes} bytes (configured vfs.maxFileBytes).`);
    }
    const buf = fsSync.readFileSync(host);
    if (!encoding || encoding === 'buffer') return buf;
    return buf.toString(encoding as BufferEncoding);
  }

  readdir(path: string): string[] {
    const host = this.resolveSecure(path);
    if (!fsSync.existsSync(host)) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (!this.isDirHost(host)) {
      // Old per-tool behavior: a file path has no children — return [].
      return [];
    }
    return fsSync.readdirSync(host).sort();
  }

  readdirWithTypes(path: string): { name: string; kind: 'file' | 'dir' }[] {
    const host = this.resolveSecure(path);
    return this.readdir(path).map((name) => {
      let kind: 'file' | 'dir' = 'file';
      try {
        if (fsSync.lstatSync(nodePath.join(host, name)).isDirectory()) kind = 'dir';
      } catch {
        /* vanished between readdir and stat — report as file */
      }
      return { name, kind };
    });
  }

  // ---------- usage / limits (§3.9) ----------

  /** Recount the shared store from disk (symlink entries are skipped — they
   *  are unusable anyway and must not inflate the budget). */
  private scanUsage(): { files: number; dirs: number; bytes: number } {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    const walk = (dir: string): void => {
      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (d.isSymbolicLink()) continue;
        const full = nodePath.join(dir, d.name);
        if (d.isDirectory()) {
          dirs++;
          walk(full);
        } else {
          try {
            bytes += fsSync.statSync(full).size;
            files++;
          } catch {
            /* raced removal */
          }
        }
      }
    };
    walk(this.rootReal);
    return { files, dirs, bytes };
  }

  private assertCanStore(bytes: number, replacingBytes: number, replacingExisted: boolean): void {
    const limits = getVfsLimits(); // §5.2 — resolved at every write
    const usage = this.scanUsage();
    const newEntries = usage.files + usage.dirs + (replacingExisted ? 0 : 1);
    if (newEntries > limits.maxEntries) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: at most ${limits.maxEntries} entries in the shared VFS are allowed.`);
    }
    if (usage.bytes - replacingBytes + bytes > limits.maxTotalBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: shared VFS exceeds the maximum total size of ${limits.maxTotalBytes} bytes.`);
    }
  }

  usage(): { usedBytes: number; files: number; limits: VfsLimits } {
    const u = this.scanUsage();
    return { usedBytes: u.bytes, files: u.files, limits: getVfsLimits() };
  }

  // ---------- writes ----------

  private static toBuffer(data: string | Buffer | Uint8Array): Buffer {
    return Buffer.isBuffer(data)
      ? data
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
        : Buffer.from(String(data), 'utf8');
  }

  /** Write a file, creating missing parent directories implicitly. */
  writeFile(path: string, data: string | Buffer | Uint8Array): void {
    const v = normalizeVirtualPath(path);
    if (v === '/') throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, open '${path}'`);
    const buf = VirtualFsSession.toBuffer(data);
    const limits = getVfsLimits();
    if (buf.length > limits.maxFileBytes) {
      throw new VirtualFsError('VFS_LIMIT', `VFS limit: write exceeds the maximum file size of ${limits.maxFileBytes} bytes.`);
    }
    const host = this.resolveSecure(path);
    let replacingBytes = 0;
    let existed = false;
    try {
      const st = fsSync.lstatSync(host);
      if (st.isDirectory()) {
        throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, open '${path}'`);
      }
      replacingBytes = st.size;
      existed = true;
    } catch (err) {
      if (err instanceof VirtualFsError) throw err;
    }
    this.assertCanStore(buf.length, replacingBytes, existed);
    fsSync.mkdirSync(nodePath.dirname(host), { recursive: true });
    fsSync.writeFileSync(host, buf);
  }

  appendFile(path: string, data: string | Buffer | Uint8Array): void {
    const v = normalizeVirtualPath(path);
    const host = this.resolveSecure(path);
    const isFile = (() => {
      try {
        return fsSync.lstatSync(host).isFile();
      } catch {
        return false;
      }
    })();
    if (!isFile) {
      this.writeFile(v, data);
      return;
    }
    const prev = fsSync.readFileSync(host);
    this.writeFile(v, Buffer.concat([prev, VirtualFsSession.toBuffer(data)]));
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    const v = normalizeVirtualPath(path);
    if (v === '/') return;
    const host = this.resolveSecure(path);
    const recursive = options?.recursive === true;
    if (fsSync.existsSync(host)) {
      if (recursive && this.isDirHost(host)) return;
      throw new VirtualFsError('EEXIST', `EEXIST: file already exists, mkdir '${path}'`);
    }
    if (!recursive && !this.isDirHost(nodePath.dirname(host))) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, mkdir '${path}'`);
    }
    this.assertCanStore(0, 0, false);
    fsSync.mkdirSync(host, { recursive });
  }

  unlink(path: string): void {
    const host = this.resolveSecure(path);
    let st: fsSync.Stats;
    try {
      st = fsSync.lstatSync(host);
    } catch {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, unlink '${path}'`);
    }
    if (st.isDirectory()) {
      throw new VirtualFsError('EISDIR', `EISDIR: illegal operation on a directory, unlink '${path}' — use rm with recursive.`);
    }
    fsSync.unlinkSync(host);
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const v = normalizeVirtualPath(path);
    if (v === '/') throw hostAccessError('refusing to remove the workspace root');
    const host = this.resolveSecure(path);
    if (!fsSync.existsSync(host)) {
      if (options?.force) return;
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, rm '${path}'`);
    }
    if (this.isDirHost(host)) {
      const children = fsSync.readdirSync(host);
      if (children.length > 0 && options?.recursive !== true) {
        throw new VirtualFsError('ENOTEMPTY', `ENOTEMPTY: directory not empty, rm '${path}' — pass { recursive: true }.`);
      }
    }
    fsSync.rmSync(host, { recursive: true, force: true });
  }

  rename(oldPath: string, newPath: string): void {
    const from = normalizeVirtualPath(oldPath);
    const to = normalizeVirtualPath(newPath);
    const fromHost = this.resolveSecure(oldPath);
    const toHost = this.resolveSecure(newPath);
    if (!fsSync.existsSync(fromHost)) {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, rename '${oldPath}' -> '${newPath}'`);
    }
    if (to === from || to.startsWith(`${from}/`)) {
      throw new VirtualFsError('EINVAL', `EINVAL: cannot move a directory into itself, rename '${oldPath}' -> '${newPath}'`);
    }
    if (fsSync.existsSync(toHost)) {
      const st = fsSync.lstatSync(toHost);
      if (st.isFile() || (st.isDirectory() && fsSync.readdirSync(toHost).length > 0)) {
        throw new VirtualFsError('ENOTEMPTY', `ENOTEMPTY: destination already exists, rename '${oldPath}' -> '${newPath}'`);
      }
    }
    fsSync.mkdirSync(nodePath.dirname(toHost), { recursive: true });
    fsSync.renameSync(fromHost, toHost);
  }

  copy(from: string, to: string): void {
    const src = normalizeVirtualPath(from);
    const dst = normalizeVirtualPath(to);
    const srcHost = this.resolveSecure(from);
    const dstHost = this.resolveSecure(to);
    let st: fsSync.Stats;
    try {
      st = fsSync.lstatSync(srcHost);
    } catch {
      throw new VirtualFsError('ENOENT', `ENOENT: no such file or directory, copy '${from}' -> '${to}'`);
    }
    if (st.isFile()) {
      this.writeFile(dst, fsSync.readFileSync(srcHost));
      return;
    }
    if (fsSync.existsSync(dstHost) && fsSync.lstatSync(dstHost).isFile()) {
      throw new VirtualFsError('ENOTDIR', `ENOTDIR: destination is a file, copy '${from}' -> '${to}'`);
    }
    // A directory copy into its own subtree would recurse forever — refuse it
    // the same way rename does (the whole root counts as "inside" for '/').
    if (dst === src || src === '/' || dst.startsWith(`${src}/`)) {
      throw new VirtualFsError('EINVAL', `EINVAL: cannot copy a directory into itself, copy '${from}' -> '${to}'`);
    }
    // Directory copy — recursive by definition. Implemented with secure
    // primitives (mkdir/writeFile) so limits + symlink rejection apply to
    // every copied entry; symlinks under the source are skipped entirely.
    this.copyTree(srcHost, dst);
  }

  private copyTree(srcHost: string, dstVirtual: string): void {
    this.mkdir(dstVirtual, { recursive: true });
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(srcHost, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const childVirtual = `${dstVirtual}/${d.name}`;
      if (d.isDirectory()) {
        this.copyTree(nodePath.join(srcHost, d.name), childVirtual);
      } else if (d.isFile()) {
        try {
          this.writeFile(childVirtual, fsSync.readFileSync(nodePath.join(srcHost, d.name)));
        } catch {
          /* raced removal or unreadable entry — skip */
        }
      }
    }
  }

  // ---------- metadata (§2.7) ----------

  listAll(): VfsEntryMeta[] {
    const out: VfsEntryMeta[] = [];
    const walk = (hostDir: string, virtualDir: string): void => {
      let entries: fsSync.Dirent[];
      try {
        entries = fsSync.readdirSync(hostDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (d.isSymbolicLink()) continue;
        const childVirtual = virtualDir === '/' ? `/${d.name}` : `${virtualDir}/${d.name}`;
        const childHost = nodePath.join(hostDir, d.name);
        if (d.isDirectory()) {
          out.push(this.toMeta(childVirtual, fsSync.statSync(childHost)));
          walk(childHost, childVirtual);
        } else {
          try {
            out.push(this.toMeta(childVirtual, fsSync.statSync(childHost)));
          } catch {
            /* raced removal */
          }
        }
      }
    };
    walk(this.rootReal, '/');
    return out.sort((a, b) => a.path.localeCompare(b.path));
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

// ---------- the runtime-level GLOBAL VFS service (§3.13) ----------

const g = globalThis as unknown as { __nextoolGlobalVfs?: VirtualFsSession };

/**
 * §3.1/§3.13 — receive THE shared VFS. Every js-function/nodejs execution,
 * every fs.* builtin and every test run gets the SAME session. Stored on
 * globalThis so dev-server module reloads keep one service (and its caches)
 * alive, mirroring the runtime's other global registries.
 */
export function openGlobalVfs(): VirtualFsSession {
  if (!g.__nextoolGlobalVfs) {
    // v1.0.14 §24.5 — one-time legacy migration BEFORE the session binds to
    // the root: existing data/vfs contents move into the real VFS/ directory.
    migrateLegacyVfsRoot();
    g.__nextoolGlobalVfs = VirtualFsSession.createFresh();
  }
  return g.__nextoolGlobalVfs;
}

/**
 * Legacy per-tool entry point (v1.0.6–v1.0.11). The toolId argument is
 * IGNORED since v1.0.12 §3.12 — one runtime-level VFS serves all tools.
 * Synchronous; existing `await openVirtualFs(...)` call sites keep working.
 */
export function openVirtualFs(_toolId?: string): VirtualFsSession {
  return openGlobalVfs();
}

/** Test-only: drop the process-level service object. The next
 *  openGlobalVfs() rebuilds it FROM DISK — proving persistence (§3.5). */
export function resetVfsServiceForTests(): void {
  delete g.__nextoolGlobalVfs;
}
