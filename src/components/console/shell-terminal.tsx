'use client';

/**
 * NexTool v1.1.0 §6.4/§6.6 — SHARED SHELL TERMINAL (xterm.js).
 *
 * ONE genuine interactive terminal interaction UI drives BOTH terminals:
 *
 *   REAL FS  → /api/inspector/terminal        (dark neutral theme, real
 *              node:child_process spawn-per-command on the host)
 *   VFS      → /api/inspector/vfs/shell       (distinct amber accent theme,
 *              server-side VFS shell confined to the VFS root)
 *
 * Line-mode shell semantics (no PTY echo anymore — the FRONTEND owns the
 * line editing):
 *   - printable characters are echoed locally and buffered
 *   - Enter submits the command (spawn per command on the backend)
 *   - Backspace edits; Ctrl+C interrupts the running command / clears the
 *     input line; Ctrl+L clears the screen
 *   - ArrowUp/ArrowDown navigate the command history
 *   - the prompt is rendered from REAL session state (cwd, exit status)
 *   - a BOLD BLOCK cursor (explicitly configured: cursorStyle 'block' +
 *     cursorBlink + bright cursorAccent) is always visible
 *   - output streams live over SSE; replayed chunks are deduped by seq and
 *     rendered with their prompt prefix so the transcript survives reconnects
 *   - busy state shows a running pill; the toolbar keeps interrupt/clear/copy
 *
 * Mobile: the emulator fits its container (46vh min 260px / 420px desktop),
 * the toolbar wraps, output scrolls internally and never grows the page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Ban, Copy, Loader2, Plus, RotateCcw, SquareTerminal, Trash2, X } from 'lucide-react';

// ---------- themes (explicit cursor configuration — never a default theme) ----------

export type ShellTheme = 'fs' | 'vfs';

const THEME_BASE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  // §6.4 — a bold, visible, blinking BLOCK cursor, set explicitly.
  cursorBlink: true,
  cursorStyle: 'block' as const,
  cursorWidth: 2,
  scrollback: 5000,
  allowTransparency: false,
  convertEol: false,
  disableStdin: false,
};

const FS_THEME = {
  ...THEME_BASE,
  theme: {
    background: '#0A0D13',
    foreground: '#D7DEE8',
    cursor: '#7DD3FC',
    cursorAccent: '#0A0D13',
    selectionBackground: '#1E3A5F',
    black: '#0A0D13', red: '#F87171', green: '#4ADE80', yellow: '#FACC15',
    blue: '#60A5FA', magenta: '#C084FC', cyan: '#22D3EE', white: '#D7DEE8',
    brightBlack: '#64748B', brightRed: '#FCA5A5', brightGreen: '#86EFAC',
    brightYellow: '#FDE047', brightBlue: '#93C5FD', brightMagenta: '#D8B4FE',
    brightCyan: '#67E8F9', brightWhite: '#F1F5F9',
  },
};

const VFS_THEME = {
  ...THEME_BASE,
  theme: {
    background: '#100D07',
    foreground: '#E8DFC8',
    cursor: '#FBBF24',
    cursorAccent: '#100D07',
    selectionBackground: '#4A3410',
    black: '#100D07', red: '#F87171', green: '#A3E635', yellow: '#FBBF24',
    blue: '#C4B5FD', magenta: '#F0ABFC', cyan: '#5EEAD4', white: '#E8DFC8',
    brightBlack: '#A8A29E', brightRed: '#FCA5A5', brightGreen: '#BEF264',
    brightYellow: '#FDE68A', brightBlue: '#DDD6FE', brightMagenta: '#F5D0FE',
    brightCyan: '#99F6E4', brightWhite: '#FEFCE8',
  },
};

const THEME_SURFACE: Record<ShellTheme, { window: string; badge: string; accentTab: string; dot: string }> = {
  fs: {
    window: 'border-white/[0.08] bg-[#0A0D13]',
    badge: 'border-sky-400/40 bg-sky-400/10 text-sky-300',
    accentTab: 'border-sky-400/40 bg-sky-400/10 text-foreground',
    dot: 'text-sky-300',
  },
  vfs: {
    window: 'border-amber-400/20 bg-[#100D07]',
    badge: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
    accentTab: 'border-amber-400/40 bg-amber-400/10 text-foreground',
    dot: 'text-amber-300',
  },
};

export interface ShellBackend {
  /** Backend label shown in the UI. */
  label: string;
  theme: ShellTheme;
  /** SSE stream URL for a session (chunk replay + live events). */
  sseUrl: (sessionId: string) => string;
  /** All session ops (exec/interrupt/restart/clear/close). */
  op: (body: Record<string, unknown>) => Promise<ShellOpResult>;
  /** List existing sessions. */
  list: () => Promise<{ id: string; cwd: string; status?: string }[]>;
  /** Create a session and return its id. */
  create: (cwd?: string) => Promise<{ id: string; cwd: string }>;
  /** Prompt string rendered for a cwd (theme-specific). */
  prompt: (cwd: string) => string;
  /** Whether an interrupt (Ctrl+C) control should be offered. */
  interruptible: boolean;
  maxSessions: number;
  featuresNote: string;
}

export interface ShellOpResult {
  session?: { id: string; cwd: string; status?: string };
  commandId?: string;
  ok?: boolean;
  interrupted?: boolean;
  cleared?: boolean;
  closed?: boolean;
  error?: { code: string; message: string };
}

interface ShellStreamMsg {
  type: string;
  sessionId?: string;
  chunk?: { seq: number; kind: 'in' | 'out' | 'err' | 'meta'; text: string };
  cwd?: string;
  status?: 'idle' | 'running' | 'failed';
  failReason?: string;
  running?: { command: string; startedAt: string } | null;
  code?: number | null;
  signal?: string | null;
  durationMs?: number;
  timedOut?: boolean;
  reason?: string;
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-emerald-400',
  running: 'bg-amber-400 animate-pulse',
  failed: 'bg-rose-500',
};

export function ShellTerminal({
  backend,
  initialCwd,
  sessionKindLabel,
}: {
  backend: ShellBackend;
  initialCwd: string;
  sessionKindLabel: string;
}) {
  const [sessions, setSessions] = useState<{ id: string; cwd: string; status: string }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwdBy, setCwdBy] = useState<Record<string, string>>({});
  const [busyBy, setBusyBy] = useState<Record<string, boolean>>({});
  const [failBy, setFailBy] = useState<Record<string, string | undefined>>({});
  const [booting, setBooting] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seqByRef = useRef<Record<string, number>>({});
  const /** input line buffer (line-mode editing) */
    lineBufRef = useRef<string>('');
  const /** command history per session (frontend mirror, newest first) */
    historyByRef = useRef<Record<string, string[]>>({});
  const historyIdxRef = useRef<Record<string, number>>({});
  const /** live vs replay — replayed `in` chunks render with a prompt prefix */
    helloRef = useRef<Record<string, boolean>>({});
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const cwdByRef = useRef<Record<string, string>>({});
  cwdByRef.current = cwdBy;
  const busyByRef = useRef<Record<string, boolean>>({});
  busyByRef.current = busyBy;

  const theme = THEME_SURFACE[backend.theme];
  const xtermTheme = backend.theme === 'vfs' ? VFS_THEME : FS_THEME;

  const writePrompt = useCallback((cwd?: string) => {
    const term = termRef.current;
    const id = activeIdRef.current;
    if (!term || !id) return;
    const dir = cwd ?? cwdByRef.current[id] ?? initialCwd ?? '/';
    term.write(`\x1b[2m${backend.prompt(dir)}\x1b[0m`);
  }, [backend, initialCwd]);

  const redrawLine = useCallback(() => {
    const term = termRef.current;
    const id = activeIdRef.current;
    if (!term || !id) return;
    const dir = cwdByRef.current[id] ?? initialCwd ?? '/';
    term.write(`\r\x1b[K\x1b[2m${backend.prompt(dir)}\x1b[0m${lineBufRef.current}`);
  }, [backend, initialCwd]);

  // ---------- xterm lifecycle ----------
  useEffect(() => {
    const term = new Terminal(xtermTheme);
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (hostRef.current) term.open(hostRef.current);
    try { fit.fit(); } catch { /* zero-size during mount */ }

    term.onData((data) => {
      const id = activeIdRef.current;
      if (!id) return;
      const busy = busyByRef.current[id] ?? false;

      // Enter → submit
      if (data === '\r' || data === '\n') {
        if (busy) {
          term.write('\r\n\x1b[2m[busy — a command is already running; Ctrl+C or the ■ button interrupts it]\x1b[0m\r\n');
          writePrompt();
          return;
        }
        const command = lineBufRef.current;
        lineBufRef.current = '';
        term.write('\r\n');
        if (!command.trim()) {
          writePrompt();
          return;
        }
        // local echo of prompt + command (server `in` chunks are skipped live)
        const hist = historyByRef.current[id] ?? [];
        hist.unshift(command);
        if (hist.length > 200) hist.length = 200;
        historyByRef.current[id] = hist;
        historyIdxRef.current[id] = -1;
        setBusyBy((prev) => ({ ...prev, [id]: true }));
        void backend.op({ op: 'exec', sessionId: id, command })
          .then(async (res) => {
            if (res.ok === false || res.error) {
              setBusyBy((prev) => ({ ...prev, [id]: false }));
              termRef.current?.write(`\x1b[38;5;203m${res.error?.message ?? 'command rejected'}\x1b[0m\r\n`);
              writePrompt();
            }
          })
          .catch((err) => {
            setBusyBy((prev) => ({ ...prev, [id]: false }));
            termRef.current?.write(`\x1b[38;5;203m${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
            writePrompt();
          });
        return;
      }

      // Ctrl+C
      if (data === '\x03') {
        if (busy && backend.interruptible) {
          void backend.op({ op: 'interrupt', sessionId: id }).catch(() => { /* gone */ });
          // the backend prints its own ^C meta line + exit status
        } else {
          lineBufRef.current = '';
          historyIdxRef.current[id] = -1;
          term.write('^C\r\n');
          writePrompt();
        }
        return;
      }

      // Ctrl+L → clear screen
      if (data === '\x0c') {
        term.clear();
        writePrompt();
        term.write(lineBufRef.current);
        return;
      }

      // Backspace
      if (data === '\x7f' || data === '\b') {
        if (lineBufRef.current.length > 0) {
          lineBufRef.current = lineBufRef.current.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }

      // history navigation
      if (data === '\x1b[A' || data === '\x1b[B') {
        const hist = historyByRef.current[id] ?? [];
        if (hist.length === 0) return;
        const idx = historyIdxRef.current[id] ?? -1;
        const next = data === '\x1b[A' ? Math.min(idx + 1, hist.length - 1) : Math.max(idx - 1, -1);
        historyIdxRef.current[id] = next;
        lineBufRef.current = next >= 0 ? hist[next] : '';
        redrawLine();
        return;
      }

      // Tab — no completion backend; keep the literal behavior minimal
      if (data === '\t') return;

      // printable / pasted text
      if (data >= ' ' || data === '\u00a0') {
        lineBufRef.current += data;
        term.write(data);
      }
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* hidden container */ }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // ---------- boot: list sessions (create the first when none exist) ----------
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        let list = await backend.list();
        if (list.length === 0) {
          const created = await backend.create(initialCwd || undefined);
          list = [created];
        }
        if (cancelled) return;
        setSessions(list.map((s) => ({ id: s.id, cwd: s.cwd, status: s.status ?? 'idle' })));
        setCwdBy((prev) => {
          const next = { ...prev };
          for (const s of list) if (!next[s.id]) next[s.id] = s.cwd;
          return next;
        });
        setActiveId((cur) => cur ?? list[list.length - 1]?.id ?? null);
      } catch {
        termRef.current?.writeln(`\x1b[38;5;249m${backend.label} backend unavailable — reload the page\x1b[0m`);
      } finally {
        if (!cancelled) setBooting(false);
      }
    };
    void boot();
    return () => { cancelled = true; };
  }, [initialCwd]);

  // ---------- SSE stream for the ACTIVE session ----------
  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    seqByRef.current[id] = 0;
    helloRef.current[id] = false;
    const term = termRef.current;
    term?.reset();
    term?.writeln(`\x1b[38;5;249m── ${sessionKindLabel} session ${id} ──\x1b[0m`);

    const es = new EventSource(backend.sseUrl(id));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      let msg: ShellStreamMsg;
      try { msg = JSON.parse(ev.data) as ShellStreamMsg; } catch { return; }
      setConnected(true);
      if (msg.type === 'hello') {
        helloRef.current[id] = true;
        // after replay, draw the prompt unless a command is running
        if (!(busyByRef.current[id] ?? false)) writePrompt(msg.cwd);
        return;
      }
      if (msg.type === 'chunk' && msg.chunk) {
        const seen = seqByRef.current[id] ?? 0;
        if (msg.chunk.seq <= seen) return; // replay dedup
        seqByRef.current[id] = msg.chunk.seq;
        const isReplay = !helloRef.current[id];
        if (msg.chunk.kind === 'in') {
          if (isReplay) {
            // transcript fidelity after reconnect: prompt + echoed command
            const dir = cwdByRef.current[id] ?? initialCwd ?? '/';
            termRef.current?.write(`\x1b[2m${backend.prompt(dir)}\x1b[0m${msg.chunk.text}`);
          }
          // live `in` chunks are skipped — the frontend already echoed the line
          return;
        }
        termRef.current?.write(msg.chunk.text);
        return;
      }
      if (msg.type === 'cwd') {
        if (msg.cwd) setCwdBy((prev) => ({ ...prev, [id]: msg.cwd }));
        return;
      }
      if (msg.type === 'status') {
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, status: msg.status ?? s.status } : s)));
        setBusyBy((prev) => ({ ...prev, [id]: msg.status === 'running' }));
        if (msg.failReason) setFailBy((prev) => ({ ...prev, [id]: msg.failReason }));
        return;
      }
      if (msg.type === 'exit') {
        setBusyBy((prev) => ({ ...prev, [id]: false }));
        writePrompt();
        return;
      }
    };
    return () => es.close();
  }, [activeId]);

  // ---------- session actions ----------
  const createSession = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const created = await backend.create(initialCwd || undefined);
      setSessions((prev) => [...prev, { id: created.id, cwd: created.cwd, status: 'idle' }]);
      setCwdBy((prev) => ({ ...prev, [created.id]: created.cwd }));
      setActiveId(created.id);
    } catch (e) {
      toast.error('Cannot open session', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionBusy(false);
    }
  };

  const restartActive = async () => {
    if (!activeId || actionBusy) return;
    setActionBusy(true);
    try {
      const res = await backend.op({ op: 'restart', sessionId: activeId });
      if (res.session) {
        setCwdBy((prev) => ({ ...prev, [activeId]: res.session!.cwd }));
        setFailBy((prev) => ({ ...prev, [activeId]: undefined }));
      }
    } catch (e) {
      toast.error('Restart failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setActionBusy(false);
    }
  };

  const clearActive = async () => {
    if (!activeId) return;
    termRef.current?.clear();
    try { await backend.op({ op: 'clear', sessionId: activeId }); } catch { /* local clear is enough */ }
    writePrompt();
  };

  const interruptActive = async () => {
    if (!activeId) return;
    try { await backend.op({ op: 'interrupt', sessionId: activeId }); } catch { /* already gone */ }
  };

  const closeSessionById = async (id: string) => {
    try { await backend.op({ op: 'close', sessionId: id }); } catch { /* already gone */ }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  const copySelection = () => {
    const term = termRef.current;
    if (!term) return;
    const text = term.getSelection() || term.buffer.active.getLine(term.buffer.active.cursorY)?.translateToString(true) || '';
    if (!text.trim()) {
      toast.info('Nothing to copy — select output in the terminal first');
      return;
    }
    void navigator.clipboard.writeText(text)
      .then(() => toast.success('Copied'))
      .catch(() => toast.error('Clipboard unavailable'));
  };

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const busy = activeId ? busyBy[activeId] ?? false : false;
  const capReached = sessions.length >= backend.maxSessions;

  return (
    <div className="space-y-3">
      {/* header row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-tech text-[10px] uppercase tracking-wider text-muted-foreground">terminal sessions</span>
        <Badge variant="outline" className={cn('font-mono text-[10px]', theme.badge)}>
          {backend.label}
        </Badge>
        <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={createSession} disabled={actionBusy || capReached}>
          <Plus className="size-3.5" aria-hidden /> New session {capReached ? `(cap ${backend.maxSessions})` : ''}
        </Button>
      </div>

      {/* session tabs (horizontal scroll on mobile) */}
      {sessions.length > 0 ? (
        <div className="nextool-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label={`${backend.label} sessions`}>
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={activeId === s.id}
              onClick={() => setActiveId(s.id)}
              className={cn(
                'flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px]',
                activeId === s.id ? theme.accentTab : 'border-white/[0.07] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]',
              )}
            >
              <SquareTerminal className="size-3" aria-hidden />
              <span className="max-w-32 truncate sm:max-w-40">{cwdBy[s.id] ?? s.cwd}</span>
              <span className={cn('inline-block size-1.5 rounded-full', STATUS_COLOR[s.status] ?? 'bg-slate-500')} aria-hidden />
              <span className="font-tech text-[9px] uppercase">{s.status}</span>
              <X
                className="size-3 text-muted-foreground hover:text-rose-300"
                aria-label={`Close ${backend.label} session ${s.id}`}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void closeSessionById(s.id); } }}
                onClick={(e) => { e.stopPropagation(); void closeSessionById(s.id); }}
              />
            </button>
          ))}
        </div>
      ) : null}

      {/* terminal window */}
      <div className={cn('overflow-hidden rounded-xl border shadow-[0_8px_30px_rgb(0,0,0,0.35)]', theme.window)}>
        {/* title bar */}
        <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-[#FF5F57]" />
            <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
            <span className="size-2.5 rounded-full bg-[#28C840]" />
          </span>
          <span className={cn('ml-1 truncate font-mono text-[11px]', backend.theme === 'vfs' ? 'text-amber-200/70' : 'text-slate-400')}>
            {backend.theme === 'vfs' ? 'vfs' : 'operator@nexool'}: {cwdBy[activeId ?? ''] ?? active?.cwd ?? initialCwd ?? '/'}
          </span>
          <span className="ml-auto flex items-center gap-2 font-tech text-[9px] uppercase tracking-wider">
            {busy ? (
              <span className="flex items-center gap-1 text-amber-300">
                <Loader2 className="size-3 animate-spin" aria-hidden /> running
              </span>
            ) : (
              <span className="text-emerald-300">ready</span>
            )}
            <span className={cn('inline-block size-1.5 animate-pulse rounded-full', connected ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden />
            <span className={connected ? 'text-emerald-300' : 'text-amber-300'}>{connected ? 'live' : 'connecting'}</span>
          </span>
        </div>

        {/* emulator surface */}
        <div className="relative">
          {booting ? (
            <p className="flex items-center gap-2 p-4 text-xs text-slate-400">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> starting {backend.label.toLowerCase()}…
            </p>
          ) : null}
          <div
            ref={hostRef}
            className={cn('nextool-scroll h-[46vh] min-h-[260px] w-full overflow-hidden md:h-[420px]', booting && 'hidden')}
            role="terminal"
            aria-label={`${backend.label} interactive terminal`}
          />
        </div>

        {/* toolbar / status bar */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
          {backend.interruptible ? (
            <Button type="button" variant="ghost" size="sm" className="min-h-9 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={interruptActive} aria-label="Interrupt running command (Ctrl+C)">
              <Ban className="size-3" aria-hidden /> Ctrl+C
            </Button>
          ) : null}
          {backend.interruptible ? (
            <Button type="button" variant="ghost" size="sm" className="min-h-9 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={restartActive} disabled={actionBusy || !active} aria-label="Restart session">
              <RotateCcw className="size-3" aria-hidden /> Restart
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" className="min-h-9 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={clearActive} aria-label="Clear terminal">
            <Trash2 className="size-3" aria-hidden /> Clear
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-9 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={copySelection} aria-label="Copy selection">
            <Copy className="size-3" aria-hidden /> Copy
          </Button>
          {active ? (
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              <span className={cn('font-tech uppercase', backend.theme === 'vfs' ? 'text-amber-300' : theme.dot)}>{active.status}</span>
              {failBy[active.id] ? <span className="text-rose-400"> · {failBy[active.id]}</span> : ''}
            </span>
          ) : null}
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">{backend.featuresNote}</p>
    </div>
  );
}
