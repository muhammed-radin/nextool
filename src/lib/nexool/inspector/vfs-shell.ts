/**
 * NexTool v1.1.0 §6.6/§6.7/§7.4 — SERVER-SIDE VFS SHELL.
 *
 * The v1.0.16 VFS "terminal" was a client-side interpreter with a HARD-CODED
 * command list — changing the configuration could never affect it. v1.1.0
 * moves execution into the backend:
 *
 *   - the SAME interaction protocol as the real-FS terminal (create / exec /
 *     clear / close + an SSE chunk stream with the same event shapes), so the
 *     frontend renders both with one shared xterm.js shell component;
 *   - the permitted command list comes from the CENTRAL configuration
 *     (vfsTerminal.allowedCommands; null = every implemented command) and is
 *     enforced HERE, on every execution — the UI can no longer claim a
 *     command is permitted while the backend rejects it;
 *   - every operation runs through the shared VirtualFsSession
 *     (normalizeVirtualPath + resolveSecure + symlink refusal), so the VFS
 *     root boundary is code-enforced exactly as before. This list is an
 *     application CAP for the shell UX — it is never a path out of the VFS.
 */

import { openGlobalVfs, normalizeVirtualPath, VirtualFsError } from '../tools/vfs';
import { getResolvedLimits } from '../config-limits';

export type VfsChunkKind = 'in' | 'out' | 'err' | 'meta';

export interface VfsShellChunk {
  seq: number;
  kind: VfsChunkKind;
  text: string;
  at: string;
}

export interface VfsShellSession {
  id: string;
  cwd: string;
  chunks: VfsShellChunk[];
  seq: number;
  history: string[];
  createdAt: string;
  lastActivityAt: string;
  subscribers: Set<(ev: VfsShellEvent) => void>;
}

export type VfsShellEvent =
  | { type: 'chunk'; sessionId: string; chunk: VfsShellChunk }
  | { type: 'cwd'; sessionId: string; cwd: string }
  | { type: 'exit'; sessionId: string; code: number; command: string };

const g = globalThis as unknown as { __nextoolVfsShellSessions?: Map<string, VfsShellSession> };
function registry(): Map<string, VfsShellSession> {
  if (!g.__nextoolVfsShellSessions) g.__nextoolVfsShellSessions = new Map();
  return g.__nextoolVfsShellSessions;
}

/** The commands the VFS shell IMPLEMENTS (the cap list filters these). */
export const VFS_IMPLEMENTED_COMMANDS = [
  'pwd', 'help', 'clear', 'ls', 'cd', 'cat', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'find', 'echo',
] as const;

function allowedCommands(): string[] | null {
  try {
    return getResolvedLimits().vfsTerminal.allowedCommands;
  } catch {
    return [...VFS_IMPLEMENTED_COMMANDS];
  }
}

export function vfsShellProbe(): {
  available: boolean;
  transport: 'vfs-shell';
  root: string;
  implementedCommands: string[];
  allowedCommands: string[] | null;
  sessions: { id: string; cwd: string; createdAt: string }[];
} {
  let sessions: { id: string; cwd: string; createdAt: string }[] = [];
  try {
    sessions = [...registry().values()].map((s) => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt }));
  } catch { /* empty */ }
  return {
    available: true,
    transport: 'vfs-shell',
    root: '/ (VFS)',
    implementedCommands: [...VFS_IMPLEMENTED_COMMANDS],
    allowedCommands: allowedCommands(),
    sessions,
  };
}

let sessionCounter = 0;

export function createVfsShellSession(): VfsShellSession {
  sessionCounter += 1;
  const session: VfsShellSession = {
    id: `vfs_sh_${Date.now().toString(36)}_${sessionCounter}_${Math.random().toString(36).slice(2, 6)}`,
    cwd: '/',
    chunks: [],
    seq: 0,
    history: [],
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    subscribers: new Set(),
  };
  pushChunk(session, 'meta', `NexTool VFS shell — sandboxed virtual filesystem (cannot escape the VFS root)\nType "help" for the command list.\n`);
  registry().set(session.id, session);
  return session;
}

export function getVfsShellSession(id: string): VfsShellSession | null {
  return registry().get(id) ?? null;
}

export function closeVfsShellSession(s: VfsShellSession): void {
  s.subscribers.clear();
  registry().delete(s.id);
}

export function clearVfsShellSession(s: VfsShellSession): void {
  s.chunks = [];
  s.seq = 0;
  pushChunk(s, 'meta', '— cleared —\n');
}

function pushChunk(s: VfsShellSession, kind: VfsChunkKind, text: string): void {
  if (!text) return;
  s.seq += 1;
  const chunk: VfsShellChunk = { seq: s.seq, kind, text, at: new Date().toISOString() };
  s.chunks.push(chunk);
  if (s.chunks.length > 800) s.chunks.splice(0, s.chunks.length - 800);
  for (const fn of s.subscribers) {
    try {
      fn({ type: 'chunk', sessionId: s.id, chunk });
    } catch { /* broken subscriber */ }
  }
}

function publishCwd(s: VfsShellSession): void {
  for (const fn of s.subscribers) {
    try {
      fn({ type: 'cwd', sessionId: s.id, cwd: s.cwd });
    } catch { /* ignore */ }
  }
}

function publishExit(s: VfsShellSession, code: number, command: string): void {
  pushChunk(s, 'meta', `\n[exit ${code}]\n`);
  for (const fn of s.subscribers) {
    try {
      fn({ type: 'exit', sessionId: s.id, code, command });
    } catch { /* ignore */ }
  }
}

export function replayVfsChunks(s: VfsShellSession): VfsShellChunk[] {
  return [...s.chunks];
}

export function subscribeVfsSession(s: VfsShellSession, fn: (ev: VfsShellEvent) => void): () => void {
  s.subscribers.add(fn);
  return () => s.subscribers.delete(fn);
}

// ---------- path helpers (relative to the session cwd) ----------

function joinCwd(s: VfsShellSession, p?: string): string {
  const arg = p && p.trim() ? p.trim() : '/';
  if (arg.startsWith('/')) return normalizeVirtualPath(arg);
  const base = s.cwd === '/' ? '' : s.cwd;
  return normalizeVirtualPath(`${base}/${arg}`);
}

function formatEntry(name: string, kind: 'file' | 'dir'): string {
  return kind === 'dir' ? `${name}/` : name;
}

/** Execute ONE VFS shell command. Fully synchronous ops — returns the exit code. */
export function execVfsCommand(s: VfsShellSession, commandInput: string): { code: number } {
  const command = commandInput.trim();
  if (!command) return { code: 0 };
  s.lastActivityAt = new Date().toISOString();
  pushChunk(s, 'in', `${command}\n`);
  s.history.unshift(command);
  if (s.history.length > 100) s.history.length = 100;

  // tokenize (quote-aware, no shell metacharacters — VFS commands are flat)
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(command))) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  const cmd = (tokens.shift() ?? '').toLowerCase();

  // The VFS shell is a FLAT command surface (one command per line — the v1.0.16
  // behavior, preserved). Chaining/piping metacharacters are rejected with a
  // clear error instead of being silently ignored.
  if (/(&&|\|\||;|\||`|\$\()/.test(command) && !(cmd === 'echo' && />/.test(command))) {
    pushChunk(s, 'err', 'vfs: shell chaining/piping (&& || ; | ` $( ) is not supported — run one command per line\n');
    publishExit(s, 2, command);
    return { code: 2 };
  }

  if (cmd && cmd !== 'help' && cmd !== 'clear') {
    const allowed = allowedCommands();
    if (allowed && !allowed.includes(cmd)) {
      pushChunk(s, 'err', `vfs: ${cmd}: not permitted by the vfsTerminal.allowedCommands configuration (Limitations page). Allowed: ${allowed.join(' ') || '(none)'}\n`);
      publishExit(s, 126, command);
      return { code: 126 };
    }
  }

  const vfs = openGlobalVfs();
  let code = 0;
  try {
    switch (cmd) {
      case '': {
        break;
      }
      case 'pwd': {
        pushChunk(s, 'out', `${s.cwd}\n`);
        break;
      }
      case 'help': {
        const allowed = allowedCommands();
        const list = allowed ?? [...VFS_IMPLEMENTED_COMMANDS];
        pushChunk(s, 'out', [
          'sandboxed VFS shell — commands:',
          ...VFS_IMPLEMENTED_COMMANDS.map((c) => `  ${c}${allowed && !allowed.includes(c) ? '  (disabled by configuration)' : ''}`),
          '',
          'pwd · ls [path] · cd <path> · cat <file> · mkdir <dir> · touch <file> ·',
          'rm [-r] <path> · cp <a> <b> · mv <a> <b> · find <query> · echo <text> [> file] · clear · help',
          '',
          `Enabled now: ${list.join(' ') || '(none)'} — configured via Limitations → vfsTerminal.allowedCommands.`,
        ].join('\n') + '\n');
        break;
      }
      case 'clear': {
        s.chunks = [];
        s.seq = 0;
        pushChunk(s, 'meta', '— cleared —\n');
        break;
      }
      case 'ls': {
        const dir = joinCwd(s, tokens[0]);
        const entries = vfs.readdirWithTypes(dir);
        if (entries.length === 0) pushChunk(s, 'out', '(empty)\n');
        else pushChunk(s, 'out', `${entries.map((e) => formatEntry(e.name, e.kind)).join('  ')}\n`);
        break;
      }
      case 'cd': {
        const target = joinCwd(s, tokens[0]);
        const meta = vfs.stat(target);
        if (meta.kind !== 'dir') {
          pushChunk(s, 'err', `vfs: cd: ${tokens[0] ?? '/'}: not a directory\n`);
          code = 1;
        } else {
          s.cwd = target;
          publishCwd(s);
        }
        break;
      }
      case 'cat': {
        if (!tokens[0]) {
          pushChunk(s, 'err', 'vfs: cat: missing file operand\n');
          code = 1;
          break;
        }
        const data = vfs.readFile(joinCwd(s, tokens[0]), 'utf8');
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const cap = 65536;
        pushChunk(s, 'out', text.length > cap ? `${text.slice(0, cap)}\n…[truncated at ${cap} bytes]\n` : text.endsWith('\n') ? text : `${text}\n`);
        break;
      }
      case 'mkdir': {
        if (!tokens[0]) {
          pushChunk(s, 'err', 'vfs: mkdir: missing operand\n');
          code = 1;
          break;
        }
        vfs.mkdir(joinCwd(s, tokens[0]), { recursive: true });
        break;
      }
      case 'touch': {
        if (!tokens[0]) {
          pushChunk(s, 'err', 'vfs: touch: missing file operand\n');
          code = 1;
          break;
        }
        const path = joinCwd(s, tokens[0]);
        try {
          vfs.stat(path);
        } catch {
          vfs.writeFile(path, '');
        }
        break;
      }
      case 'rm': {
        const recursive = tokens[0] === '-r' || tokens[0] === '-rf' || tokens[0] === '-fr';
        const target = tokens[recursive ? 1 : 0];
        if (!target) {
          pushChunk(s, 'err', 'vfs: rm: missing operand\n');
          code = 1;
          break;
        }
        vfs.rm(joinCwd(s, target), { recursive, force: false });
        break;
      }
      case 'cp': {
        if (!tokens[0] || !tokens[1]) {
          pushChunk(s, 'err', 'vfs: cp: missing operand\n');
          code = 1;
          break;
        }
        vfs.copy(joinCwd(s, tokens[0]), joinCwd(s, tokens[1]));
        break;
      }
      case 'mv': {
        if (!tokens[0] || !tokens[1]) {
          pushChunk(s, 'err', 'vfs: mv: missing operand\n');
          code = 1;
          break;
        }
        vfs.rename(joinCwd(s, tokens[0]), joinCwd(s, tokens[1]));
        break;
      }
      case 'find': {
        const query = (tokens[0] ?? '').toLowerCase();
        const startDir = joinCwd(s, '/');
        const hits: string[] = [];
        const walk = (dir: string, depth: number): void => {
          if (depth > 3 || hits.length >= 50) return;
          let entries: { name: string; kind: 'file' | 'dir' }[] = [];
          try {
            entries = vfs.readdirWithTypes(dir);
          } catch {
            return;
          }
          for (const e of entries) {
            const full = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
            if (!query || full.toLowerCase().includes(query)) hits.push(full);
            if (e.kind === 'dir') walk(full, depth + 1);
          }
        };
        const from = joinCwd(s, tokens[0] && !tokens[0].startsWith('-') ? tokens[0] : undefined);
        // `find <query>` keeps the v1.0.16 UX (query relative to cwd)
        walk(s.cwd, 0);
        if (hits.length === 0) pushChunk(s, 'out', '(no matches)\n');
        else pushChunk(s, 'out', `${hits.join('\n')}\n`);
        void startDir;
        void from;
        break;
      }
      case 'echo': {
        // support `echo text > file` / `echo text >> file`
        const joined = tokens.join(' ');
        const redirect = /\s(>>?)\s*(\S+)\s*$/.exec(joined);
        if (redirect) {
          const text = joined.slice(0, redirect.index);
          const append = redirect[1] === '>>';
          const target = joinCwd(s, redirect[2]);
          let existing = '';
          if (append) {
            try {
              const prev = vfs.readFile(target, 'utf8');
              existing = typeof prev === 'string' ? prev : prev.toString('utf8');
            } catch { /* new file */ }
          }
          vfs.writeFile(target, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${text}\n`);
        } else {
          pushChunk(s, 'out', `${joined}\n`);
        }
        break;
      }
      default: {
        pushChunk(s, 'err', `vfs: ${cmd}: command not found — implemented: ${VFS_IMPLEMENTED_COMMANDS.join(' ')}\n`);
        code = 127;
      }
    }
  } catch (err) {
    code = 1;
    if (err instanceof VirtualFsError) {
      pushChunk(s, 'err', `vfs: ${cmd}: ${err.message}\n`);
    } else {
      pushChunk(s, 'err', `vfs: ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  publishExit(s, code, command);
  return { code };
}
