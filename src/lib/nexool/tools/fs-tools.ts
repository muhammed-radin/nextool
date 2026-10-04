/**
 * NexTool v1.0.12 — native fs.* built-in tools (Phase 4, spec §4).
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
 * Environment/classification: `builtin` → toolExportClass() = 'builtin' →
 * NOT exportable (v1.0.12 §2.2), matching every other shipped tool.
 *
 * Tools: fs.list, fs.readfile, fs.writefile, fs.getpath, fs.hasfile,
 * fs.hasfolder, fs.infofile, fs.createfolder, fs.deletefile, fs.deletefolder.
 */

import type { ToolDefinition, ToolParamDef } from '../types';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';
import { normalizeVirtualPath, openGlobalVfs, VirtualFsError } from './vfs';

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
];
