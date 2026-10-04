/**
 * NexTool v1.0.6 — sandbox `fs` module (spec §2.3/§2.4).
 * v1.0.12 §3 — the session is now THE GLOBAL SHARED VFS (one per runtime).
 *
 * Builds the `fs` surface exposed inside the nodejs sandbox from a
 * VirtualFsSession. Promise APIs are preferred (§2.3); fs.promises mirrors
 * them; common *Sync helpers power `require()` of VFS modules; a few
 * callback-style forms are accepted. Every operation is bound to the shared
 * virtual workspace rooted at the VFS root (the security boundary) — there is
 * NO path from here to the host fs.
 */

import type { VirtualFsSession } from './vfs';

function maybeCallback(cb: unknown, err: unknown, value?: unknown): boolean {
  if (typeof cb === 'function') {
    setTimeout(() => {
      try { (cb as (e: unknown, v?: unknown) => void)(err, err === null ? value : undefined); } catch { /* ignore */ }
    }, 0);
    return true;
  }
  return false;
}

function asyncOp<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    }, 0);
  });
}

export function createFsModule(session: VirtualFsSession): Record<string, unknown> {
  const readFile = (path: string, encoding?: string | ((err: unknown, data?: unknown) => void), cb?: (err: unknown, data?: unknown) => void) => {
    const callback = typeof encoding === 'function' ? encoding : cb;
    const enc = typeof encoding === 'string' ? encoding : undefined;
    if (callback) {
      try {
        const data = session.readFile(path, enc);
        maybeCallback(callback, null, data);
        return undefined as never;
      } catch (err) {
        maybeCallback(callback, err);
        return undefined as never;
      }
    }
    return asyncOp(() => session.readFile(path, enc));
  };

  const promiseFs = {
    readFile: (path: string, encoding?: string) => asyncOp(() => session.readFile(path, encoding)),
    writeFile: (path: string, data: string | Uint8Array) => asyncOp(() => session.writeFile(path, data)),
    appendFile: (path: string, data: string | Uint8Array) => asyncOp(() => session.appendFile(path, data)),
    mkdir: (path: string, options?: { recursive?: boolean }) => asyncOp(() => session.mkdir(path, options)),
    readdir: (path: string) => asyncOp(() => session.readdir(path)),
    stat: (path: string) => asyncOp(() => session.stat(path)),
    lstat: (path: string) => asyncOp(() => session.lstat(path)),
    rename: (oldPath: string, newPath: string) => asyncOp(() => session.rename(oldPath, newPath)),
    copyFile: (from: string, to: string) => asyncOp(() => session.copy(from, to)),
    unlink: (path: string) => asyncOp(() => session.unlink(path)),
    rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => asyncOp(() => session.rm(path, options)),
    realpath: (path: string) => asyncOp(() => session.realpath(path)),
    /** NexTool extension (honest deviation from Node): promise exists(). */
    exists: (path: string) => asyncOp(() => session.exists(path)),
  };

  const fs: Record<string, unknown> = {
    // promise-first API (preferred, documented)
    ...promiseFs,
    // callback-tolerant readFile/writeFile (common in older tool code)
    readFile,
    writeFile: (path: string, data: string | Uint8Array, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') {
        try {
          session.writeFile(path, data);
          maybeCallback(cb, null);
        } catch (err) {
          maybeCallback(cb, err);
        }
        return undefined as never;
      }
      return promiseFs.writeFile(path, data);
    },
    exists: (path: string, cb?: (exists: boolean) => void) => {
      const result = session.exists(path);
      if (cb) {
        maybeCallback(cb, null, result);
        return undefined as never;
      }
      return Promise.resolve(result);
    },
    // sync API (powers VFS require() and sync tool code)
    readFileSync: (path: string, encoding?: string) => session.readFileSync(path, encoding),
    writeFileSync: (path: string, data: string | Uint8Array) => session.writeFileSync(path, data),
    appendFileSync: (path: string, data: string | Uint8Array) => session.appendFile(path, data),
    existsSync: (path: string) => session.existsSync(path),
    mkdirSync: (path: string, options?: { recursive?: boolean }) => session.mkdir(path, options),
    readdirSync: (path: string) => session.readdir(path),
    statSync: (path: string) => session.stat(path),
    lstatSync: (path: string) => session.lstat(path),
    renameSync: (oldPath: string, newPath: string) => session.rename(oldPath, newPath),
    copyFileSync: (from: string, to: string) => session.copy(from, to),
    unlinkSync: (path: string) => session.unlink(path),
    rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => session.rm(path, options),
    realpathSync: (path: string) => session.realpath(path),
    // metadata
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    /** NexTool extension: workspace usage against the VFS limits. */
    usage: () => session.usage(),
  };

  fs.promises = promiseFs;
  fs.default = fs; // `import fs from "fs"` support
  return fs;
}
