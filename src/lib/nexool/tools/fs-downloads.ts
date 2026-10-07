/**
 * NexTool v1.0.13 (§10) — in-memory download-token registry for `fs.download`.
 *
 * A tool registers a VFS FILE for download and receives a short-lived,
 * unguessable URL: /api/fsdownloads/<token>. The route validates the token,
 * checks expiry, RE-VERIFIES that the target is still a real file INSIDE the
 * shared VFS root (never a symlink, never outside the boundary) and streams
 * it with a Content-Disposition attachment header.
 *
 * Only VFS files are downloadable through this mechanism — the registry
 * stores the VIRTUAL path, and every download re-resolves it through the VFS
 * security model (normalize + realpath pinning), so:
 *   - host paths outside the real VFS/ root are unreachable by construction;
 *   - deleting/renaming the file after registration invalidates the link at
 *     the next request (re-verified per download);
 *   - tokens expire after 10 minutes and the registry is size-capped.
 *
 * Tokens live on globalThis (survive dev-server HMR) and are NEVER persisted.
 */

import fsSync from 'node:fs';
import crypto from 'node:crypto';
import nodePath from 'node:path';
import { getVfsRoot, normalizeVirtualPath } from './vfs';

/** Download-link lifetime (10 minutes). */
export const FS_DOWNLOAD_TTL_MS = 10 * 60 * 1000;

/** Registry size cap — oldest entries are evicted to bound memory. */
const FS_DOWNLOAD_MAX_ENTRIES = 200;

export interface VfsDownloadToken {
  token: string;
  /** VFS-VIRTUAL path (rooted at "/") — never a host path. */
  virtualPath: string;
  name: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}

interface VfsDownloadTokenInternal extends VfsDownloadToken {
  /** Epoch-ms expiry (derived; kept in sync with expiresAt). */
  expiresAtMs: number;
}

const g = globalThis as unknown as { __nextoolFsDownloads?: Map<string, VfsDownloadTokenInternal> };

function registry(): Map<string, VfsDownloadTokenInternal> {
  if (!g.__nextoolFsDownloads) g.__nextoolFsDownloads = new Map();
  return g.__nextoolFsDownloads;
}

function pruneExpired(now = Date.now()): void {
  const reg = registry();
  for (const [token, entry] of reg) {
    if (entry.expiresAtMs <= now) reg.delete(token);
  }
  while (reg.size > FS_DOWNLOAD_MAX_ENTRIES) {
    const oldest = reg.keys().next().value;
    if (oldest === undefined) break;
    reg.delete(oldest);
  }
}

/**
 * Register a VFS file for download. `virtualPath` MUST already be normalized
 * (fs.download passes vfs.stat(...).path). Returns the token + public URL.
 */
export function registerVfsDownload(input: {
  virtualPath: string;
  name: string;
  size: number;
}): VfsDownloadToken {
  pruneExpired();
  const token = `dl_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAtMs = Date.now() + FS_DOWNLOAD_TTL_MS;
  const entry: VfsDownloadTokenInternal = {
    token,
    virtualPath: input.virtualPath,
    name: input.name,
    size: input.size,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
  };
  registry().set(token, entry);
  return { token, virtualPath: entry.virtualPath, name: entry.name, size: entry.size, createdAt: entry.createdAt, expiresAt: entry.expiresAt };
}

/** Look up a token (lazily prunes expired entries). */
export function getVfsDownload(token: string): VfsDownloadToken | undefined {
  pruneExpired();
  const entry = registry().get(token);
  if (!entry) return undefined;
  return { token: entry.token, virtualPath: entry.virtualPath, name: entry.name, size: entry.size, createdAt: entry.createdAt, expiresAt: entry.expiresAt };
}

/** Drop a token (used by tests/maintenance; downloads self-expire otherwise). */
export function revokeVfsDownload(token: string): boolean {
  return registry().delete(token);
}

/**
 * Resolve a token to a VERIFIED host path inside the shared VFS root.
 * Returns null when the token is invalid/expired OR the target is no longer
 * a plain file inside the boundary (deleted, replaced by a directory, or a
 * planted symlink — the VFS never creates symlinks and this re-check pins it).
 * The host path is an implementation detail and never leaves the server.
 */
export function resolveVfsDownloadHostPath(token: string): { hostPath: string; name: string } | null {
  const entry = registry().get(token);
  if (!entry || entry.expiresAtMs <= Date.now()) return null;
  let virtual: string;
  try {
    virtual = normalizeVirtualPath(entry.virtualPath);
  } catch {
    return null;
  }
  if (virtual === '/') return null;
  const root = getVfsRoot();
  const hostPath = nodePath.join(root, virtual.slice(1));
  try {
    // Pin the boundary: the REAL path must equal the joined path (no symlink
    // components) and stay inside the VFS root.
    const real = fsSync.realpathSync(hostPath);
    if (real !== hostPath) return null;
    if (!real.startsWith(root + nodePath.sep)) return null;
    const st = fsSync.statSync(real);
    if (!st.isFile()) return null;
    return { hostPath: real, name: entry.name };
  } catch {
    return null;
  }
}
