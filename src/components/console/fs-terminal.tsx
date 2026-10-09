'use client';

/**
 * NexTool v1.0.16 §3 — REAL FS TERMINAL (genuine interactive terminal UI).
 *
 * The browser surface is a real terminal emulator (@xterm/xterm) connected to
 * the real PTY-backed bash session manager:
 *
 *   Browser xterm.js ⇅ raw keystrokes (batched ~25 ms) / streamed output
 *   SSE stream route ⇅ chunk|cwd|status events + replay + heartbeat
 *   Terminal session manager (PTY via util-linux script, pipes fallback)
 *   Real bash process (stdin/stdout/exit status)
 *
 * Design direction: Aceternity UI's Terminal component — dark surface, window
 * title bar with controls, session tabs, monospace grid, distinct status
 * presentation — integrated with the NexTool console (not a static showcase,
 * no typewriter demo output: every byte comes from the real process).
 *
 * Behavior:
 *  - interactive keyboard input; Enter executes; input reaches ALREADY-RUNNING
 *    processes (raw stdin bridge)
 *  - Ctrl+C/interrupt (the PTY line discipline delivers SIGINT; a toolbar
 *    button sends the same), Ctrl+L clears, Ctrl+D exits the shell
 *  - command history (bash readline), Tab completion — the PTY does the work
 *  - terminal resize via the fit addon + ResizeObserver
 *  - scrollback (5000), selection copy, paste
 *  - multiple tabs / independent sessions, switching, close, restart, clear
 *  - visible prompt, real-time output, connection/reconnect status,
 *    deterministic lifecycle display (never stuck on `starting`)
 *
 * Honest platform limitation (also documented in docs/terminal.md): the PTY
 * grid is fixed at 80×24 (util-linux `script` cannot forward TIOCSWINSZ
 * without a native binding); the xterm view fits the container and the PTY
 * wraps at its own grid. Input/output/interrupt/exit status are fully
 * interactive regardless.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/nexool/client';
import { Ban, Copy, Loader2, Plus, RotateCcw, SquareTerminal, Trash2, X } from 'lucide-react';

interface FsServerSession {
  id: string;
  pid: number | null;
  cwd: string;
  status: 'starting' | 'running' | 'stopped' | 'exited' | 'failed';
  startedAt: string;
  exitCode: number | null;
  exitSignal: string | null;
  lastActivityAt: string;
  transport?: 'pty' | 'pipes';
}

type StreamMsg = {
  type: string;
  sessionId?: string;
  chunk?: { seq: number; stream: 'stdout' | 'stderr'; text: string };
  cwd?: string;
  lastExitCode?: number | null;
  first?: boolean;
  status?: FsServerSession['status'];
  exitCode?: number | null;
  exitSignal?: string | null;
  reason?: string;
  pid?: number | null;
};

const XTERM_THEME = {
  background: '#0A0D13',
  foreground: '#D7DEE8',
  cursor: '#7DD3FC',
  cursorAccent: '#0A0D13',
  selectionBackground: '#1E3A5F',
  black: '#0A0D13',
  red: '#F87171',
  green: '#4ADE80',
  yellow: '#FACC15',
  blue: '#60A5FA',
  magenta: '#C084FC',
  cyan: '#22D3EE',
  white: '#D7DEE8',
  brightBlack: '#64748B',
  brightRed: '#FCA5A5',
  brightGreen: '#86EFAC',
  brightYellow: '#FDE047',
  brightBlue: '#93C5FD',
  brightMagenta: '#D8B4FE',
  brightCyan: '#67E8F9',
  brightWhite: '#F1F5F9',
};

const STATUS_COLOR: Record<FsServerSession['status'], string> = {
  starting: 'bg-amber-400',
  running: 'bg-emerald-400',
  exited: 'bg-slate-500',
  stopped: 'bg-slate-500',
  failed: 'bg-rose-500',
};

export function FsTerminal({ initialCwd }: { initialCwd: string }) {
  const [sessions, setSessions] = useState<FsServerSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cwdBy, setCwdBy] = useState<Record<string, string>>({});
  const [lastExitBy, setLastExitBy] = useState<Record<string, number | null>>({});
  const [booting, setBooting] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<'pty' | 'pipes'>('pty');

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const /** per-session dedup: highest chunk seq already written to the view */
    seqByRef = useRef<Record<string, number>>({});
  const /** pending raw keystrokes waiting for the batched flush */
    pendingInputRef = useRef<string>('');
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const termPost = useCallback(async (body: Record<string, unknown>) => {
    return apiFetch<{ session?: FsServerSession; written?: boolean; interrupted?: boolean; cleared?: boolean; closed?: boolean }>(
      '/api/inspector/terminal',
      { method: 'POST', body: JSON.stringify(body) },
    );
  }, []);

  // ---------- xterm lifecycle (created once) ----------
  useEffect(() => {
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowTransparency: false,
      convertEol: false,
      // The PTY echoes input itself — the emulator must NOT double-echo.
      disableStdin: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (hostRef.current) term.open(hostRef.current);
    try { fit.fit(); } catch { /* zero-size during mount — refit below */ }
    term.writeln('\x1b[38;5;75mNexTool real-FS terminal\x1b[0m — every byte below comes from the real shell process.');
    term.writeln('');

    // Raw keystroke bridge → batched ~25 ms → POST write {raw:true}.
    term.onData((data) => {
      pendingInputRef.current += data;
    });
    const flusher = setInterval(() => {
      const payload = pendingInputRef.current;
      const id = activeIdRef.current;
      if (!payload || !id) return;
      pendingInputRef.current = '';
      void termPost({ op: 'write', sessionId: id, input: payload, raw: true }).catch(() => {
        // connection hiccup — the session watchdog/steal handles recovery
      });
    }, 25);

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* hidden container */ }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      clearInterval(flusher);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [termPost]);

  // ---------- boot: list sessions (create the first when none exist) ----------
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const res = await apiFetch<{ sessions: FsServerSession[]; transport?: 'pty' | 'pipes' }>('/api/inspector/terminal');
        if (cancelled) return;
        if (res.transport) setTransport(res.transport);
        let list = res.sessions;
        if (list.length === 0) {
          const created = await termPost({ op: 'create', cwd: initialCwd || '.' });
          list = created.session ? [created.session] : [];
        }
        if (cancelled) return;
        setSessions(list);
        setCwdBy((prev) => {
          const next = { ...prev };
          for (const s of list) if (!next[s.id]) next[s.id] = s.cwd;
          return next;
        });
        setActiveId((cur) => cur ?? list[list.length - 1]?.id ?? null);
      } catch {
        termRef.current?.writeln('\x1b[38;5;249mterminal backend unavailable — reload the page\x1b[0m');
      } finally {
        if (!cancelled) setBooting(false);
      }
    };
    void boot();
    return () => { cancelled = true; };
  }, [initialCwd, termPost]);

  // ---------- SSE stream for the ACTIVE session ----------
  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    // Fresh subscribe (tab switch): replay the full server buffer.
    seqByRef.current[id] = 0;
    const term = termRef.current;
    term?.reset();
    term?.writeln(`\x1b[38;5;249m── session ${id} ──\x1b[0m`);

    const es = new EventSource(`/api/inspector/terminal/stream?sessionId=${encodeURIComponent(id)}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      let msg: StreamMsg;
      try { msg = JSON.parse(ev.data) as StreamMsg; } catch { return; }
      setConnected(true);
      if (msg.type === 'chunk' && msg.chunk) {
        const seen = seqByRef.current[id] ?? 0;
        if (msg.chunk.seq <= seen) return; // reconnect replay dedup
        seqByRef.current[id] = msg.chunk.seq;
        termRef.current?.write(msg.chunk.text);
      } else if (msg.type === 'cwd') {
        if (msg.cwd) setCwdBy((prev) => ({ ...prev, [id]: msg.cwd as string }));
        if (msg.lastExitCode !== null && msg.lastExitCode !== undefined) {
          setLastExitBy((prev) => ({ ...prev, [id]: msg.lastExitCode ?? null }));
        }
      } else if (msg.type === 'hello') {
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pid: msg.pid ?? null, status: msg.status ?? s.status } : s)));
      } else if (msg.type === 'status') {
        setSessions((prev) => prev.map((s) => (s.id === id
          ? { ...s, status: msg.status ?? s.status, exitCode: msg.exitCode ?? s.exitCode, exitSignal: msg.exitSignal ?? s.exitSignal }
          : s)));
        if (msg.status === 'failed' && msg.reason) {
          termRef.current?.writeln(`\x1b[38;5;249m[session failed: ${msg.reason} — use RESTART or open a NEW SESSION]\x1b[0m`);
        }
      }
    };
    return () => es.close();
  }, [activeId]);

  // ---------- session actions ----------
  const createSession = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const res = await termPost({ op: 'create', cwd: initialCwd || '.' });
      if (res.session) {
        const created = res.session;
        setSessions((prev) => [...prev, created]);
        setCwdBy((prev) => ({ ...prev, [created.id]: created.cwd }));
        setActiveId(created.id);
      }
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
      const res = await termPost({ op: 'restart', sessionId: activeId });
      if (res.session) {
        const restarted = res.session;
        setSessions((prev) => prev.map((s) => (s.id === activeId ? restarted : s)));
        setCwdBy((prev) => ({ ...prev, [activeId]: restarted.cwd }));
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
    try { await termPost({ op: 'clear', sessionId: activeId }); } catch { /* local clear is enough */ }
  };

  const interruptActive = async () => {
    if (!activeId) return;
    try { await termPost({ op: 'interrupt', sessionId: activeId }); } catch { /* already gone */ }
  };

  const closeSessionById = async (id: string) => {
    try { await termPost({ op: 'close', sessionId: id }); } catch { /* already gone */ }
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

  return (
    <div className="space-y-3">
      {/* header row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-tech text-[10px] uppercase tracking-wider text-muted-foreground">terminal sessions</span>
        <Badge variant="outline" className="border-amber-400/40 bg-amber-400/10 font-mono text-[10px] text-amber-300">
          REAL FILESYSTEM — real bash processes ({transport})
        </Badge>
        <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={createSession} disabled={actionBusy || sessions.length >= 4}>
          <Plus className="size-3.5" aria-hidden /> New session {sessions.length >= 4 ? '(cap 4)' : ''}
        </Button>
      </div>

      {/* session tabs (horizontal scroll on mobile) */}
      {sessions.length > 0 ? (
        <div className="nextool-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Terminal sessions">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={activeId === s.id}
              onClick={() => setActiveId(s.id)}
              className={cn(
                'flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px]',
                activeId === s.id ? 'border-sky-400/40 bg-sky-400/10 text-foreground' : 'border-white/[0.07] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]',
              )}
            >
              <SquareTerminal className="size-3" aria-hidden />
              <span className="max-w-32 truncate sm:max-w-40">{cwdBy[s.id] ?? s.cwd}</span>
              <span className={cn('inline-block size-1.5 rounded-full', STATUS_COLOR[s.status])} aria-hidden />
              <span className="font-tech text-[9px] uppercase">{s.status}</span>
              <X
                className="size-3 text-muted-foreground hover:text-rose-300"
                aria-label={`Close terminal session ${s.id}`}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void closeSessionById(s.id); } }}
                onClick={(e) => { e.stopPropagation(); void closeSessionById(s.id); }}
              />
            </button>
          ))}
        </div>
      ) : null}

      {/* terminal window — Aceternity-style chrome + real xterm.js emulator */}
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0A0D13] shadow-[0_8px_30px_rgb(0,0,0,0.35)]">
        {/* title bar */}
        <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-[#FF5F57]" />
            <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
            <span className="size-2.5 rounded-full bg-[#28C840]" />
          </span>
          <span className="ml-1 truncate font-mono text-[11px] text-slate-400">
            operator@nexool: {cwdBy[activeId ?? ''] ?? active?.cwd ?? initialCwd ?? '/'}
          </span>
          <span className="ml-auto flex items-center gap-2 font-tech text-[9px] uppercase tracking-wider">
            <span className={cn('inline-block size-1.5 animate-pulse rounded-full', connected ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden />
            <span className={connected ? 'text-emerald-300' : 'text-amber-300'}>{connected ? 'live' : 'connecting'}</span>
          </span>
        </div>

        {/* emulator surface */}
        <div className="relative">
          {booting ? (
            <p className="flex items-center gap-2 p-4 text-xs text-slate-400">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> starting real FS terminal…
            </p>
          ) : null}
          <div
            ref={hostRef}
            className={cn('nextool-scroll h-[46vh] min-h-[260px] w-full overflow-hidden md:h-[420px]', booting && 'hidden')}
            role="terminal"
            aria-label="Interactive real filesystem terminal"
          />
        </div>

        {/* toolbar / status bar */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
          <Button type="button" variant="ghost" size="sm" className="min-h-8 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={interruptActive} aria-label="Interrupt running process (Ctrl+C)">
            <Ban className="size-3" aria-hidden /> Ctrl+C
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-8 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={restartActive} disabled={actionBusy || !active} aria-label="Restart session">
            <RotateCcw className="size-3" aria-hidden /> Restart
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-8 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={clearActive} aria-label="Clear terminal">
            <Trash2 className="size-3" aria-hidden /> Clear
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-8 gap-1 px-2 text-[11px] text-slate-300 hover:bg-white/[0.06]" onClick={copySelection} aria-label="Copy selection">
            <Copy className="size-3" aria-hidden /> Copy
          </Button>
          {active ? (
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              pid {active.pid ?? '—'} · <span className={active.status === 'running' ? 'text-emerald-400' : active.status === 'failed' ? 'text-rose-400' : 'text-amber-400'}>{active.status}</span>
              {lastExitBy[active.id] !== undefined && lastExitBy[active.id] !== null ? ` · last exit ${lastExitBy[active.id]}` : ''}
              {active.transport ? ` · ${active.transport}` : ''}
            </span>
          ) : null}
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">
        The FS terminal runs REAL processes on the self-hosted machine — commands affect the actual host (REAL FILESYSTEM). Type directly into the terminal: stdin reaches running programs, Ctrl+C sends a real SIGINT, arrow keys recall history, Tab completes paths. Sessions stream output live and track their working directory. The MCP environment has no route here (VFS-only). PTY grid is fixed at 80×24 (host limitation, honestly documented).
      </p>
    </div>
  );
}
