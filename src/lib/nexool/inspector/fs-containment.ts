/**
 * NexTool v1.0.13 §2 — REAL-FS containment gates shared by the FS Inspector
 * routes (fs file-manager API + operator terminal).
 *
 * Containment model (defense in depth):
 *  1. NUL bytes are rejected outright; every other traversal shape (`..`,
 *     `a//b`, `a/./b`, `a/../b`) is normalized by path.resolve against the
 *     runtime cwd.
 *  2. Existing paths are canonicalized with fs.realpathSync — this FOLLOWS
 *     symlinks, so a link planted inside the cwd that points outside resolves
 *     to its real (outside) location. Creation targets canonicalize their
 *     nearest EXISTING ancestor the same way (new names cannot be links).
 *  3. The canonical path must equal the cwd realpath or live under it
 *     (cwdRealpath + sep). Anything else → FS_ACCESS, never a partial result.
 */

import fsSync from 'node:fs';
import nodePath from 'node:path';

/** Honest error with a stable machine code for error envelopes. */
export class FsInspectorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FsInspectorError';
    this.code = code;
  }
}

export function cwdRealpath(): string {
  return fsSync.realpathSync(process.cwd());
}

/** `''` renders as the display root; anything else as a cwd-relative path. */
export function displayPath(rel: string): string {
  return rel === '' ? '.' : rel;
}

/**
 * Containment gate for EXISTING paths. Returns the canonical host path plus
 * its cwd-relative display path, or throws FS_ACCESS / ENOENT / FS_ERROR.
 */
export function resolveConfined(rawPath: string): { real: string; rel: string } {
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

/**
 * Containment gate for CREATION targets (the path itself may not exist yet).
 * The nearest EXISTING ancestor is realpath'd (symlink-safe: a planted link
 * ancestor either resolves inside the cwd or is refused); the remaining
 * segments are purely lexical new names that cannot resolve elsewhere.
 */
export function resolveConfinedTarget(rawPath: string): { real: string; rel: string } {
  if (rawPath.includes('\0')) {
    throw new FsInspectorError('FS_ACCESS', 'NUL bytes in paths are not permitted.');
  }
  const root = cwdRealpath();
  const candidate = nodePath.resolve(root, rawPath);
  let existing = candidate;
  const tails: string[] = [];
  for (let i = 0; i < 1024; i++) {
    if (fsSync.existsSync(existing)) break;
    tails.unshift(nodePath.basename(existing));
    const parent = nodePath.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  let realAncestor: string;
  try {
    realAncestor = fsSync.realpathSync(existing);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EIO';
    throw new FsInspectorError('FS_ERROR', `${code}: cannot access the requested path.`);
  }
  if (realAncestor !== root && !realAncestor.startsWith(root + nodePath.sep)) {
    throw new FsInspectorError(
      'FS_ACCESS',
      'Access outside the NexTool runtime working directory is not permitted.',
    );
  }
  const real = nodePath.join(realAncestor, ...tails);
  return { real, rel: nodePath.relative(root, real) };
}

/** HTTP status for an FsInspectorError code (mirrored across routes). */
export function fsErrorStatus(code: string): number {
  if (code === 'FS_ACCESS') return 403;
  if (code === 'ENOENT') return 404;
  if (code === 'FS_TOO_LARGE') return 413;
  return 400;
}
