'use client';

/**
 * NexTool v1.1.0 §6 — REAL FS TERMINAL (frontend adapter).
 *
 * The interaction UI is the shared ShellTerminal (xterm.js, bold block
 * cursor, line editing, history); this adapter binds it to the REAL
 * filesystem backend: spawn-per-command node:child_process execution on the
 * self-hosted machine (see src/lib/nexool/inspector/terminal-sessions.ts).
 * Every byte shown comes from a real process — stdout and stderr stream
 * separately, the real exit code is reported, and a command that cannot
 * start returns bash's actual error.
 *
 * Dynamically imported (ssr:false) from the FS Inspector — the fit addon's
 * UMD bundle must never evaluate during SSR.
 */

import { useMemo } from 'react';
import { apiFetch } from '@/lib/nexool/client';
import { ShellTerminal, type ShellBackend } from './shell-terminal';

export function FsTerminal({ initialCwd, maxSessions = 4 }: { initialCwd: string; maxSessions?: number }) {
  const backend = useMemo<ShellBackend>(() => ({
    label: 'REAL FILESYSTEM — real bash processes (child-process)',
    theme: 'fs',
    interruptible: true,
    maxSessions,
    sseUrl: (sessionId) => `/api/inspector/terminal/stream?sessionId=${encodeURIComponent(sessionId)}`,
    op: async (body) => apiFetch<ShellOpResult>('/api/inspector/terminal', { method: 'POST', body: JSON.stringify(body) }),
    list: async () => {
      const res = await apiFetch<{ sessions: { id: string; cwd: string; status: string }[] }>('/api/inspector/terminal');
      return res.sessions ?? [];
    },
    create: async (cwd) => {
      const res = await apiFetch<{ session: { id: string; cwd: string; status?: string } }>('/api/inspector/terminal', {
        method: 'POST',
        body: JSON.stringify({ op: 'create', cwd: cwd || '.' }),
      });
      return { id: res.session.id, cwd: res.session.cwd };
    },
    prompt: (cwd) => `operator@nexool:${cwd || '/'}$ `,
    featuresNote:
      'The FS terminal runs REAL processes on the self-hosted machine — commands affect the actual host (REAL FILESYSTEM). Enter submits the command; a real child process starts, streams stdout/stderr live and reports its true exit code. Ctrl+C interrupts the running command tree (SIGTERM → SIGKILL). Arrow keys recall history, Ctrl+L clears the screen. Sessions track their working directory across commands. The MCP environment has no route here (VFS-only).',
  }), [initialCwd, maxSessions]);

  return <ShellTerminal backend={backend} initialCwd={initialCwd} sessionKindLabel="real-FS" />;
}
