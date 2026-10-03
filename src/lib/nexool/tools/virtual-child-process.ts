/**
 * NexTool v1.0.6 → v1.0.8 — RESTRICTED `child_process` for the nodejs environment
 * (spec v1.0.6 §4–§4.4, v1.0.8 §3/§14).
 *
 * Commands NEVER touch the host system: there is no real process spawn at
 * all. Instead a documented command set is executed VIRTUALLY against the
 * tool's Virtual FS workspace through ONE centralized policy (§3.13):
 *
 *   Command
 *     ↓ tokenizer (quotes; shell metacharacters rejected)
 *     ↓ Command Resolver (allowlist = the COMMANDS registry below)
 *     ↓ Virtual Runtime (VFS-backed, execution limits inherited)
 *     ↓ Virtual FS (never the host filesystem)
 *
 * v1.0.6 commands (all preserved): ls cat head tail echo printf pwd wc grep
 * sort uniq date mkdir touch rm cp mv basename dirname env true false
 *
 * v1.0.8 additions: cd (persistent per-execution working directory, §3.8/§3.9),
 * clear (virtual terminal, §3.10), find tree du df cut tr sed awk xargs tee
 * yes sleep which whoami uname realpath readlink — plus REAL virtualized
 * `node` (§3.3: JS programs execute inside the NexTool sandbox inheriting the
 * Virtual FS, network policy and execution limits) and `npm` (§3.4–§3.7:
 * init/install/uninstall/run/ls operating entirely inside the tool's
 * isolated VFS workspace — packages install into /workspace/node_modules,
 * never the host node_modules; lifecycle scripts are NOT auto-executed so
 * `npm install` can never become arbitrary code execution).
 *
 * Policy (§3.14/§3.15):
 *  - working directory is always inside the tool's virtual workspace
 *  - shell escapes ( ; && || ` $( > < & ) are rejected outright
 *  - pipes/args/processes/output/timeouts bounded by the CENTRAL limits
 *    (childProcess.* from config/configuration-limits.json)
 *  - the effective tool execution timeout RAISES the per-command ceiling
 *    (v1.0.7 §1) — a child operation never uses a shorter hard-coded timeout
 *  - unknown/blocked commands fail with exit code 127 and a pointed stderr —
 *    no hidden path around the policy (§3.14)
 *
 * Exposed API subset: exec, execFile, spawn, spawnSync, execSync — every
 * creation path enforces the identical policy. Async commands (sleep, node
 * with pending timers, npm) are only available through the async APIs
 * (exec/execFile/spawn); execSync reports them honestly.
 */

import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import zlib from 'node:zlib';
import type { VirtualFsSession } from './vfs';
import { getLimitProperty, getResolvedLimits, type ResolvedRuntimeLimits } from '../config-limits';
import { createNetworkAccounting, policyFetch, type NetworkAccounting } from './sandbox-net';

export type ChildProcessLimitsConfig = ResolvedRuntimeLimits['childProcess'];

/** §3.15 — live child-process limits from the CENTRAL configuration. */
export function getChildProcessLimits(): ChildProcessLimitsConfig {
  return getResolvedLimits().childProcess;
}

/** Shipped limits (compatibility snapshot — enforcement uses getChildProcessLimits()). */
export const CHILD_PROCESS_LIMITS = {
  timeoutMs: 8_000,
  maxOutputBytes: 64 * 1024,
  /** v1.0.8 — raised from 4 to 64: realistic multi-command workflows
   *  (§3.11 project creation, npm run) need far more than 4 invocations. */
  maxProcessesPerExecution: 64,
  maxPipeStages: 3,
  maxArgs: 32,
  npmMaxPackages: 25,
} as const;

/** Every command the resolver accepts (v1.0.6 set + v1.0.8 additions). */
export const VIRTUAL_COMMANDS = [
  // v1.0.6 (preserved)
  'ls', 'cat', 'head', 'tail', 'echo', 'printf', 'pwd', 'wc', 'grep', 'sort', 'uniq',
  'date', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'basename', 'dirname', 'env', 'true', 'false',
  // v1.0.8 additions (§3.2/§3.8/§3.10/§3.3/§3.4)
  'cd', 'clear', 'find', 'tree', 'du', 'df', 'cut', 'tr', 'sed', 'awk', 'xargs',
  'tee', 'yes', 'sleep', 'which', 'whoami', 'uname', 'realpath', 'readlink',
  'node', 'npm',
] as const;

/** Human-facing command descriptions (docs + Tool IDE reference). */
export const VIRTUAL_COMMAND_INFO: Record<string, string> = {
  ls: 'list directory contents', cat: 'concatenate files to stdout', head: 'first lines of input',
  tail: 'last lines of input', echo: 'print arguments', printf: 'formatted print', pwd: 'print working directory',
  wc: 'line/word/byte count', grep: 'pattern search (-i -v -n)', sort: 'sort lines (-r)', uniq: 'drop adjacent duplicates',
  date: 'ISO timestamp', mkdir: 'create directories (-p)', touch: 'create empty files', rm: 'remove files/dirs (-r -f)',
  cp: 'copy paths', mv: 'move/rename paths', basename: 'strip directory from a path', dirname: 'strip last path component',
  env: 'print the virtual environment', true: 'no-op, exit 0', false: 'no-op, exit 1',
  cd: 'change the session working directory (persists across commands in this execution)',
  clear: 'clear the virtual terminal output (ANSI clear)',
  find: 'walk the VFS (-name glob -type f|d)', tree: 'ASCII directory tree', du: 'disk usage per path (-s -h)',
  df: 'virtual filesystem usage', cut: 'select fields (-d -f)', tr: 'translate/delete characters (-d, a-z ranges)',
  sed: 'stream editor — s/pat/repl/[gi] and /pat/d', awk: 'minimal awk — {print $n} with optional /pattern/ and -F',
  xargs: 'append stdin words as arguments to the next command', tee: 'write stdin to files and pass through (-a)',
  yes: 'repeat a line (bounded by the output cap)', sleep: 'pause the virtual command (async exec only)',
  which: 'locate a virtual command', whoami: 'print the virtual user (nextool)', uname: 'virtual system name (-a -s -r -m)',
  realpath: 'resolve a virtual path (must exist)', readlink: 'always EINVAL — the VFS has no symlinks',
  node: 'execute a JavaScript program inside the NexTool sandbox (Virtual FS + network policy + execution limits)',
  npm: 'virtual npm — init/install/uninstall/run/ls inside the isolated VFS workspace (registry access via the network policy; lifecycle scripts are NOT auto-run)',
};

export class ChildProcessPolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ChildProcessPolicyError';
    this.code = code;
  }
}

// ---------- tokenizer ----------

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) throw new ChildProcessPolicyError('EBADSHELL', 'child_process policy: unterminated quote.');
  if (current) tokens.push(current);
  return tokens;
}

function splitPipes(command: string): string[] {
  const stages: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|') {
      stages.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  stages.push(current.trim());
  return stages;
}

function assertNoShellEscape(command: string): void {
  const dangerous = [/&&/, /\|\|/, /;/, /`/, /\$\(/, />/, /</, /&/, /\n/, /\r/];
  for (const re of dangerous) {
    if (re.test(command)) {
      throw new ChildProcessPolicyError(
        'EBADSHELL',
        `child_process policy: shell metacharacters are not permitted — only simple commands joined by single pipes run inside the virtual workspace.`,
      );
    }
  }
}

// ---------- io plumbing ----------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandIO {
  session: VirtualFsSession;
  /** §3.8/§3.9 — the SESSION working directory (persists across commands). */
  shell: { cwd: string; prev: string | null };
  stdin: string;
  env: Record<string, string>;
  limits: ChildProcessLimitsConfig;
  processCount: { n: number };
  accounting?: NetworkAccounting;
  /** false inside execSync — async commands (sleep/npm/async node) report honestly. */
  asyncAllowed: boolean;
  deadlineAt: number;
}

const out = (s: string): RunResult => ({ stdout: s, stderr: '', exitCode: 0 });
const err = (message: string, code = 1): RunResult => ({ stdout: '', stderr: message.endsWith('\n') ? message : message + '\n', exitCode: code });

function joinCwd(io: CommandIO, p: string | undefined, fallback = ''): string {
  const raw = p && p.length > 0 ? p : fallback;
  const abs = raw.startsWith('/') ? raw : (io.shell.cwd === '/' ? '' : io.shell.cwd) + '/' + raw;
  return abs.replace(/\/+/g, '/');
}

function readInputText(io: CommandIO, files: string[]): string | RunResult {
  if (files.length === 0) return io.stdin;
  let text = '';
  for (const f of files) {
    try {
      text += io.session.readFile(joinCwd(io, f), 'utf8') as string;
    } catch (e) {
      return err(`cat: ${(e as Error).message}`);
    }
  }
  return text;
}

function humanBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}`;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// ---------- the command registry (§3.13 — ONE centralized policy) ----------

type CommandHandler = (argv: string[], io: CommandIO) => RunResult | Promise<RunResult>;

const COMMANDS: Record<string, CommandHandler> = {
  // ----- trivial / text basics -----
  true: () => out(''),
  false: () => ({ stdout: '', stderr: '', exitCode: 1 }),
  pwd: (_argv, io) => out(io.shell.cwd + '\n'),
  echo: (args) => out(args.filter((a) => a !== '-e' && a !== '-n').join(' ') + '\n'),
  printf: (args) => {
    if (args.length === 0) return err('printf: missing format string');
    return out(args[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/%s/g, args[1] ?? ''));
  },
  date: () => out(new Date().toISOString() + '\n'),
  env: (_argv, io) => out(Object.entries(io.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'),
  basename: (args) => {
    if (args.length === 0) return err('basename: missing operand');
    return out(args[0].split('/').filter(Boolean).pop() + '\n');
  },
  dirname: (args) => {
    if (args.length === 0) return err('dirname: missing operand');
    return out((args[0].split('/').slice(0, -1).join('/') || '/') + '\n');
  },
  whoami: () => out('nextool\n'),
  uname: (args) => {
    if (args.includes('-a')) return out('NextTool nextool-virtual 1.0.8 #1 SMP nextool-sandbox x86_64 GNU/Virtual\n');
    if (args.includes('-s')) return out('NextTool\n');
    if (args.includes('-r')) return out('1.0.8\n');
    if (args.includes('-m')) return out('x86_64\n');
    return out('NextTool\n');
  },
  which: (args, io) => {
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) return err('which: missing operand');
    if (name in COMMANDS) return out(`/virtual/bin/${name}\n`);
    return err(`which: no ${name} in (/virtual/bin) — the NexTool virtual environment only exposes: ${Object.keys(COMMANDS).join(' ')}`);
  },
  clear: () => out('\x1b[2J\x1b[H'),
  realpath: (args, io) => {
    if (args.length === 0) return err('realpath: missing operand');
    try {
      return out(io.session.realpath(joinCwd(io, args[0])) + '\n');
    } catch (e) {
      return err(`realpath: ${(e as Error).message}`);
    }
  },
  readlink: (args) => {
    if (args.length === 0) return err('readlink: missing operand');
    // The Virtual FS has no symlinks (§2.6) — honest EINVAL for every operand.
    return err(`readlink: EINVAL: invalid argument — the Virtual FS has no symbolic links.`);
  },
  sleep: (args, io) => {
    if (!io.asyncAllowed) {
      return err('sleep: async commands require exec()/spawn() — execSync cannot pause without blocking the runtime.');
    }
    const secs = Math.max(0, Number(args[0]) || 0);
    const remaining = Math.max(0, io.deadlineAt - Date.now());
    const waitMs = Math.min(Math.round(secs * 1000), remaining);
    return new Promise<RunResult>((resolve) => {
      setTimeout(() => {
        if (Math.round(secs * 1000) > remaining) {
          resolve(err(`sleep: exceeded the command deadline (${remaining}ms remaining)`, 124));
        } else {
          resolve(out(''));
        }
      }, waitMs);
    });
  },
  yes: (args) => {
    // Bounded honestly: generates up to the configured output cap, then stops.
    const line = (args[0] ?? 'y') + '\n';
    const cap = getChildProcessLimits().maxOutputBytes;
    const repeat = Math.max(1, Math.floor(cap / Buffer.byteLength(line, 'utf8')));
    return out(line.repeat(Math.min(repeat, 100_000)));
  },
  tee: (args, io) => {
    const append = args.includes('-a');
    const files = args.filter((a) => !a.startsWith('-'));
    for (const f of files) {
      try {
        const p = joinCwd(io, f);
        if (append && io.session.exists(p)) io.session.appendFile(p, io.stdin);
        else io.session.writeFile(p, io.stdin);
      } catch (e) {
        return err(`tee: ${(e as Error).message}`);
      }
    }
    return out(io.stdin);
  },

  // ----- filesystem (VFS-backed) -----
  cd: (args, io) => {
    // §3.8 — the session working directory lives inside the VFS; escaping it
    // is impossible (normalize/realpath reject traversal beyond the root).
    // POSIX semantics: `cd ..` AT the root stays at the root (clamped).
    const target = args.find((a) => !a.startsWith('-')) ?? '/workspace';
    const next = target === '-' && io.shell.prev ? io.shell.prev : joinCwd(io, target, '/workspace');
    const clampToRoot = (p: string): string => {
      const stack: string[] = [];
      for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { stack.pop(); continue; }
        stack.push(seg);
      }
      return '/' + stack.join('/');
    };
    try {
      const resolved = io.session.realpath(clampToRoot(next === '' ? '/' : next));
      if (io.session.stat(resolved).kind !== 'dir') {
        return err(`cd: not a directory: ${target}`);
      }
      io.shell.prev = io.shell.cwd;
      io.shell.cwd = resolved;
      return out('');
    } catch (e) {
      return err(`cd: ${(e as Error).message}`);
    }
  },
  ls: (args, io) => {
    const target = joinCwd(io, args.find((a) => !a.startsWith('-')));
    let names: string[];
    try {
      names = io.session.readdir(target === '' ? io.shell.cwd : target);
    } catch (e) {
      return err(`ls: ${(e as Error).message}`);
    }
    const long = args.includes('-l') || args.includes('-la') || args.includes('-al');
    if (long) {
      return out(names.map((n) => `rw-r--r-- 1 nextool nextool ${n}`).join('\n') + (names.length ? '\n' : ''));
    }
    return out(names.join('\n') + (names.length ? '\n' : ''));
  },
  cat: (args, io) => {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length === 0) return out(io.stdin);
    let text = '';
    for (const f of files) {
      try {
        text += io.session.readFile(joinCwd(io, f), 'utf8') as string;
      } catch (e) {
        return err(`cat: ${(e as Error).message}`);
      }
    }
    return out(text);
  },
  head: (args, io) => headTail('head', args, io),
  tail: (args, io) => headTail('tail', args, io),
  wc: (args, io) => {
    const source = readInputText(io, args.filter((a) => !a.startsWith('-')));
    if (typeof source !== 'string') return source;
    const lines = source === '' ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    const words = source.split(/\s+/).filter(Boolean).length;
    const chars = Buffer.byteLength(source, 'utf8');
    if (args.includes('-l')) return out(`${lines}\n`);
    if (args.includes('-w')) return out(`${words}\n`);
    if (args.includes('-c')) return out(`${chars}\n`);
    return out(`${String(lines).padStart(8)}${String(words).padStart(8)}${String(chars).padStart(8)}\n`);
  },
  grep: (args, io) => {
    const flags = args.filter((a) => a.startsWith('-'));
    const operands = args.filter((a) => !a.startsWith('-'));
    const pattern = operands[0];
    const files = operands.slice(1);
    if (!pattern) return err('grep: missing pattern');
    const insensitive = flags.includes('-i');
    const invert = flags.includes('-v');
    const numbered = flags.includes('-n');
    let re: RegExp;
    try {
      re = new RegExp(pattern, insensitive ? 'i' : '');
    } catch {
      return err('grep: invalid pattern');
    }
    const processText = (text: string, name?: string): RunResult => {
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const prefix = name && files.length > 1 ? `${name}:` : '';
      const hits: string[] = [];
      lines.forEach((line, idx) => {
        if (re.test(line) !== invert) hits.push(`${prefix}${numbered && !name ? `${idx + 1}:` : ''}${line}`);
      });
      return out(hits.length > 0 ? hits.join('\n') + '\n' : '');
    };
    if (files.length === 0) return processText(io.stdin);
    let combined = '';
    for (const f of files) {
      try {
        const text = io.session.readFile(joinCwd(io, f), 'utf8') as string;
        const r = processText(text, f);
        if (r.exitCode !== 0) return r;
        combined += r.stdout;
      } catch (e) {
        return err(`grep: ${(e as Error).message}`);
      }
    }
    return out(combined);
  },
  sort: (args, io) => {
    const source = readInputText(io, args.filter((a) => !a.startsWith('-')));
    if (typeof source !== 'string') return source;
    const lines = source.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const sorted = args.includes('-r') ? lines.sort().reverse() : lines.sort();
    return out(sorted.join('\n') + (sorted.length ? '\n' : ''));
  },
  uniq: (args, io) => {
    const source = readInputText(io, args.filter((a) => !a.startsWith('-')));
    if (typeof source !== 'string') return source;
    const lines = source.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const deduped = lines.filter((line, idx) => idx === 0 || line !== lines[idx - 1]);
    return out(deduped.join('\n') + (deduped.length ? '\n' : ''));
  },
  cut: (args, io) => {
    let delim = '\t';
    let fields = '';
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-d') delim = args[++i] ?? '\t';
      else if (a.startsWith('-d')) delim = a.slice(2) || '\t';
      else if (a === '-f') fields = args[++i] ?? '1';
      else if (a.startsWith('-f')) fields = a.slice(2);
      else if (!a.startsWith('-')) files.push(a);
    }
    const source = readInputText(io, files);
    if (typeof source !== 'string') return source;
    const indices = parseFieldList(fields || '1');
    if (!indices) return err('cut: invalid field list');
    const outLines = source.split('\n').map((line) => {
      if (line === '') return line;
      const parts = line.split(delim);
      return indices.filter((n) => n >= 1 && n <= parts.length).map((n) => parts[n - 1]).join(delim);
    });
    return out(outLines.join('\n'));
  },
  tr: (args, io) => {
    const del = args.includes('-d');
    const sets = args.filter((a) => !a.startsWith('-'));
    const source = readInputText(io, []);
    if (typeof source !== 'string') return source;
    if (del) {
      if (sets.length === 0) return err('tr: missing operand');
      const deleteChars = expandSet(sets[0]);
      return out([...source].filter((c) => !deleteChars.includes(c)).join(''));
    }
    if (sets.length < 2) return err('tr: missing operand (need SET1 [SET2])');
    const from = expandSet(sets[0]);
    const to = expandSet(sets[1]);
    return out([...source].map((c) => {
      const idx = from.indexOf(c);
      if (idx === -1) return c;
      return to[Math.min(idx, to.length - 1)] ?? to[to.length - 1] ?? c;
    }).join(''));
  },
  sed: (args, io) => {
    const scripts: string[] = [];
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e') scripts.push(args[++i] ?? '');
      else if (!args[i].startsWith('-')) {
        if (scripts.length === 0 && /s./.test(args[i])) scripts.push(args[i]);
        else files.push(args[i]);
      }
    }
    const parsed: ({ re: RegExp; repl: string; g: boolean } | { re: RegExp; del: true })[] = [];
    for (const s of scripts) {
      const sub = /^s(.)(.*?)\1(.*)\1([gi]*)$/.exec(s);
      if (sub) {
        try {
          parsed.push({ re: new RegExp(sub[2], sub[4].includes('i') ? 'gi' : (sub[4].includes('g') ? 'g' : '')), repl: sub[3].replace(/\\(.)?/g, (m, c) => (c === undefined ? '' : c === 'n' ? '\n' : c)), g: sub[4].includes('g') });
        } catch {
          return err('sed: invalid pattern');
        }
        continue;
      }
      const del = /^(\/)(.*)\1d?$/.exec(s);
      if (del && s.endsWith('d')) {
        try {
          parsed.push({ re: new RegExp(del[2]), del: true });
        } catch {
          return err('sed: invalid pattern');
        }
        continue;
      }
      return err(`sed: unsupported script "${s}" — the NexTool virtual sed supports s/pat/repl/[gi] and /pat/d.`);
    }
    const source = readInputText(io, files);
    if (typeof source !== 'string') return source;
    const lines = source.split('\n');
    const result = lines.filter((line) => {
      for (const p of parsed) {
        if ('del' in p && p.del && p.re.test(line)) return false;
      }
      return true;
    }).map((line) => {
      for (const p of parsed) {
        if ('del' in p) continue;
        line = p.g ? line.replace(p.re, p.repl) : line.replace(p.re, p.repl);
      }
      return line;
    });
    return out(result.join('\n'));
  },
  awk: (args, io) => {
    let sep = /\s+/;
    let program = '';
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-F') sep = new RegExp(`[${(args[++i] ?? ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
      else if (args[i].startsWith('-F') && args[i].length > 2) sep = new RegExp(`[${args[i].slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
      else if (!program && args[i].includes('{') && (args[i].startsWith('{') || args[i].startsWith('/'))) program = args[i];
      else if (!args[i].startsWith('-')) files.push(args[i]);
    }
    if (!program) return err('awk: missing program');
    const source = readInputText(io, files);
    if (typeof source !== 'string') return source;
    const m = /^(\/([^/]*)\/)?\s*\{(.*)\}$/.exec(program);
    if (!m) return err(`awk: unsupported program "${program}" — the NexTool virtual awk supports [{/pattern/}] {print} / {print $n} / {print $n, $m} / {print "text"} / {print NF} / {print NR}.`);
    const filter = m[2] !== undefined ? new RegExp(m[2]) : null;
    const body = m[3].trim();
    const printMatch = /^print\s*(.*)$/.exec(body);
    if (!printMatch) return err(`awk: unsupported action {${body}} — only print expressions are supported.`);
    const items = printMatch[1].trim() === '' ? ['$0'] : splitTopLevel(printMatch[1]);
    const lines = source.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
    const resultLines: string[] = [];
    lines.forEach((line, idx) => {
      if (filter && !filter.test(line)) return;
      const fields = line.trim().length === 0 ? [] : line.trim().split(sep);
      const resolve = (raw: string): string => {
        const item = raw.trim();
        if (item === '$0') return line;
        if (/^\$\d+$/.test(item)) return fields[Number(item.slice(1)) - 1] ?? '';
        if (item === '$NF' || item === 'NF') return String(fields.length);
        if (item === 'NR') return String(idx + 1);
        if (/^".*"$/.test(item)) return item.slice(1, -1);
        if (/^\d+$/.test(item)) return item;
        return `awk: unsupported expression "${item}"`;
      };
      const rendered = items.map(resolve);
      if (rendered.some((r) => r.startsWith('awk: unsupported'))) {
        return;
      }
      resultLines.push(rendered.join(' '));
    });
    return out(resultLines.join('\n') + (resultLines.length ? '\n' : ''));
  },
  find: (args, io) => {
    let start = args.find((a) => !a.startsWith('-')) ?? '.';
    let nameGlob: string | null = null;
    let typeFilter: 'f' | 'd' | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name') nameGlob = args[++i] ?? null;
      if (args[i] === '-type') typeFilter = (args[++i] as 'f' | 'd') ?? null;
    }
    const baseAbs = start === '.' ? io.shell.cwd : joinCwd(io, start);
    const prefix = start === '.' ? './' : (start.endsWith('/') ? start : `${start}/`);
    const emitRoot = start === '.' ? '.' : start;
    const results: string[] = [];
    const push = (rel: string, kind: 'file' | 'dir') => {
      if (typeFilter === 'f' && kind !== 'file') return;
      if (typeFilter === 'd' && kind !== 'dir') return;
      results.push(rel);
    };
    try {
      const rootKind = io.session.stat(baseAbs).kind;
      push(emitRoot, rootKind);
      // children print as `<start>/<relative>` (or `./<relative>` from '.')
      const walk = (abs: string, rel: string) => {
        for (const entry of io.session.readdirWithTypes(abs)) {
          const relPath = rel === '' ? `${prefix}${entry.name}` : `${rel}/${entry.name}`;
          push(relPath, entry.kind);
          if (entry.kind === 'dir') walk(`${abs}/${entry.name}`, relPath);
        }
      };
      if (rootKind === 'dir') walk(baseAbs, '');
    } catch (e) {
      return err(`find: ${(e as Error).message}`);
    }
    const filtered = nameGlob ? results.filter((r) => globToRegExp(nameGlob).test(r.split('/').pop() ?? r)) : results;
    return out(filtered.join('\n') + (filtered.length ? '\n' : ''));
  },
  tree: (args, io) => {
    const start = args.find((a) => !a.startsWith('-')) ?? '.';
    const baseAbs = start === '.' ? io.shell.cwd : joinCwd(io, start);
    const lines: string[] = [start === '.' ? '.' : start];
    let dirs = 0;
    let files = 0;
    const walk = (abs: string, depth: number) => {
      const entries = io.session.readdirWithTypes(abs);
      entries.forEach((entry, i) => {
        const last = i === entries.length - 1;
        // every child level gets real tree connectors (GNU tree style)
        lines.push(`${'│  '.repeat(depth)}${last ? '└── ' : '├── '}${entry.name}${entry.kind === 'dir' ? '/' : ''}`);
        if (entry.kind === 'dir') {
          dirs += 1;
          walk(`${abs}/${entry.name}`, depth + 1);
        } else {
          files += 1;
        }
      });
    };
    try {
      walk(baseAbs, 0);
    } catch (e) {
      return err(`tree: ${(e as Error).message}`);
    }
    lines.push('', `${dirs} directories, ${files} files`);
    return out(lines.join('\n') + '\n');
  },
  du: (args, io) => {
    const summary = args.includes('-s') || args.includes('-sh');
    const human = args.includes('-h') || args.includes('-sh');
    const targets = args.filter((a) => !a.startsWith('-'));
    const measure = (abs: string): number => {
      const e = io.session.stat(abs);
      if (e.kind === 'file') return e.size;
      let total = 0;
      for (const entry of io.session.readdirWithTypes(abs)) {
        total += measure(`${abs}/${entry.name}`);
      }
      return total;
    };
    const list = targets.length > 0 ? targets : ['.'];
    const rows: string[] = [];
    for (const t of list) {
      try {
        const abs = t === '.' ? io.shell.cwd : joinCwd(io, t);
        const bytes = measure(abs);
        rows.push(`${human ? humanBytes(bytes) : Math.max(1, Math.ceil(bytes / 1024))}\t${t}`);
        if (!summary) {
          for (const entry of io.session.readdirWithTypes(abs)) {
            const childAbs = `${abs}/${entry.name}`;
            const b = measure(childAbs);
            rows.push(`${human ? humanBytes(b) : Math.max(1, Math.ceil(b / 1024))}\t${t === '.' ? `./${entry.name}` : `${t}/${entry.name}`}`);
          }
        }
      } catch (e) {
        return err(`du: ${(e as Error).message}`);
      }
    }
    return out(rows.join('\n') + '\n');
  },
  df: (_args, io) => {
    const usage = io.session.usage();
    const totalK = Math.ceil(usage.limits.maxTotalBytes / 1024);
    const usedK = Math.ceil(usage.usedBytes / 1024);
    const availK = Math.max(0, totalK - usedK);
    const pct = totalK > 0 ? Math.round((usedK / totalK) * 100) : 0;
    return out(
      `Filesystem     1K-blocks     Used Available Use% Mounted on\n` +
      `nextool-vfs  ${String(totalK).padStart(10)} ${String(usedK).padStart(7)} ${String(availK).padStart(9)} ${String(pct).padStart(3)}% /\n`,
    );
  },
  mkdir: (args, io) => {
    const targets = args.filter((a) => !a.startsWith('-'));
    const recursive = args.includes('-p');
    if (targets.length === 0) return err('mkdir: missing operand');
    for (const t of targets) {
      try {
        io.session.mkdir(joinCwd(io, t), { recursive });
      } catch (e) {
        return err(`mkdir: ${(e as Error).message}`);
      }
    }
    return out('');
  },
  touch: (args, io) => {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (targets.length === 0) return err('touch: missing operand');
    for (const t of targets) {
      try {
        const p = joinCwd(io, t);
        if (!io.session.exists(p)) io.session.writeFile(p, '');
      } catch (e) {
        return err(`touch: ${(e as Error).message}`);
      }
    }
    return out('');
  },
  rm: (args, io) => {
    const targets = args.filter((a) => !a.startsWith('-'));
    const recursive = args.includes('-r') || args.includes('-rf');
    const force = args.includes('-f') || args.includes('-rf');
    if (targets.length === 0) return err('rm: missing operand');
    for (const t of targets) {
      try {
        io.session.rm(joinCwd(io, t), { recursive, force });
      } catch (e) {
        if (!force) return err(`rm: ${(e as Error).message}`);
      }
    }
    return out('');
  },
  cp: (args, io) => twoPath('cp', args, io, false),
  mv: (args, io) => twoPath('mv', args, io, true),

  // ----- virtual runtimes (§3.3/§3.4) -----
  node: (args, io) => {
    // `node -e "<code>"` — evaluate inline code inside the same sandbox.
    const eIdx = args.indexOf('-e');
    if (eIdx !== -1 && typeof args[eIdx + 1] === 'string') {
      const code = args[eIdx + 1];
      const rest = [...args.slice(0, eIdx), ...args.slice(eIdx + 2)];
      const scriptArg = rest.find((a) => !a.startsWith('-'));
      const scriptPath = scriptArg ? joinCwd(io, scriptArg) : '/workspace/[eval]';
      return io.asyncAllowed
        ? runNodeProgram(scriptPath, code, io, rest.filter((a) => a !== scriptArg))
        : runNodeProgramSync(scriptPath, code, io, rest.filter((a) => a !== scriptArg));
    }
    const script = args.find((a) => !a.startsWith('-'));
    if (!script) return err('node: no entry file specified (usage: node <script.js> [args])');
    const scriptPath = joinCwd(io, script);
    let source: string;
    try {
      source = io.session.readFile(scriptPath, 'utf8') as string;
      if (io.session.stat(scriptPath).kind !== 'file') throw new Error('not a file');
    } catch (e) {
      return err(`node: cannot find module '${script}': ${(e as Error).message}`);
    }
    const argvTail = args.filter((a) => a !== script);
    if (!io.asyncAllowed) return runNodeProgramSync(scriptPath, source, io, argvTail);
    return runNodeProgram(scriptPath, source, io, argvTail);
  },
  npm: (args, io) => runNpmCommand(args, io),
};

function twoPath(cmd: string, args: string[], io: CommandIO, move: boolean): RunResult {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length < 2) return err(`${cmd}: missing destination file operand`);
  try {
    io.session.copy(joinCwd(io, targets[0]), joinCwd(io, targets[1]));
    if (move) io.session.rm(joinCwd(io, targets[0]), { recursive: true, force: true });
  } catch (e) {
    return err(`${cmd}: ${(e as Error).message}`);
  }
  return out('');
}

function headTail(cmd: 'head' | 'tail', args: string[], io: CommandIO): RunResult {
  // `-n <value>` — the value token is not a file operand
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') { i++; continue; }
    if (!args[i].startsWith('-')) files.push(args[i]);
  }
  const nIdx = args.indexOf('-n');
  const n = nIdx !== -1 && args[nIdx + 1] ? Math.max(1, Math.min(10_000, Number(args[nIdx + 1]) || 10)) : 10;
  const source = readInputText(io, files);
  if (typeof source !== 'string') return source;
  const lines = source.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return out((cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') + (lines.length ? '\n' : ''));
}

function parseFieldList(list: string): number[] | null {
  const outN: number[] = [];
  for (const part of list.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) outN.push(i);
      continue;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) return null;
    outN.push(n);
  }
  return outN.length > 0 ? outN : null;
}

function expandSet(set: string): string[] {
  const chars: string[] = [];
  for (let i = 0; i < set.length; i++) {
    if (set[i + 1] === '-' && set[i + 2] !== undefined) {
      const from = set.charCodeAt(i);
      const to = set.charCodeAt(i + 2);
      for (let c = from; c <= to; c++) chars.push(String.fromCharCode(c));
      i += 2;
      continue;
    }
    chars.push(set[i]);
  }
  return chars;
}

function splitTopLevel(expr: string): string[] {
  const items: string[] = [];
  let current = '';
  let inString = false;
  for (const ch of expr) {
    if (ch === '"') {
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === ',' && !inString) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

// ---------- virtual node (§3.3) ----------

interface NodeProgramResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a JavaScript program inside the NexTool sandbox: node:vm context
 * with the Virtual FS (fs → VFS), the controlled network layer (fetch →
 * policyFetch), virtual os/timers/http(s), VFS + workspace node_modules
 * require() resolution, execution limits inherited (sync cap, output cap,
 * per-command deadline) and a minimal process shim. The program NEVER gets
 * the host filesystem, host process control or unrestricted network.
 */
function runNodeProgram(scriptPath: string, source: string, io: CommandIO, argvTail: string[]): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;
  let exitSetter = (c: number) => { exitCode = c; };
  let pendingTimers = 0;
  const writeOut = (s: string) => {
    stdoutChunks.push(s);
    if (stdoutChunks.join('').length > io.limits.maxOutputBytes) stdoutChunks.splice(0, stdoutChunks.length - 1);
  };
  const writeErr = (s: string) => {
    stderrChunks.push(s);
    if (stderrChunks.join('').length > io.limits.maxOutputBytes) stderrChunks.splice(0, stderrChunks.length - 1);
  };

  const sandboxSetTimeout = (cb: (...a: unknown[]) => void, ms?: number): ReturnType<typeof setTimeout> => {
    pendingTimers += 1;
    const t = setTimeout(() => {
      pendingTimers -= 1;
      try { cb(); } catch (e) { writeErr(`Uncaught ${(e as Error).message}\n`); exitSetter(1); }
    }, Math.max(0, Number(ms) || 0));
    if (typeof t.unref === 'function') t.unref();
    return t;
  };
  const sandboxClearTimeout = (t?: unknown): void => { void t; };

  const dir = scriptPath.slice(0, scriptPath.lastIndexOf('/')) || '/';
  const modObj = { exports: {} as Record<string, unknown> };
  const moduleCache = new Map<string, unknown>();
  const requireFn = makeNodeRequire(io, dir, moduleCache, writeOut, writeErr, (c) => exitSetter(c), sandboxSetTimeout, sandboxClearTimeout);

  return new Promise<RunResult>((resolve) => {
    try {
      const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`;
      const compiled = new vm.Script(wrapper, { filename: `vfs:${scriptPath}` });
      const fn = compiled.runInNewContext(buildNodeSandbox(io, scriptPath, dir, stdoutChunks, stderrChunks, () => exitCode, (c) => exitSetter(c), sandboxSetTimeout, requireFn, argvTail)) as (...a: unknown[]) => void;
      fn(modObj.exports, requireFn, modObj, scriptPath, dir);
    } catch (e) {
      writeErr(`${(e as Error).name ?? 'Error'}: ${(e as Error).message}\n`);
      resolve({ stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: exitCode ?? 1 });
      return;
    }

    const deadlineHit = () => Date.now() >= io.deadlineAt;
    const drain = () => {
      if (pendingTimers <= 0 || deadlineHit()) {
        resolve({
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          exitCode: exitCode ?? (deadlineHit() && pendingTimers > 0 ? 124 : 0),
        });
        return;
      }
      setTimeout(drain, 10).unref?.();
    };
    // microtask + timer drain
    setTimeout(drain, 5).unref?.();
  });
}

/** Build the sandbox global object for a virtual node program (§3.3). */
function buildNodeSandbox(
  io: CommandIO,
  scriptPath: string,
  dir: string,
  stdoutChunks: string[],
  stderrChunks: string[],
  getExit: () => number | null,
  setExit: (code: number) => void,
  sandboxSetTimeout: (cb: (...a: unknown[]) => void, ms?: number) => ReturnType<typeof setTimeout>,
  requireFn: (specifier: string) => unknown,
  argvTail: string[] = [],
): Record<string, unknown> {
  const fmt = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ');
  return {
    console: {
      log: (...a: unknown[]) => { stdoutChunks.push(fmt(a) + '\n'); },
      info: (...a: unknown[]) => { stdoutChunks.push(fmt(a) + '\n'); },
      warn: (...a: unknown[]) => { stderrChunks.push(fmt(a) + '\n'); },
      error: (...a: unknown[]) => { stderrChunks.push(fmt(a) + '\n'); },
    },
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout: sandboxSetTimeout,
    clearTimeout: () => {},
    setInterval: sandboxSetTimeout,
    clearInterval: () => {},
    fetch: (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => policyFetch(input, init ?? {}, io.accounting),
    require: requireFn,
    process: {
      argv: ['node', scriptPath, ...argvTail],
      env: { ...io.env },
      platform: 'nextool-virtual',
      arch: 'x64',
      cwd: () => io.shell.cwd,
      exit: (code?: number) => setExit(code ?? 0),
      exitCode: getExit(),
      stdout: { write: (s: string) => { stdoutChunks.push(String(s)); return true; } },
      stderr: { write: (s: string) => { stderrChunks.push(String(s)); return true; } },
    },
    __filename: scriptPath,
    __dirname: dir,
  };
}

/**
 * require() inside virtual node programs: relative VFS paths, workspace
 * node_modules packages (npm-installed) and the SAME narrow allowlisted set
 * of Node surfaces as the tool environment (fs → the Virtual FS).
 */
function makeNodeRequire(
  io: CommandIO,
  /** The DIRECTORY of the module doing the requiring — bare specifiers
   *  (npm-installed packages) resolve from here walking up to /workspace. */
  fromDir: string,
  moduleCache: Map<string, unknown>,
  _writeOut?: (s: string) => void,
  _writeErr?: (s: string) => void,
  _setExit?: (code: number) => void,
  sandboxSetTimeout?: (cb: (...a: unknown[]) => void, ms?: number) => ReturnType<typeof setTimeout>,
  _sandboxClearTimeout?: (t?: unknown) => void,
) {
  const resolveRelative = (spec: string, fromDir: string): string | null => {
    const parts = (spec.startsWith('/') ? spec : `${fromDir}/${spec}`).split('/');
    const stack: string[] = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    const abs = '/' + stack.join('/');
    for (const c of [abs, `${abs}.js`, `${abs}/index.js`, `${abs}.json`]) {
      try {
        if (io.session.exists(c) && io.session.stat(c).kind === 'file') return c;
      } catch { /* continue */ }
    }
    return null;
  };

  const resolveBareFrom = (spec: string, fromDir: string): string | null => {
    let dir = fromDir;
    for (;;) {
      const base = dir === '/' ? '' : dir;
      const candidates = [
        `${base}/node_modules/${spec}`,
        `${base}/node_modules/${spec}.js`,
        `${base}/node_modules/${spec}/index.js`,
      ];
      for (const c of candidates) {
        try {
          if (io.session.exists(c) && io.session.stat(c).kind === 'file') return c;
        } catch { /* keep looking */ }
      }
      try {
        const pkgPath = `${base}/node_modules/${spec}/package.json`;
        if (io.session.exists(pkgPath)) {
          const pkg = JSON.parse(io.session.readFile(pkgPath, 'utf8') as string) as { main?: string };
          if (pkg.main) {
            const mainPath = `${base}/node_modules/${spec}/${pkg.main}`;
            if (io.session.exists(mainPath)) return mainPath;
          }
        }
      } catch { /* ignore malformed package.json */ }
      if (dir === '/') break;
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
    }
    return null;
  };

  const resolveHostModule = (spec: string): unknown => {
    switch (spec) {
      case 'fs':
      case 'node:fs':
        return createNodeFsShim(io);
      case 'os':
      case 'node:os':
        return {
          EOL: '\n',
          platform: () => 'nextool-virtual',
          arch: () => 'x64',
          hostname: () => 'nextool-sandbox',
          tmpdir: () => '/tmp',
          totalmem: () => 268435456,
          freemem: () => 134217728,
          cpus: () => [{ model: 'nextool-virtual', speed: 0 }],
        };
      case 'path':
      case 'node:path':
        return nodePathShim();
      case 'timers':
      case 'node:timers':
        return {
          setTimeout: sandboxSetTimeout ?? ((cb: () => void, ms?: number) => setTimeout(cb, ms)),
          clearTimeout: (t?: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
          setInterval: sandboxSetTimeout ?? ((cb: () => void, ms?: number) => setInterval(cb, ms)),
          clearInterval: (t?: unknown) => clearInterval(t as ReturnType<typeof setInterval>),
          setImmediate: (cb: () => void) => setTimeout(cb, 0),
        };
      case 'events':
      case 'node:events':
        return { EventEmitter };
      default:
        throw new Error(`Module "${spec}" is not available inside virtual node programs (child_process inside a program is disabled).`);
    }
  };

  const loadModule = (path: string): unknown => {
    if (moduleCache.has(path)) return moduleCache.get(path);
    const code = io.session.readFile(path, 'utf8') as string;
    if (path.endsWith('.json')) {
      const parsed = JSON.parse(code) as unknown;
      moduleCache.set(path, parsed);
      return parsed;
    }
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const modObj = { exports: {} as Record<string, unknown> };
    moduleCache.set(path, modObj.exports);
    const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`;
    const compiled = new vm.Script(wrapper, { filename: `vfs:${path}` });
    // the nested module's require() resolves packages from ITS OWN directory
    const nestedRequire = makeNodeRequire(io, dir, moduleCache, _writeOut, _writeErr, _setExit, sandboxSetTimeout, _sandboxClearTimeout);
    const fn = compiled.runInNewContext(buildNodeSandbox(io, path, dir, [], [], () => null, () => {}, sandboxSetTimeout ?? ((cb: () => void, ms?: number) => setTimeout(cb, ms)), nestedRequire)) as (...a: unknown[]) => void;
    fn(modObj.exports, nestedRequire, modObj, path, dir);
    moduleCache.set(path, modObj.exports);
    return modObj.exports;
  };

  return (specifier: string): unknown => {
    const spec = String(specifier ?? '').trim();
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      const found = resolveRelative(spec, fromDir);
      if (found) return loadModule(found);
      throw new Error(`Cannot find module '${spec}' in the virtual filesystem.`);
    }
    try {
      return resolveHostModule(spec);
    } catch (hostErr) {
      const found = resolveBareFrom(spec, fromDir);
      if (found) return loadModule(found);
      throw hostErr;
    }
  };
}

/**
 * Sync-mode node: execute the program synchronously and return the captured
 * output immediately. A program that schedules timers/promises cannot drain
 * inside execSync — report it honestly instead of blocking the runtime.
 */
function runNodeProgramSync(scriptPath: string, source: string, io: CommandIO, argvTail: string[]): RunResult {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;
  let pendingTimers = 0;
  const writeOut = (s: string) => stdoutChunks.push(s);
  const writeErr = (s: string) => stderrChunks.push(s);
  const sandboxSetTimeout = (cb: (...a: unknown[]) => void, ms?: number): ReturnType<typeof setTimeout> => {
    pendingTimers += 1;
    const t = setTimeout(() => {
      pendingTimers -= 1;
      try { cb(); } catch { /* async completion is out of scope for execSync */ }
    }, Math.max(0, Number(ms) || 0));
    if (typeof t.unref === 'function') t.unref();
    return t;
  };
  try {
    const dir = scriptPath.slice(0, scriptPath.lastIndexOf('/')) || '/';
    const modObj = { exports: {} as Record<string, unknown> };
    const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`;
    const compiled = new vm.Script(wrapper, { filename: `vfs:${scriptPath}` });
    // A throwaway io copy whose node handler is unused inside the program; the
    // program's require() resolves through the SAME VFS + policy boundaries.
    const programIo: CommandIO = { ...io, asyncAllowed: true };
    const requireFn = makeNodeRequire(programIo, dir, new Map());
    const fn = compiled.runInNewContext(buildNodeSandbox(programIo, scriptPath, dir, stdoutChunks, stderrChunks, () => exitCode, (c) => { exitCode = c; }, sandboxSetTimeout, requireFn)) as (...a: unknown[]) => void;
    fn(modObj.exports, requireFn, modObj, scriptPath, dir);
  } catch (e) {
    stderrChunks.push(`${(e as Error).name ?? 'Error'}: ${(e as Error).message}\n`);
    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: exitCode ?? 1 };
  }
  if (pendingTimers > 0) {
    stderrChunks.push('node (execSync): the program scheduled async work (timers/promises) — use exec()/spawn() so the virtual runtime can drain it.\n');
  }
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode: exitCode ?? 0 };
}

/** Small path shim for virtual node programs (pure string ops). */
function nodePathShim(): Record<string, unknown> {
  const join = (...parts: string[]): string => {
    const stack: string[] = [];
    for (const part of parts.join('/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return '/' + stack.join('/');
  };
  return {
    join,
    resolve: (...parts: string[]) => join(...parts),
    basename: (p: string) => p.split('/').filter(Boolean).pop() ?? '',
    dirname: (p: string) => (p.split('/').slice(0, -1).join('/') || '/'),
    extname: (p: string) => {
      const b = p.split('/').filter(Boolean).pop() ?? '';
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    },
    isAbsolute: (p: string) => p.startsWith('/'),
    sep: '/',
    posix: {},
  };
}

/** fs shim for virtual node programs — bound to the SAME VFS session. */
function createNodeFsShim(io: CommandIO): Record<string, unknown> {
  const s = io.session;
  const async = <T>(fn: () => T): Promise<T> => new Promise((res, rej) => setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, 0));
  const shim: Record<string, unknown> = {
    readFileSync: (p: string, enc?: string) => s.readFile(p, enc),
    writeFileSync: (p: string, data: string | Uint8Array) => s.writeFile(p, data),
    appendFileSync: (p: string, d: string | Uint8Array) => s.appendFile(p, d),
    existsSync: (p: string) => s.exists(p),
    mkdirSync: (p: string, o?: { recursive?: boolean }) => s.mkdir(p, o),
    readdirSync: (p: string) => s.readdir(p),
    statSync: (p: string) => s.stat(p),
    rmSync: (p: string, o?: { recursive?: boolean; force?: boolean }) => s.rm(p, o),
    unlinkSync: (p: string) => s.unlink(p),
    renameSync: (a: string, b: string) => s.rename(a, b),
    copyFileSync: (a: string, b: string) => s.copy(a, b),
    readFile: (p: string, enc?: string) => async(() => s.readFile(p, enc)),
    writeFile: (p: string, d: string | Uint8Array) => async(() => s.writeFile(p, d)),
    mkdir: (p: string, o?: { recursive?: boolean }) => async(() => s.mkdir(p, o)),
    readdir: (p: string) => async(() => s.readdir(p)),
    stat: (p: string) => async(() => s.stat(p)),
    exists: (p: string) => async(() => s.exists(p)),
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  };
  shim.promises = {
    readFile: shim.readFile,
    writeFile: shim.writeFile,
    mkdir: shim.mkdir,
    readdir: shim.readdir,
    stat: shim.stat,
    rm: (p: string, o?: { recursive?: boolean; force?: boolean }) => async(() => s.rm(p, o)),
    unlink: (p: string) => async(() => s.unlink(p)),
    copyFile: (a: string, b: string) => async(() => s.copy(a, b)),
    rename: (a: string, b: string) => async(() => s.rename(a, b)),
  };
  return shim;
}

// ---------- virtual npm (§3.4–§3.7) ----------

interface PkgJson {
  name?: string;
  version?: string;
  main?: string;
  description?: string;
  scripts?: Record<string, string>;
  keywords?: string[];
  author?: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(io: CommandIO, path: string): PkgJson | null {
  try {
    if (!io.session.exists(path)) return null;
    return JSON.parse(io.session.readFile(path, 'utf8') as string) as PkgJson;
  } catch {
    return null;
  }
}

/** Minimal ustar/tar.gz extraction (registry tarballs: a `package/` root). */
function extractTarGz(buf: Buffer): { path: string; data: Buffer }[] {
  const tar = zlib.gunzipSync(buf);
  const entries: { path: string; data: Buffer }[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(header.toString('utf8', 124, 136).replace(/[\0 ]*$/g, '').trim() || '0', 8) || 0;
    const typeByte = header[156];
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    off += 512;
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/, ''); continue; }
    if (type === 'x' || type === 'g') continue; // pax headers — skipped
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === '0') entries.push({ path, data: Buffer.from(data) });
  }
  return entries;
}

async function npmInstall(io: CommandIO, requested: string[]): Promise<RunResult> {
  const limits = getChildProcessLimits();
  const cwdPkgPath = joinCwd(io, 'package.json');
  let pkg = readPackageJson(io, cwdPkgPath) ?? {};
  const roots = requested.length > 0
    ? requested
    : Object.keys(pkg.dependencies ?? {});
  if (roots.length === 0) {
    return err('npm install: no packages requested and package.json has no dependencies.');
  }
  const accounting = io.accounting ?? createNetworkAccounting();
  const installed: string[] = [];
  const lockPackages: Record<string, { version: string; resolved: string }> = {};
  const queue = roots.map((r) => {
    const at = r.indexOf('@', 1);
    return at > 0 ? { name: r.slice(0, at), range: r.slice(at + 1) } : { name: r, range: 'latest' };
  });
  let fetched = 0;
  while (queue.length > 0) {
    if (Date.now() > io.deadlineAt) return err('npm install: exceeded the command deadline.', 124);
    if (installed.length >= limits.npmMaxPackages) {
      return err(`npm install: reached the configured package cap (childProcess.npmMaxPackages = ${limits.npmMaxPackages}).`, 1);
    }
    const { name, range } = queue.shift() as { name: string; range: string };
    if (installed.includes(name)) continue;
    let metaRes: Response;
    try {
      metaRes = await policyFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { method: 'GET' }, accounting);
    } catch (e) {
      return err(`npm install: registry request for "${name}" failed: ${(e as Error).message}`);
    }
    if (!metaRes.ok) return err(`npm install: registry returned HTTP ${metaRes.status} for "${name}".`);
    let meta: { 'dist-tags'?: { latest?: string }; versions?: Record<string, { dist?: { tarball?: string }; dependencies?: Record<string, string> }> };
    try {
      meta = JSON.parse(await metaRes.text()) as typeof meta;
    } catch {
      return err(`npm install: registry response for "${name}" is not valid JSON.`);
    }
    const version = range !== 'latest' && meta.versions && meta.versions[range] ? range : (meta['dist-tags']?.latest ?? (meta.versions ? Object.keys(meta.versions).slice(-1)[0] : null));
    if (!version || !meta.versions?.[version]) return err(`npm install: no matching version for "${name}@${range}".`);
    const tarballUrl = meta.versions[version].dist?.tarball;
    if (!tarballUrl) return err(`npm install: no tarball for "${name}@${version}".`);
    let tarRes: Response;
    try {
      tarRes = await policyFetch(tarballUrl, { method: 'GET' }, accounting);
    } catch (e) {
      return err(`npm install: tarball download for "${name}" failed: ${(e as Error).message}`);
    }
    if (!tarRes.ok) return err(`npm install: tarball download for "${name}" returned HTTP ${tarRes.status}.`);
    let entries: { path: string; data: Buffer }[];
    try {
      entries = extractTarGz(Buffer.from(await tarRes.arrayBuffer()));
    } catch (e) {
      return err(`npm install: tarball for "${name}" could not be extracted: ${(e as Error).message}`);
    }
    const baseDir = joinCwd(io, `node_modules/${name}`);
    try {
      if (!io.session.exists(baseDir)) io.session.mkdir(baseDir, { recursive: true });
      for (const entry of entries) {
        const stripped = entry.path.replace(/^package\/?/, '');
        if (!stripped) continue;
        io.session.writeFile(`${baseDir}/${stripped}`, entry.data);
      }
    } catch (e) {
      return err(`npm install: writing "${name}" into the Virtual FS failed: ${(e as Error).message}`);
    }
    installed.push(`${name}@${version}`);
    lockPackages[`node_modules/${name}`] = { version, resolved: tarballUrl };
    fetched += 1;
    // transitive dependencies — capped by npmMaxPackages and the deadline
    const deps = meta.versions[version].dependencies ?? {};
    for (const [dep, depRange] of Object.entries(deps)) {
      if (!installed.includes(dep)) queue.push({ name: dep, range: depRange });
    }
  }
  // update package.json dependencies + a simplified package-lock.json
  if (requested.length > 0) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}) };
    for (const item of installed) {
      const at = item.lastIndexOf('@');
      pkg.dependencies[item.slice(0, at)] = `^${item.slice(at + 1)}`;
    }
    try {
      io.session.writeFile(cwdPkgPath, JSON.stringify({ name: pkg.name ?? 'workspace', version: pkg.version ?? '1.0.0', ...pkg }, null, 2));
      io.session.writeFile(joinCwd(io, 'package-lock.json'), JSON.stringify({ name: pkg.name ?? 'workspace', version: pkg.version ?? '1.0.0', lockfileVersion: 3, requires: true, packages: lockPackages }, null, 2));
    } catch (e) {
      return err(`npm install: updating package.json failed: ${(e as Error).message}`);
    }
  }
  const lines = [
    'added ' + installed.length + ' package' + (installed.length === 1 ? '' : 's') + ` (${fetched} registry fetches) into the Virtual FS workspace`,
    'lifecycle scripts are NOT auto-executed inside the NexTool sandbox (§3.7) — run them explicitly with npm run <script>',
    ...installed.map((i) => `+ ${i}`),
  ];
  return out(lines.join('\n') + '\n');
}

async function runNpmCommand(args: string[], io: CommandIO): Promise<RunResult> {
  if (!io.asyncAllowed) {
    return err('npm: the virtual npm requires exec()/spawn() (network access is async) — use exec("npm install <pkg>").');
  }
  const sub = args[0];
  const rest = args.slice(1).filter((a) => a !== '--');
  if (sub === 'init') {
    const pkgPath = joinCwd(io, 'package.json');
    if (readPackageJson(io, pkgPath)) return out('npm init: package.json already exists — left unchanged.\n');
    const dirName = io.shell.cwd.split('/').filter(Boolean).pop() ?? 'workspace';
    const pkg: PkgJson = {
      name: rest.includes('-y') || rest.includes('--yes') ? dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-') : dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: { test: 'node test.js' },
      keywords: [],
      author: '',
      license: 'ISC',
    };
    try {
      io.session.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    } catch (e) {
      return err(`npm init: ${(e as Error).message}`);
    }
    return out(`created package.json in ${io.shell.cwd} (virtual workspace — the host is never touched)\n`);
  }
  if (sub === 'install' || sub === 'i' || sub === 'add') {
    return npmInstall(io, rest);
  }
  if (sub === 'uninstall' || sub === 'remove' || sub === 'rm') {
    const pkgPath = joinCwd(io, 'package.json');
    const pkg = readPackageJson(io, pkgPath);
    const removed: string[] = [];
    for (const name of rest) {
      try {
        io.session.rm(joinCwd(io, `node_modules/${name}`), { recursive: true, force: true });
        if (pkg?.dependencies?.[name]) {
          delete pkg.dependencies[name];
          removed.push(name);
        }
      } catch (e) {
        return err(`npm uninstall: ${(e as Error).message}`);
      }
    }
    if (pkg && removed.length > 0) io.session.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    return out(`removed ${removed.length} package(s) from the Virtual FS workspace\n`);
  }
  if (sub === 'run' || sub === 'run-script' || sub === 'test' || sub === 'start' || sub === 'stop') {
    const scriptName = sub === 'run' || sub === 'run-script' ? rest[0] : sub;
    const pkg = readPackageJson(io, joinCwd(io, 'package.json'));
    const script = pkg?.scripts?.[scriptName];
    if (!script) {
      return err(`npm run: missing script "${scriptName}" — define it in package.json (#3.7: scripts execute through the same sandboxed pipeline).`);
    }
    // npm scripts run through the SAME virtual pipeline — sandboxed, §3.7.
    const result = await runPipelineAsync(script, io.session, {
      env: io.env,
      timeoutMs: Math.max(1, io.deadlineAt - Date.now()),
      maxOutputBytes: io.limits.maxOutputBytes,
      processCount: io.processCount,
      accounting: io.accounting,
      shell: io.shell,
    });
    const banner = `> ${scriptName}\n> ${script}\n\n`;
    return { stdout: banner + result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  if (sub === 'ls' || sub === 'list') {
    const pkg = readPackageJson(io, joinCwd(io, 'package.json'));
    const deps = pkg?.dependencies ?? {};
    const lines = Object.entries(deps).map(([name, range]) => {
      let installedV = '—';
      try {
        const pj = readPackageJson(io, joinCwd(io, `node_modules/${name}/package.json`));
        if (pj?.version) installedV = pj.version;
      } catch { /* not installed */ }
      return `${io.shell.cwd === '/' ? '' : io.shell.cwd}/node_modules/${name}:${installedV}`;
    });
    return out((lines.length > 0 ? lines.join('\n') + '\n' : `${io.shell.cwd}\n(empty — no dependencies in package.json)\n`));
  }
  if (sub === '-v' || sub === '--version') return out('10.9.2 (nextool-virtual npm)\n');
  return err(`npm: unknown subcommand "${sub ?? ''}" — the NexTool virtual npm supports: init, install, uninstall, run, test, start, ls.`);
}

// ---------- pipeline runner ----------

function resolveVfsCwd(io: CommandIO, requestedCwd: string | undefined): void {
  if (requestedCwd && requestedCwd.length > 0) {
    const resolved = io.session.realpath(requestedCwd);
    io.shell.cwd = resolved;
  }
}

function enforceOutputLimits(result: RunResult, maxOutputBytes: number): RunResult {
  const total = Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8');
  if (total > maxOutputBytes) {
    return { stdout: '', stderr: `child_process policy: output exceeded ${maxOutputBytes} bytes and was discarded.`, exitCode: 1 };
  }
  return result;
}

interface PipelinePlan {
  io: CommandIO;
  stages: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

function preparePipeline(
  command: string,
  session: VirtualFsSession,
  base: PipelineBase,
  asyncAllowed: boolean,
): PipelinePlan | RunResult {
  const limits = getChildProcessLimits();
  const started = Date.now();
  // v1.0.7 §1 + v1.0.8 §3.15 — the per-command ceiling is the effective tool
  // execution timeout when provided (maxTimeoutMs), otherwise the central
  // childProcess.timeoutMs default. An explicit timeout is clamped into [1, cap].
  let capMax = 3_600_000;
  try {
    const prop = getLimitProperty('childProcess', 'timeoutMs');
    if (typeof prop.max === 'number') capMax = prop.max;
  } catch { /* shipped ceiling */ }
  const capMs = base.maxTimeoutMs && Number.isFinite(base.maxTimeoutMs) && base.maxTimeoutMs > limits.timeoutMs
    ? Math.min(Math.round(base.maxTimeoutMs), capMax)
    : limits.timeoutMs;
  const timeoutMs = Math.min(Math.max(base.timeoutMs ?? capMs, 1), capMs);
  const deadline = started + timeoutMs;
  const maxOutputBytes = Math.min(base.maxOutputBytes ?? limits.maxOutputBytes, limits.maxOutputBytes);
  const env = { NEXTOOL: '1', NEXTOOL_VFS: '1', HOME: '/workspace', ...(base.env ?? {}) };

  const io: CommandIO = {
    session,
    // §3.8/§3.9 — the shell session is SHARED across every command of this
    // execution: cd mutates it and the next command keeps the directory.
    shell: base.shell.cwd ? base.shell : { cwd: '/workspace', prev: null },
    stdin: '',
    env,
    limits,
    processCount: base.processCount,
    accounting: base.accounting,
    asyncAllowed,
    deadlineAt: deadline,
  };

  try {
    assertNoShellEscape(command);
  } catch (e) {
    return { stdout: '', stderr: (e as Error).message + '\n', exitCode: 126 };
  }
  const stages = splitPipes(command);
  if (stages.length > limits.maxPipeStages) {
    return { stdout: '', stderr: `child_process policy: at most ${limits.maxPipeStages} pipe stages are allowed.\n`, exitCode: 126 };
  }
  io.processCount.n += stages.length;
  if (io.processCount.n > limits.maxProcessesPerExecution) {
    return { stdout: '', stderr: `child_process policy: at most ${limits.maxProcessesPerExecution} processes per execution are allowed.\n`, exitCode: 126 };
  }
  resolveVfsCwd(io, base.cwd);
  return { io, stages, timeoutMs, maxOutputBytes };
}

interface PipelineBase {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  processCount: { n: number };
  accounting?: NetworkAccounting;
  /** §3.9 — shared per-execution shell session (cd persists across commands). */
  shell: { cwd: string; prev: string | null };
}

function tokenizeStage(stage: string): string[] | RunResult {
  try {
    const argv = tokenize(stage);
    if (argv.length === 0) return [];
    // `sh -c "..."` / `bash -c "..."` unwrap to the inner command (same policy)
    if (argv[0] === 'sh' || argv[0] === 'bash') {
      if (argv[1] === '-c' && argv[2]) {
        const inner = tokenize(argv[2]);
        return inner;
      }
      return err(`NexTool child_process policy: bare ${argv[0]} is not available — use sh -c "command".\n`, 127);
    }
    return argv;
  } catch (e) {
    return { stdout: '', stderr: (e as Error).message + '\n', exitCode: 126 };
  }
}

/** Run ONE stage through the centralized command registry (§3.13). Sync
 *  handlers return RunResult directly (execSync path); async handlers return
 *  a Promise (exec/spawn path). */
function execStage(argv: string[], io: CommandIO): RunResult | Promise<RunResult> {
  const handler = COMMANDS[argv[0]];
  if (!handler) {
    return err(
      `NexTool child_process policy: command "${argv[0]}" is not available. Allowed virtual commands: ${VIRTUAL_COMMANDS.join(' ')}. These commands operate on the tool's virtual filesystem — the host system is never touched.`,
      127,
    );
  }
  return handler(argv.slice(1), io);
}

function isPromise(v: RunResult | Promise<RunResult>): v is Promise<RunResult> {
  return typeof (v as Promise<RunResult>)?.then === 'function';
}

/** Synchronous pipeline (execSync) — async-only commands fail honestly. */
function runPipelineSync(command: string, session: VirtualFsSession, base: PipelineBase): RunResult {
  const limits = getChildProcessLimits();
  const plan = preparePipeline(command, session, base, false);
  if (!plan || !('stages' in plan)) return plan as RunResult;
  const { io, stages, timeoutMs, maxOutputBytes } = plan;
  let result: RunResult = { stdout: '', stderr: '', exitCode: 0 };
  for (const stage of stages) {
    if (Date.now() > io.deadlineAt) {
      return { stdout: '', stderr: `child_process policy: execution exceeded ${timeoutMs}ms and was aborted.\n`, exitCode: 124 };
    }
    let argv = tokenizeStage(stage);
    if (Array.isArray(argv)) {
      if (argv.length === 0) continue;
      if (argv.length > limits.maxArgs + 1) {
        return { stdout: '', stderr: `child_process policy: too many arguments (max ${limits.maxArgs}).\n`, exitCode: 126 };
      }
      if (argv[0] === 'xargs') {
        const words = io.stdin.split(/\s+/).filter(Boolean);
        argv = [...argv.slice(1), ...words];
        io.stdin = '';
        if (argv.length === 0) continue;
      }
      const r = execStage(argv, io);
      if (isPromise(r)) {
        return err(`child_process policy: "${argv[0]}" requires exec()/spawn() (async) — execSync cannot await it without blocking the runtime.`, 126);
      }
      result = r;
    } else {
      result = argv as RunResult;
    }
    if (result.exitCode !== 0) break;
    io.stdin = result.stdout;
  }
  if (Date.now() > io.deadlineAt) {
    return { stdout: '', stderr: `child_process policy: execution exceeded ${timeoutMs}ms and was aborted.\n`, exitCode: 124 };
  }
  return enforceOutputLimits(result, maxOutputBytes);
}

/** Asynchronous pipeline (exec/execFile/spawn) — supports async commands. */
async function runPipelineAsync(command: string, session: VirtualFsSession, base: PipelineBase): Promise<RunResult> {
  const limits = getChildProcessLimits();
  const plan = preparePipeline(command, session, base, true);
  if (!plan || !('stages' in plan)) return plan as RunResult;
  const { io, stages, timeoutMs, maxOutputBytes } = plan;
  let result: RunResult = { stdout: '', stderr: '', exitCode: 0 };
  for (const stage of stages) {
    if (Date.now() > io.deadlineAt) {
      return { stdout: '', stderr: `child_process policy: execution exceeded ${timeoutMs}ms and was aborted.\n`, exitCode: 124 };
    }
    let argv = tokenizeStage(stage);
    if (Array.isArray(argv)) {
      if (argv.length === 0) continue;
      if (argv.length > limits.maxArgs + 1) {
        return { stdout: '', stderr: `child_process policy: too many arguments (max ${limits.maxArgs}).\n`, exitCode: 126 };
      }
      if (argv[0] === 'xargs') {
        const words = io.stdin.split(/\s+/).filter(Boolean);
        argv = [...argv.slice(1), ...words];
        io.stdin = '';
        if (argv.length === 0) continue;
      }
      try {
        result = await execStage(argv, io);
      } catch (e) {
        result = err(`${argv[0]}: ${(e as Error).message}`);
      }
    } else {
      result = argv as RunResult;
    }
    if (result.exitCode !== 0) break;
    io.stdin = result.stdout;
  }
  if (Date.now() > io.deadlineAt) {
    return { stdout: '', stderr: `child_process policy: execution exceeded ${timeoutMs}ms and was aborted.\n`, exitCode: 124 };
  }
  return enforceOutputLimits(result, maxOutputBytes);
}

// ---------- public module factory ----------

export interface ChildProcessModuleOptions {
  /** v1.0.7 §1 — effective tool timeout raises the per-command ceiling. */
  maxTimeoutMs?: number;
  /** v1.0.8 §3.4/§4.4 — npm/node network access shares the execution accounting. */
  accounting?: NetworkAccounting;
}

export function createChildProcessModule(
  session: VirtualFsSession,
  processCount: { n: number },
  /** v1.0.7 §1 / v1.0.8 §3.15 — effective tool timeout + shared network accounting. */
  options?: ChildProcessModuleOptions | { maxTimeoutMs?: number },
): Record<string, unknown> {
  const limits = options ?? {};
  // §3.9 — ONE shell session per module instance (per tool execution): the
  // working directory persists across commands, never reset per command.
  const shell = { cwd: '/workspace', prev: null as string | null };
  const base = {
    cwd: undefined as string | undefined,
    env: undefined as Record<string, string> | undefined,
    timeoutMs: undefined as number | undefined,
    maxOutputBytes: undefined as number | undefined,
    maxTimeoutMs: (limits as ChildProcessModuleOptions).maxTimeoutMs,
    processCount,
    accounting: (limits as ChildProcessModuleOptions).accounting,
    shell,
  };

  const runAsync = (command: string, overrides: Partial<typeof base>): Promise<RunResult> =>
    runPipelineAsync(String(command), session, { ...base, ...overrides });
  const runSync = (command: string, overrides: Partial<typeof base>): RunResult =>
    runPipelineSync(String(command), session, { ...base, ...overrides });

  const exec = (
    command: string,
    cmdOptions?: ExecOptions | ((err: unknown, res?: { stdout: string; stderr: string }) => void),
    callback?: (err: unknown, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const opts: ExecOptions = typeof cmdOptions === 'object' && cmdOptions !== null ? cmdOptions : {};
    const cb = typeof cmdOptions === 'function' ? cmdOptions : callback;
    const promise = runAsync(String(command), opts).then(
      (result) => {
        if (result.exitCode === 0) return { stdout: result.stdout, stderr: result.stderr };
        const e = new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`);
        (e as Error & { code?: number; stderr?: string; stdout?: string }).code = result.exitCode;
        (e as Error & { stderr?: string; stdout?: string }).stderr = result.stderr;
        (e as Error & { stdout?: string }).stdout = result.stdout;
        throw e;
      },
    );
    if (cb) {
      void promise.then(
        (res) => { try { cb(null, res); } catch { /* ignore */ } },
        (e) => { try { cb(e); } catch { /* ignore */ } },
      );
      return undefined;
    }
    return promise;
  };

  const execSync = (command: string, options?: ExecOptions): string => {
    // Synchronous API — async-only commands (sleep/npm) report honestly
    // instead of blocking the runtime event loop.
    const result = runSync(String(command), options ?? {});
    if (result.exitCode !== 0) {
      const e = new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`);
      (e as Error & { code?: number }).code = result.exitCode;
      throw e;
    }
    return result.stdout;
  };

  const execFile = (
    file: string,
    argsOrOptions?: string[] | ExecOptions | ((err: unknown, res?: { stdout: string; stderr: string }) => void),
    maybeCallbackOrOptions?: ExecOptions | ((err: unknown, res?: { stdout: string; stderr: string }) => void),
    cb?: (err: unknown, res?: { stdout: string; stderr: string }) => void,
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (typeof argsOrOptions === 'object' && !Array.isArray(argsOrOptions) ? argsOrOptions : typeof maybeCallbackOrOptions === 'object' ? maybeCallbackOrOptions : {}) as ExecOptions;
    const callback = (typeof argsOrOptions === 'function' ? argsOrOptions : typeof maybeCallbackOrOptions === 'function' ? maybeCallbackOrOptions : cb) as ((err: unknown, res?: { stdout: string; stderr: string }) => void) | undefined;
    return exec([String(file), ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), options, callback);
  };

  const spawn = (command: string, args: string[] = [], options: ExecOptions = {}): EventEmitter => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: { write(s: string): void; end(): void };
      exitCode: number | null; killed: boolean; kill(): boolean; then?: PromiseLike<unknown>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    void runAsync([command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), options).then((result) => {
      if (result.stdout) child.stdout.emit('data', result.stdout);
      if (result.stderr) child.stderr.emit('data', result.stderr);
      child.exitCode = result.exitCode;
      child.emit('exit', result.exitCode, null);
      child.emit('close', result.exitCode);
    });
    return child;
  };

  const spawnSync = (command: string, args: string[] = [], options: ExecOptions = {}) => {
    const result = runSync([command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), options);
    return {
      status: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
      signal: null,
      output: [null, result.stdout, result.stderr],
    };
  };

  const cpModule = {
    exec,
    execSync,
    execFile,
    spawn,
    spawnSync,
    // honest constants — the virtual execution layer has no real PIDs/signals
    signals: {},
    constants: { MAX_BUFFER: getChildProcessLimits().maxOutputBytes },
    default: undefined as unknown,
  };
  cpModule.default = cpModule;
  return cpModule;
}

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  encoding?: string;
  /** v1.0.7 §1 — ceiling raised to the tool's effective execution timeout
   *  (global → tool-specific, cap from the central limits). When absent the
   *  central childProcess.timeoutMs default applies. A child operation can
   *  never use a SHORTER hard-coded timeout than the effective tool timeout
   *  allows. */
  maxTimeoutMs?: number;
}
