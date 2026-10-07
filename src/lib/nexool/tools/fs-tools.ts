/**
 * NexTool v1.0.12 — native fs.* built-in tools (Phase 4, spec §4).
 * v1.0.13 §10 — NEW filesystem workflow tools: fs.find, fs.copy, fs.move,
 * fs.cmd (ALWAYS user-confirmed), fs.download and fs.upload.
 *
 * A family of BUILT-IN filesystem tools that operate ONLY on the GLOBAL
 * SHARED VFS (v1.0.12 §3) — never on the host filesystem. They receive the
 * one runtime-level VirtualFsSession through openGlobalVfs(), exactly like
 * the restricted js-function/nodejs runtimes do, so:
 *
 *  - every path is a VIRTUAL path rooted at `/` (the VFS root is the
 *    security boundary); the real host location is never accepted, returned
 *    or exposed (§3.7);
 *  - the central configuration-limits.json `vfs` limits remain the only
 *    authority for file size, total size, entry count and depth (§3.9);
 *  - `freedom-node` is untouched (§3.10) — these tools add a SAFE surface,
 *    they do not restrict the unrestricted environment.
 *
 * The ONE deliberate exception is fs.cmd (v1.0.13 §10): the operator's
 * command executor against the REAL host shell (confined to the runtime
 * working directory). §10/§19 — it is the fs/freedom-node side of the
 * environment model and therefore REQUIRES explicit user confirmation
 * before EVERY execution, in every context (task, subtool, tool test):
 * the approval is forced in approval.ts (FORCE_APPROVAL_TOOLS) at the task
 * gate and re-checked inside the handler itself.
 *
 * Environment/classification: `builtin` → toolExportClass() = 'builtin' →
 * NOT exportable (v1.0.12 §2.2), matching every other shipped tool.
 *
 * Tools: fs.list, fs.readfile, fs.writefile, fs.getpath, fs.hasfile,
 * fs.hasfolder, fs.infofile, fs.createfolder, fs.deletefile, fs.deletefolder,
 * fs.find, fs.copy, fs.move, fs.cmd, fs.download, fs.upload.
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import fsSync from 'node:fs';
import type { ToolDefinition, ToolParamDef } from '../types';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';
import { normalizeVirtualPath, openGlobalVfs, VirtualFsError } from './vfs';
import { registerVfsDownload } from './fs-downloads';
import { requestFileFromUser } from './file-requests';
import { requestApproval } from '../approval';

function p(
  name: string, type: ToolParamDef['type'], required: boolean, description: string,
  extra: Partial<ToolParamDef> = {},
): ToolParamDef {
  return { name, type, required, description, ...extra };
}

/** Map a VirtualFsError onto the structured ToolFailure transport (codes
 *  like ENOENT / EISDIR / VFS_LIMIT / VFS_ACCESS pass through verbatim). */
function toToolFailure(err: unknown): unknown {
  if (err instanceof VirtualFsError) {
    return new ToolFailure(err.message, err.code);
  }
  return err;
}

/** Required string param with a pointed invalid-params error. */
function requirePath(params: Record<string, unknown>, tool: string): string {
  const value = params.path ?? params.folder ?? params.file;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolFailure(`${tool} requires a non-empty string "path" (a VFS path rooted at "/").`, 'INVALID_PARAMS');
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalBool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------- handlers ----------

/** fs.list — list files/folders in a VFS directory with useful metadata. */
export const fsList: ToolHandler = async (params) => {
  const dir = typeof params.path === 'string' && params.path.trim() ? params.path : '/';
  const vfs = openGlobalVfs();
  try {
    const entries = vfs.readdirWithTypes(dir).map((e) => {
      const child = dir === '/' ? `/${e.name}` : `${dir.replace(/\/+$/, '')}/${e.name}`;
      const meta = e.kind === 'file' ? vfs.stat(child) : undefined;
      return {
        name: e.name,
        path: child,
        kind: e.kind,
        ...(meta ? { size: meta.size, updatedAt: meta.updatedAt } : {}),
      };
    });
    return { path: vfs.stat(dir).path, count: entries.length, entries };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/** fs.readfile — read a VFS file (size caps enforced by the shared VFS). */
export const fsReadFile: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.readfile');
  const encoding = optionalString(params, 'encoding') ?? 'utf8';
  if (encoding !== 'utf8' && encoding !== 'base64' && encoding !== 'buffer') {
    throw new ToolFailure('fs.readfile supports encoding "utf8", "base64" or "buffer".', 'INVALID_PARAMS');
  }
  const vfs = openGlobalVfs();
  try {
    const data = vfs.readFile(path, encoding) as string | Buffer;
    const content = encoding === 'buffer' ? Buffer.from(data as Buffer).toString('base64') : (data as string);
    return {
      path: vfs.stat(path).path,
      encoding: encoding === 'buffer' ? 'base64' : encoding,
      size: vfs.stat(path).size,
      content,
    };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/** fs.writefile — write a VFS file (size/total caps enforced by the VFS). */
export const fsWriteFile: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.writefile');
  const content = typeof params.content === 'string' ? params.content : '';
  if (params.content !== undefined && params.content !== null && typeof params.content !== 'string') {
    throw new ToolFailure('fs.writefile "content" must be a string (use encoding "base64" for binary bytes).', 'INVALID_PARAMS');
  }
  const encoding = optionalString(params, 'encoding') ?? 'utf8';
  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw new ToolFailure('fs.writefile supports encoding "utf8" or "base64".', 'INVALID_PARAMS');
  }
  const vfs = openGlobalVfs();
  try {
    const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    vfs.writeFile(path, data);
    const meta = vfs.stat(path);
    return { path: meta.path, size: meta.size, updatedAt: meta.updatedAt };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/** fs.getpath — the normalized VFS path. NEVER the host path (§4). */
export const fsGetPath: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.getpath');
  const vfs = openGlobalVfs();
  try {
    // normalizeVirtualPath (inside stat) throws on traversal/host paths — an
    // invalid input is rejected, never silently rewritten.
    const meta = vfs.stat(path);
    return { input: path, path: meta.path, kind: meta.kind };
  } catch (err) {
    // ENOENT is fine for getpath — normalization still has to succeed.
    try {
      return { input: path, path: normalizeVirtualPath(path) };
    } catch {
      throw toToolFailure(err);
    }
  }
};

/** fs.hasfile — does a FILE exist at this VFS path? */
export const fsHasFile: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.hasfile');
  const vfs = openGlobalVfs();
  try {
    const meta = vfs.stat(path);
    return { path: meta.path, exists: meta.kind === 'file' };
  } catch {
    return { path, exists: false };
  }
};

/** fs.hasfolder — does a FOLDER exist at this VFS path? */
export const fsHasFolder: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.hasfolder');
  const vfs = openGlobalVfs();
  try {
    const meta = vfs.stat(path);
    return { path: meta.path, exists: meta.kind === 'dir' };
  } catch {
    return { path, exists: false };
  }
};

/** fs.infofile — metadata (name, path, size, kind, created/modified). */
export const fsInfoFile: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.infofile');
  const vfs = openGlobalVfs();
  try {
    const meta = vfs.stat(path);
    const name = meta.path.slice(meta.path.lastIndexOf('/') + 1) || '/';
    return {
      name,
      path: meta.path,
      kind: meta.kind,
      size: meta.size,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/** fs.createfolder — create a VFS directory (recursive by default). */
export const fsCreateFolder: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.createfolder');
  const recursive = optionalBool(params, 'recursive', true);
  const vfs = openGlobalVfs();
  try {
    const meta = vfs.stat(path);
    return { path: meta.path, created: false, existed: true, kind: meta.kind };
  } catch {
    try {
      vfs.mkdir(path, { recursive });
      return { path: vfs.stat(path).path, created: true, existed: false, kind: 'dir' };
    } catch (err) {
      throw toToolFailure(err);
    }
  }
};

/** fs.deletefile — delete a FILE from the VFS. */
export const fsDeleteFile: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.deletefile');
  const vfs = openGlobalVfs();
  try {
    const normalized = vfs.stat(path).path; // validates + captures the virtual path
    vfs.unlink(path);
    return { path: normalized, deleted: true };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/** fs.deletefolder — delete a VFS directory (recursive by default). */
export const fsDeleteFolder: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.deletefolder');
  const recursive = optionalBool(params, 'recursive', true);
  const force = optionalBool(params, 'force', false);
  const vfs = openGlobalVfs();
  try {
    vfs.rm(path, { recursive, force });
    return { path, deleted: true };
  } catch (err) {
    throw toToolFailure(err);
  }
};

// ---------- v1.0.13 §10 — new filesystem workflow tools ----------

/** Bound the recursive find walk so no scan is unbounded (spec §2.6/§10). */
const FS_FIND_MAX_RESULTS = 200;
const FS_FIND_MAX_DEPTH = 10;

/**
 * fs.find — search the shared VFS for files/folders whose NAME matches a
 * query, bounded by an explicit depth (0 = the start directory itself).
 * Returns matches with their parent folder; never throws on unreadable
 * children (skips them) so a partial scan is still usable.
 */
export const fsFind: ToolHandler = async (params) => {
  const startRaw = typeof params.path === 'string' && params.path.trim() ? params.path : '/';
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    throw new ToolFailure('fs.find requires a non-empty string "query" (case-insensitive substring of the entry name).', 'INVALID_PARAMS');
  }
  const depthRaw = params.depth;
  const depth = typeof depthRaw === 'number' && Number.isFinite(depthRaw)
    ? Math.max(0, Math.min(FS_FIND_MAX_DEPTH, Math.floor(depthRaw)))
    : 5;
  const filesOnly = optionalBool(params, 'filesOnly', false);
  const foldersOnly = optionalBool(params, 'foldersOnly', false);
  if (filesOnly && foldersOnly) {
    throw new ToolFailure('fs.find: "filesOnly" and "foldersOnly" are mutually exclusive.', 'INVALID_PARAMS');
  }
  const caseSensitive = optionalBool(params, 'caseSensitive', false);
  const needle = caseSensitive ? query : query.toLowerCase();

  const vfs = openGlobalVfs();
  const start = vfs.stat(startRaw).path; // validates + normalizes (throws honestly)
  if (vfs.stat(start).kind !== 'dir') {
    throw new ToolFailure(`fs.find "path" must be a directory (got a file at "${start}").`, 'EINVAL');
  }

  const matches: { name: string; folder: string; path: string; kind: string; size?: number }[] = [];
  const walk = (dir: string, level: number) => {
    if (level > depth || matches.length >= FS_FIND_MAX_RESULTS) return;
    let entries: { name: string; kind: 'file' | 'dir' }[];
    try {
      entries = vfs.readdirWithTypes(dir);
    } catch {
      return; // unreadable child — skip, keep scanning siblings
    }
    for (const e of entries) {
      if (matches.length >= FS_FIND_MAX_RESULTS) return;
      const child = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
      const nameHay = caseSensitive ? e.name : e.name.toLowerCase();
      const hit = nameHay.includes(needle)
        && (!filesOnly || e.kind === 'file')
        && (!foldersOnly || e.kind === 'dir');
      if (hit) {
        let size: number | undefined;
        try {
          const meta = vfs.stat(child);
          size = meta.kind === 'file' ? meta.size : undefined;
        } catch { /* raced — omit size */ }
        matches.push({ name: e.name, folder: dir, path: child, kind: e.kind, ...(size !== undefined ? { size } : {}) });
      }
      if (e.kind === 'dir') walk(child, level + 1);
    }
  };
  walk(start, 0);

  return {
    query,
    path: start,
    depth,
    filesOnly,
    foldersOnly,
    caseSensitive,
    matched: matches.length,
    truncated: matches.length >= FS_FIND_MAX_RESULTS,
    matches,
  };
};

/**
 * fs.copy — copy a file OR a whole folder (recursive) inside the shared VFS.
 * The VFS enforces size/entry limits on the destination writes.
 */
export const fsCopy: ToolHandler = async (params) => {
  const from = requirePath(params, 'fs.copy');
  const to = typeof params.to === 'string' && params.to.trim()
    ? params.to
    : (() => { throw new ToolFailure('fs.copy requires a non-empty string "to" (destination VFS path).', 'INVALID_PARAMS'); })();
  const vfs = openGlobalVfs();
  try {
    vfs.copy(from, to);
    const meta = vfs.stat(to);
    return { from: vfs.stat(from).path, to: meta.path, kind: meta.kind, size: meta.size, copied: true };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/**
 * fs.move — move/rename a file or folder inside the shared VFS (same
 * boundary: both endpoints must resolve inside the VFS root).
 */
export const fsMove: ToolHandler = async (params) => {
  const from = requirePath(params, 'fs.move');
  const to = typeof params.to === 'string' && params.to.trim()
    ? params.to
    : (() => { throw new ToolFailure('fs.move requires a non-empty string "to" (destination VFS path).', 'INVALID_PARAMS'); })();
  const vfs = openGlobalVfs();
  try {
    const fromMeta = vfs.stat(from);
    vfs.rename(from, to);
    const meta = vfs.stat(to);
    return { from: fromMeta.path, to: meta.path, kind: meta.kind, moved: true };
  } catch (err) {
    throw toToolFailure(err);
  }
};

// ---------- fs.cmd — user-confirmed real command executor ----------

const FS_CMD_MAX_OUTPUT_BYTES = 256 * 1024;
const FS_CMD_DEFAULT_TIMEOUT_MS = 30_000;
const FS_CMD_MAX_TIMEOUT_MS = 120_000;

/**
 * Resolve the requested working directory against the runtime cwd with the
 * SAME containment contract as the FS Inspector (fs-containment): NUL bytes
 * refused, traversal normalized by resolve(), existing paths pinned by
 * realpath (symlinks that leave the cwd are refused). Non-existent targets
 * are allowed only when their nearest existing ancestor stays inside.
 */
function resolveCmdCwd(cwdRel: string): string {
  if (cwdRel.includes('\0')) {
    throw new ToolFailure('fs.cmd: NUL bytes in the working directory are not permitted (FS_ACCESS).', 'FS_ACCESS');
  }
  const root = fsSync.realpathSync(process.cwd());
  const cleaned = cwdRel === '.' || cwdRel === '/' ? '' : cwdRel.replace(/^\.\/+/, '').replace(/\/+$/, '');
  const resolved = nodePath.resolve(root, cleaned);
  if (resolved === root) return root;
  let anchor = resolved;
  while (anchor !== nodePath.dirname(anchor) && !fsSync.existsSync(anchor)) {
    anchor = nodePath.dirname(anchor);
  }
  let anchorReal: string;
  try {
    anchorReal = fsSync.realpathSync(anchor);
  } catch {
    throw new ToolFailure(`fs.cmd working directory "${cwdRel}" cannot be resolved (FS_ACCESS).`, 'FS_ACCESS');
  }
  if (anchorReal !== root && !anchorReal.startsWith(root + nodePath.sep)) {
    throw new ToolFailure(
      `fs.cmd working directory "${cwdRel}" resolves outside the NexTool runtime working directory — refused (FS_ACCESS).`,
      'FS_ACCESS',
    );
  }
  return resolved;
}

/** Spawn bash -lc <command> confined to the runtime working directory. */
function runHostCommand(command: string, cwdRel: string, timeoutMs: number): Promise<{
  stdout: string; stderr: string; code: number | null; signal: string | null;
  truncated: boolean; timedOut: boolean; cwd: string;
}> {
  const cwd = resolveCmdCwd(cwdRel); // throws ToolFailure(FS_ACCESS) on escape
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: cwd, TERM: 'dumb', LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ToolFailure(`fs.cmd failed to spawn the shell: ${err instanceof Error ? err.message : 'unknown error'}`, 'FS_CMD_SPAWN_FAILED'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const capChunk = (current: string, chunk: Buffer): { text: string; truncated: boolean } => {
      if (current.length >= FS_CMD_MAX_OUTPUT_BYTES) return { text: current, truncated: true };
      const room = FS_CMD_MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > room) return { text: current + chunk.subarray(0, room).toString('utf8'), truncated: true };
      return { text: current + chunk.toString('utf8'), truncated };
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (c: Buffer) => { const r = capChunk(stdout, c); stdout = r.text; truncated = truncated || r.truncated; });
    child.stderr?.on('data', (c: Buffer) => { const r = capChunk(stderr, c); stderr = r.text; truncated = truncated || r.truncated; });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new ToolFailure(`fs.cmd shell error: ${err.message}`, 'FS_CMD_ERROR'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal: signal ?? null, truncated, timedOut, cwd });
    });
  });
}

/**
 * fs.cmd — execute a terminal command on the HOST (bash), confined to the
 * NexTool runtime working directory. §10 — EVERY execution requires explicit
 * user confirmation: "NexTool wants to execute: <cmd> — [Cancel] [Allow]".
 * The confirmation is enforced in BOTH layers:
 *  - the task-level approval gate (approval.ts FORCE_APPROVAL_TOOLS makes
 *    fs.cmd never auto-executable, whatever the auto-execution hierarchy says);
 *  - the handler gate below (covers subtool calls and tool test mode, which
 *    bypass the task gate — the executor threads `ctx.approved` only when the
 *    task gate already collected an explicit ALLOW).
 * The freedom-node environment remains the unrestricted execution surface —
 * fs.cmd is the confirmation-gated, output-capped, timeout-bounded one.
 */
export const fsCmd: ToolHandler = async (params, ctx) => {
  const command = typeof params.command === 'string' ? params.command.trim() : '';
  if (!command) {
    throw new ToolFailure('fs.cmd requires a non-empty string "command" to execute.', 'INVALID_PARAMS');
  }
  const cwd = typeof params.cwd === 'string' && params.cwd.trim() ? params.cwd.trim() : '.';
  const requestedTimeout = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? Math.min(params.timeoutMs, FS_CMD_MAX_TIMEOUT_MS)
    : Math.min(ctx?.timeoutMs && ctx.timeoutMs > 0 ? ctx.timeoutMs : FS_CMD_DEFAULT_TIMEOUT_MS, FS_CMD_MAX_TIMEOUT_MS);

  // Handler-level confirmation gate (subtool/test mode + defense in depth).
  if (!ctx?.approved) {
    const { outcome } = await requestApproval({
      taskId: ctx?.taskId, // undefined in test mode — never a fabricated id
      tool: 'fs.cmd',
      params: { command, cwd, timeoutMs: requestedTimeout },
      purpose: 'Execute a terminal command on the host filesystem',
      reason: `NexTool wants to execute:\n${command}\n\nWorking directory: ${cwd}`,
    });
    if (outcome !== 'allowed' && outcome !== 'auto') {
      throw new ToolFailure(
        outcome === 'denied'
          ? 'fs.cmd was denied by the user — the command was NOT executed.'
          : `fs.cmd was not approved (${outcome}) — the command was NOT executed.`,
        outcome === 'denied' ? 'USER_DENIED' : 'APPROVAL_REQUIRED',
      );
    }
  }

  let result: Awaited<ReturnType<typeof runHostCommand>>;
  try {
    result = await runHostCommand(command, cwd, requestedTimeout);
  } catch (err) {
    throw toToolFailure(err);
  }
  return {
    command,
    cwd: result.cwd,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    truncatedOutput: result.truncated,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

/**
 * fs.download — register a VFS FILE for download and hand back a short-lived
 * console URL (/api/fsdownloads/<token>, 10 min TTL). The route re-verifies
 * the VFS boundary on every request; the tool only ever sees the virtual path.
 */
export const fsDownload: ToolHandler = async (params) => {
  const path = requirePath(params, 'fs.download');
  const vfs = openGlobalVfs();
  try {
    const meta = vfs.stat(path);
    if (meta.kind !== 'file') {
      throw new ToolFailure(
        `fs.download requires a FILE (got kind "${meta.kind}" at "${meta.path}") — zip folders first with the FS Inspector.`,
        'EINVAL',
      );
    }
    const name = meta.path.slice(meta.path.lastIndexOf('/') + 1) || 'download.bin';
    const ticket = registerVfsDownload({ virtualPath: meta.path, name, size: meta.size });
    return {
      path: meta.path,
      name: ticket.name,
      size: ticket.size,
      downloadUrl: `/api/fsdownloads/${ticket.token}`,
      expiresAt: ticket.expiresAt,
    };
  } catch (err) {
    throw toToolFailure(err);
  }
};

/**
 * fs.upload — ASK the user for a file (console prompt "Upload a file —
 * [Choose file] [Cancel]") and write it into the shared VFS. The wait is
 * bounded (120 s window, like prompt()/confirm()); on timeout/cancel the
 * tool fails honestly with FILE_REQUEST_TIMEOUT / USER_DENIED and the task
 * loop continues (never a runtime freeze). Central vfs limits stay the final
 * authority at write time.
 */
export const fsUpload: ToolHandler = async (params, ctx) => {
  const destDir = typeof params.path === 'string' && params.path.trim() ? params.path : '/';
  const suggestedName = optionalString(params, 'suggestedName');
  const message = optionalString(params, 'message')
    ?? `Upload a file${suggestedName ? ` (${suggestedName})` : ''} — it will be stored in the shared VFS at ${destDir}.`;

  const resolution = await requestFileFromUser({
    taskId: ctx?.taskId,
    executionId: ctx?.executionId ?? 'unknown-execution',
    toolName: 'fs.upload',
    message,
    suggestedName,
  });
  if (!resolution) {
    throw new ToolFailure(
      'fs.upload did not receive a file — the request was cancelled or timed out (120 s window).',
      'FILE_REQUEST_TIMEOUT',
    );
  }

  const fileName = resolution.fileName.replace(/[\\/]+/g, '_').trim() || 'upload.bin';
  const target = normalizeVirtualPath(
    destDir === '/' || destDir === ''
      ? `/${fileName}`
      : `${destDir.replace(/\/+$/, '')}/${fileName}`,
  );
  const vfs = openGlobalVfs();
  try {
    const bytes = Buffer.from(resolution.contentBase64, 'base64');
    vfs.writeFile(target, bytes);
    const meta = vfs.stat(target);
    return {
      path: meta.path,
      name: fileName,
      size: meta.size,
      updatedAt: meta.updatedAt,
      stored: true,
    };
  } catch (err) {
    if (err instanceof VirtualFsError && err.code === 'VFS_LIMIT') {
      throw new ToolFailure(
        `fs.upload rejected "${fileName}": ${err.message} (the uploaded file was discarded).`,
        'VFS_LIMIT',
      );
    }
    throw toToolFailure(err);
  }
};

// ---------- definitions (registered among the shipped built-ins) ----------

const FS_CATEGORY = 'filesystem';

export const FS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'fs.list',
    description: 'Lists files and folders in a shared VFS directory with name, path, kind and size.',
    purpose: 'Inspect the shared virtual workspace contents before reading or writing files.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', false, 'VFS directory to list, rooted at "/" (default "/")', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.readfile',
    description: 'Reads a text or base64 file from the shared VFS (the configured maximum file size applies).',
    purpose: 'Load file contents that another tool stored in the shared VFS.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', true, 'VFS file path, rooted at "/"', { generation: 'extractive' }),
        p('encoding', 'string', false, 'utf8 (default) or base64', { generation: 'extractive', enumValues: ['utf8', 'base64'] }),
      ],
    },
  },
  {
    name: 'fs.writefile',
    description: 'Writes (creates or overwrites) a file in the shared VFS; missing parent folders are created implicitly.',
    purpose: 'Persist data so other tools and later tasks can read it from the shared VFS.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', true, 'VFS file path, rooted at "/"', { generation: 'constructive' }),
        p('content', 'string', true, 'File content (utf8 text, or base64 when encoding=base64)', { generation: 'constructive' }),
        p('encoding', 'string', false, 'utf8 (default) or base64', { generation: 'extractive', enumValues: ['utf8', 'base64'] }),
      ],
    },
  },
  {
    name: 'fs.getpath',
    description: 'Returns the normalized shared-VFS path for an input path (never the host path).',
    purpose: 'Canonicalize a VFS path (resolves ./ and / segments) before other fs calls.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', true, 'VFS path to normalize', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.hasfile',
    description: 'Checks whether a FILE exists at a shared-VFS path.',
    purpose: 'Guard reads/writes on the shared VFS existence of a file.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', true, 'VFS path to probe', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.hasfolder',
    description: 'Checks whether a FOLDER exists at a shared-VFS path.',
    purpose: 'Guard directory operations on the shared VFS existence of a folder.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', true, 'VFS path to probe', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.infofile',
    description: 'Returns shared-VFS metadata for a path: name, path, kind, size, created and modified timestamps.',
    purpose: 'Inspect a stored file without reading its whole content.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', true, 'VFS path to describe', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.createfolder',
    description: 'Creates a folder in the shared VFS (missing parents are created when recursive, the default).',
    purpose: 'Prepare directory structures in the shared VFS before writing files.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', true, 'VFS folder path, rooted at "/"', { generation: 'constructive' }),
        p('recursive', 'boolean', false, 'Create missing parents (default true)', { generation: 'extractive' }),
      ],
    },
  },
  {
    name: 'fs.deletefile',
    description: 'Deletes a file from the shared VFS.',
    purpose: 'Remove a single stored file from the shared VFS.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', true, 'VFS file path to delete', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.deletefolder',
    description: 'Deletes a folder (with all contents when recursive, the default) from the shared VFS.',
    purpose: 'Clean up a directory tree in the shared VFS.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', true, 'VFS folder path to delete', { generation: 'extractive' }),
        p('recursive', 'boolean', false, 'Delete contents too (default true)', { generation: 'extractive' }),
      ],
    },
  },
  // ---------- v1.0.13 §10 — new filesystem workflow tools ----------
  {
    name: 'fs.find',
    description: 'Searches the shared VFS for files/folders matching a name query, bounded by an explicit depth (0 = start directory only).',
    purpose: 'Locate files in the shared VFS workspace without unbounded scanning.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('query', 'string', true, 'Name substring to search for (case-insensitive by default)', { generation: 'extractive' }),
        p('path', 'string', false, 'VFS directory to start the search from, rooted at "/" (default "/")', { generation: 'extractive' }),
        p('depth', 'number', false, 'Search depth: 0 = current dir only, 1 = children, up to 10 (default 5)', { generation: 'extractive' }),
        p('filesOnly', 'boolean', false, 'Match files only', { generation: 'extractive' }),
        p('foldersOnly', 'boolean', false, 'Match folders only (mutually exclusive with filesOnly)', { generation: 'extractive' }),
        p('caseSensitive', 'boolean', false, 'Case-sensitive matching (default false)', { generation: 'extractive' }),
      ],
    },
  },
  {
    name: 'fs.copy',
    description: 'Copies a file or a whole folder (recursive) to a new path inside the shared VFS.',
    purpose: 'Duplicate VFS files/folders as part of filesystem workflows.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', true, 'Source VFS path (file or folder), rooted at "/"', { generation: 'extractive' }),
        p('to', 'string', true, 'Destination VFS path', { generation: 'constructive' }),
      ],
    },
  },
  {
    name: 'fs.move',
    description: 'Moves/renames a file or folder to a new path inside the shared VFS (both endpoints stay in the VFS boundary).',
    purpose: 'Relocate or rename VFS entries as part of filesystem workflows.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', true, 'Source VFS path (file or folder), rooted at "/"', { generation: 'extractive' }),
        p('to', 'string', true, 'Destination VFS path', { generation: 'constructive' }),
      ],
    },
  },
  {
    name: 'fs.cmd',
    description: 'Executes a terminal command on the host (bash), confined to the NexTool runtime working directory. ALWAYS requires explicit user confirmation before execution.',
    purpose: 'Run a confirmed shell command (build, install, inspect) on the self-hosted machine.',
    category: FS_CATEGORY,
    environment: 'builtin',
    autoExecute: false,
    schema: {
      type: 'object',
      properties: [
        p('command', 'string', true, 'The shell command to execute (executed via bash -lc)', { generation: 'constructive' }),
        p('cwd', 'string', false, 'Working directory relative to the runtime cwd (default ".")', { generation: 'extractive' }),
        p('timeoutMs', 'number', false, 'Hard timeout in ms, capped at 120000 (default 30000)', { generation: 'extractive' }),
      ],
    },
  },
  {
    name: 'fs.download',
    description: 'Registers a VFS file for download and returns a short-lived console download URL (/api/fsdownloads/<token>, valid 10 minutes).',
    purpose: 'Hand a produced file to the operator as a browser download.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [p('path', 'string', true, 'VFS file path to expose for download, rooted at "/"', { generation: 'extractive' })],
    },
  },
  {
    name: 'fs.upload',
    description: 'Asks the operator to choose a file from their device ("Upload a file — [Choose file] [Cancel]") and stores it in the shared VFS; fails honestly when the request is cancelled or times out (120 s).',
    purpose: 'Bring an operator-provided file into the shared VFS for further tool processing.',
    category: FS_CATEGORY,
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('path', 'string', false, 'Destination VFS directory, rooted at "/" (default "/")', { generation: 'extractive' }),
        p('suggestedName', 'string', false, 'Suggested file name shown in the upload prompt', { generation: 'extractive' }),
        p('message', 'string', false, 'Custom prompt message shown to the operator', { generation: 'constructive' }),
      ],
    },
  },
];
