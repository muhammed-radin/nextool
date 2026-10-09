'use client';

/**
 * NexTool v1.1.0 §6.6/§6.7 — VFS TERMINAL (frontend adapter).
 *
 * The SAME shared ShellTerminal interaction UI as the real-FS terminal
 * (prompt, bold block cursor, line editing, history, scrollback, mobile
 * behavior) with a clearly DIFFERENT accent theme (amber sandbox palette)
 * so operators never confuse the two environments.
 *
 * Commands execute SERVER-SIDE through /api/inspector/vfs/shell — the
 * restricted VFS command implementation (never a host shell). The permitted
 * command list comes from the central vfsTerminal.allowedCommands
 * configuration and is enforced in the backend on every execution; the VFS
 * root boundary stays code-enforced (path normalization + symlink refusal).
 */

import { useMemo } from 'react';
import { apiFetch } from '@/lib/nexool/client';
import { ShellTerminal, type ShellBackend, type ShellOpResult } from './shell-terminal';

export function VfsTerminal({ maxSessions = 4 }: { maxSessions?: number }) {
  const backend = useMemo<ShellBackend>(() => ({
    label: 'VFS SANDBOX — virtual shell (cannot escape)',
    theme: 'vfs',
    interruptible: false,
    maxSessions,
    sseUrl: (sessionId) => `/api/inspector/vfs/shell/stream?sessionId=${encodeURIComponent(sessionId)}`,
    op: async (body) => apiFetch<ShellOpResult>('/api/inspector/vfs/shell', { method: 'POST', body: JSON.stringify(body) }),
    list: async () => {
      const res = await apiFetch<{ sessions: { id: string; cwd: string }[] }>('/api/inspector/vfs/shell');
      return (res.sessions ?? []).map((s) => ({ ...s, status: 'idle' as const }));
    },
    create: async () => {
      const res = await apiFetch<{ session: { id: string; cwd: string } }>('/api/inspector/vfs/shell', {
        method: 'POST',
        body: JSON.stringify({ op: 'create' }),
      });
      return { id: res.session.id, cwd: res.session.cwd };
    },
    prompt: (cwd) => `vfs:${cwd || '/'} $ `,
    featuresNote:
      'The VFS terminal runs inside the directory-backed VFS sandbox ONLY — it can never reach the real host filesystem (path normalization, symlink refusal and root confinement are code-enforced). One command per line; the permitted command list is configured on the Limitations page (vfsTerminal.allowedCommands — null = every implemented command). pwd · ls · cd · cat · mkdir · touch · rm [-r] · cp · mv · find · echo [> file] · clear · help.',
  }), [maxSessions]);

  return <ShellTerminal backend={backend} initialCwd="/" sessionKindLabel="VFS" />;
}
