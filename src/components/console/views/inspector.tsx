'use client';

/**
 * FS Inspector (v1.0.13 §2 "THE OPERATOR CONSOLE") — the single-user
 * operator's FULL FILE MANAGER for BOTH filesystems the runtime works with:
 *
 *   · Virtual FS  — the GLOBAL shared tool filesystem (lib/nexool/tools/vfs)
 *     via /api/inspector/vfs. Includes a live usage snapshot.
 *   · Real FS     — the host filesystem confined to the runtime working
 *     directory (process.cwd()) via /api/inspector/fs.
 *
 * Three internal tabs (§2.4/§2.5):
 *   Files    — browse, multi-select (checkbox/shift/ctrl), full file/folder
 *              actions (open/preview/edit/rename/delete/copy/move/cut/paste/
 *              duplicate/create/download/upload/info/copy path/refresh),
 *              Compress → ZIP (hierarchy preserved), search with configurable
 *              depth (0 = current dir only).
 *   Editors  — multi-file editor tabs with dirty state, save/close/close-all,
 *              Monaco ON (default, persisted) / textarea fallback — BOTH work.
 *   Terminal — FS: multiple real bash sessions (capped, confined to the
 *              runtime cwd, stdout/stderr/exit code, running state, clear).
 *              VFS: a sandboxed virtual shell mapped onto the VFS API so the
 *              MCP/restricted boundary can NEVER be escaped.
 *
 * The environment selector is shared across all three tabs. Nothing polls:
 * listings load on demand (navigation / manual refresh). All mutations hit
 * the environment-scoped APIs; errors surface honestly with their codes.
 * Responsive: works from 320px (stacked toolbars, hidden columns) to desktop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiClientError, apiFetch } from '@/lib/nexool/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { APP_VERSION } from '@/lib/nexool/version';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Editor as MonacoEditor, type OnMount } from '@monaco-editor/react';
import { cn } from '@/lib/utils';
import { isImageLike, isTextLike, monacoLanguage } from '@/lib/nexool/inspector/mime';
import { SectionTitle } from '../ui-bits';
import {
  Copy, CornerLeftUp, Download, File as FileIcon, FilePlus2, Folder, FolderPlus, FolderTree, FolderOpen,
  HardDrive, Info, Link2, Loader2, Pencil, Plus, RefreshCw, Save, Scissors, Search, ShieldCheck,
  TerminalSquare, Trash2, Upload, X, ClipboardPaste, FileArchive, XCircle,
} from 'lucide-react';

// ---------- shared types ----------

type FsMode = 'vfs' | 'fs';
type EntryKind = 'file' | 'dir' | 'link';

interface FsEntry {
  name: string;
  kind: EntryKind;
  size?: number;
  updatedAt?: string;
}

interface VfsUsage {
  usedBytes: number;
  files: number;
  limits: { maxTotalBytes: number; [key: string]: unknown };
}

interface ListResponse {
  path: string;
  entries: FsEntry[];
  usage?: VfsUsage;
}

interface ReadResponse {
  path: string;
  name?: string;
  mime?: string;
  textual: boolean;
  encoding: 'text' | 'base64';
  content: string;
  truncated: boolean;
  size: number;
}

interface InfoEntry {
  name: string;
  kind: string;
  size?: number;
  createdAt?: string;
  updatedAt?: string;
  environment?: string;
  permissions?: string;
  mime?: string;
  checksum?: string;
  linkTarget?: string;
}

interface SearchMatch {
  name: string;
  folder: string;
  path: string;
  kind: string;
  size?: number;
}

interface TerminalLine {
  kind: 'cmd' | 'out' | 'err' | 'meta' | 'code';
  text: string;
}

interface EditorTab {
  id: string;
  env: FsMode;
  path: string | null; // null = new unsaved file
  name: string;
  saved: string;
  draft: string;
  loading: boolean;
  saving: boolean;
}

interface TerminalSession {
  id: string;
  cwd: string;
  lines: TerminalLine[];
  running: boolean;
}

// ---------- API helpers (env-scoped) ----------

const MODE_API: Record<FsMode, string> = {
  vfs: '/api/inspector/vfs',
  fs: '/api/inspector/fs',
};

async function inspectorGet<T>(mode: FsMode, params: string): Promise<T> {
  return apiFetch<T>(`${MODE_API[mode]}?${params}`);
}

async function inspectorPost<T>(mode: FsMode, body: Record<string, unknown>): Promise<T> {
  return apiFetch<T>(MODE_API[mode], { method: 'POST', body: JSON.stringify(body) });
}

async function inspectorUpload(mode: FsMode, dir: string, files: File[]): Promise<{ uploaded: number; files: { name: string; path: string }[] }> {
  const form = new FormData();
  form.set('op', 'upload');
  form.set('path', dir);
  for (const f of files) form.append('files', f);
  return apiFetch<{ uploaded: number; files: { name: string; path: string }[] }>(MODE_API[mode], { method: 'POST', body: form });
}

function fmtError(e: unknown): string {
  if (e instanceof ApiClientError) {
    return e.code && e.code !== 'http_error' ? `${e.message} (${e.code})` : e.message;
  }
  return e instanceof Error ? e.message : 'Inspection request failed.';
}

/** Trigger a browser download for a GET-produced file (correct filename). */
async function downloadGet(mode: FsMode, params: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${MODE_API[mode]}?${params}`);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch { /* keep status text */ }
    throw new Error(message);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadPostZip(mode: FsMode, paths: string[]): Promise<void> {
  const res = await fetch(MODE_API[mode], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'zip', paths }) });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch { /* keep */ }
    throw new Error(message);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? 'selection.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- path helpers ----------

function rootOf(mode: FsMode): string {
  return mode === 'vfs' ? '/' : '';
}

function joinPath(mode: FsMode, base: string, name: string): string {
  if (mode === 'vfs') return base === '/' ? `/${name}` : `${base}/${name}`;
  return base === '' ? name : `${base}/${name}`;
}

function parentOf(mode: FsMode, p: string): string | null {
  if (mode === 'vfs') {
    if (p === '/') return null;
    const idx = p.lastIndexOf('/');
    return idx <= 0 ? '/' : p.slice(0, idx);
  }
  if (p === '' || p === '.') return null;
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function normalizeInput(mode: FsMode, raw: string): string {
  const t = raw.trim();
  if (mode === 'vfs') {
    const withSlash = t === '' ? '/' : t.startsWith('/') ? t : `/${t}`;
    return withSlash.replace(/\/+$/, '') || '/';
  }
  return t.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function kindBadgeClass(kind: EntryKind): string {
  switch (kind) {
    case 'dir':
      return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300';
    case 'link':
      return 'border-amber-400/30 bg-amber-400/10 text-amber-300';
    default:
      return 'border-white/[0.09] bg-white/[0.03] text-muted-foreground';
  }
}

function humanBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

// =====================================================================
// The view
// =====================================================================

export default function InspectorView() {
  // Shared environment selector — every tab operates on THIS environment.
  const [mode, setMode] = useState<FsMode>('vfs');
  // Per-environment current directory (both stay alive while switching).
  const [paths, setPaths] = useState<Record<FsMode, string>>({ vfs: '/', fs: '' });
  // v1.0.13 §2.4/§2.5 — the three internal tabs.
  const [topTab, setTopTab] = useState<'files' | 'editors' | 'terminal'>('files');
  const [usage, setUsage] = useState<VfsUsage | null>(null);
  // Files → Editors hand-off (prop-driven: the Radix panel is unmounted while
  // inactive, so a window event dispatched before mount would be lost).
  const [editRequest, setEditRequest] = useState<{ seq: number; mode: FsMode; path: string; name: string } | null>(null);
  const editSeq = useRef(0);

  return (
    <div className="space-y-4">
      <SectionTitle
        icon={<FolderTree className="size-4 text-sky-300" aria-hidden />}
        title="FS Inspector"
        desc={`v${APP_VERSION} operator file manager — browse, edit, compress, upload/download and run terminals in the shared Virtual FS and the real host filesystem (confined to the runtime working directory).`}
      />

      {/* environment selector + VFS usage snapshot */}
      <div className="glass-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none">
          <span className="font-tech text-[10px] uppercase tracking-wider text-muted-foreground">Environment</span>
          <Select value={mode} onValueChange={(v) => setMode(v as FsMode)}>
            <SelectTrigger className="h-9 w-[120px] border-white/[0.09] bg-white/[0.04] font-mono text-xs" aria-label="Filesystem environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vfs" className="text-xs">VFS</SelectItem>
              <SelectItem value="fs" className="text-xs">FS (real)</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" className={cn('max-w-full truncate font-mono text-[10px]', mode === 'vfs' ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300')}>
            <span className="sm:hidden">{mode === 'vfs' ? 'shared VFS' : 'real FS'}</span>
            <span className="hidden sm:inline">{mode === 'vfs' ? 'shared virtual filesystem' : 'host fs · confined to runtime cwd'}</span>
          </Badge>
        </div>
        {mode === 'vfs' ? (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span className="flex items-center gap-1.5 text-sky-300/80">
              <HardDrive className="size-3.5" aria-hidden /> usage
            </span>
            <span className="text-foreground/90">{usage ? humanBytes(usage.usedBytes) : '—'}</span>
            <span className="text-muted-foreground">{usage ? `${usage.files} files` : '—'}</span>
            <span className="text-muted-foreground">cap {usage ? humanBytes(usage.limits.maxTotalBytes) : '—'}</span>
          </div>
        ) : null}
      </div>

      <Tabs value={topTab} onValueChange={(v) => setTopTab(v as typeof topTab)} className="gap-4">
        {/* Mobile: full-width, ≥44px touch targets (§2.9). */}
        <TabsList className="grid w-full grid-cols-3 sm:inline-flex sm:w-auto">
          <TabsTrigger value="files" className="min-h-11 px-4 sm:min-h-9 sm:px-3">Files</TabsTrigger>
          <TabsTrigger value="editors" className="min-h-11 px-4 sm:min-h-9 sm:px-3">Editors</TabsTrigger>
          <TabsTrigger value="terminal" className="min-h-11 px-4 sm:min-h-9 sm:px-3">Terminal</TabsTrigger>
        </TabsList>
        <TabsContent value="files">
          <FilesTab
            mode={mode}
            path={paths[mode]}
            setPath={(p) => setPaths((prev) => ({ ...prev, [mode]: p }))}
            onUsage={setUsage}
            onEdit={(path, name) => {
              editSeq.current += 1;
              setEditRequest({ seq: editSeq.current, mode, path, name });
              setTopTab('editors');
            }}
          />
        </TabsContent>
        {/* forceMount keeps editor state alive across tab switches; the
            data-state selector hides the panel while inactive (Radix with
            forceMount never applies `hidden` itself — without this BOTH the
            editor and terminal panels rendered at once). */}
        <TabsContent value="editors" forceMount className="data-[state=inactive]:hidden">
          <EditorsTab mode={mode} editRequest={editRequest} />
        </TabsContent>
        <TabsContent value="terminal">
          <TerminalTab mode={mode} initialCwd={paths[mode]} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// =====================================================================
// FILES tab
// =====================================================================

function FilesTab({
  mode, path, setPath, onUsage, onEdit,
}: {
  mode: FsMode;
  path: string;
  setPath: (p: string) => void;
  onUsage: (u: VfsUsage) => void;
  onEdit: (path: string, name: string) => void;
}) {
  const [inputValue, setInputValue] = useState(path);
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const lastIndexRef = useRef<number>(-1);
  const [clipboard, setClipboard] = useState<{ cut: boolean; paths: string[] } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [busyOp, setBusyOp] = useState(false);

  // dialogs
  const [preview, setPreview] = useState<{ name: string; path: string; data: ReadResponse } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [infoEntry, setInfoEntry] = useState<InfoEntry | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ path: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [moveDest, setMoveDest] = useState<string | null>(null);

  // search (§2.6 — configurable depth)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDepth, setSearchDepth] = useState('5');
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);

  const list = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await inspectorGet<ListResponse>(mode, `op=list&path=${encodeURIComponent(target)}`);
        setEntries(data.entries);
        setPath(data.path);
        setInputValue(data.path === '' ? '.' : data.path);
        setSelection(new Set());
        setSearchResults(null);
        if (mode === 'vfs' && data.usage) onUsage(data.usage);
      } catch (e) {
        setEntries(null);
        setError(fmtError(e));
      } finally {
        setLoading(false);
      }
    },
    [mode, setPath, onUsage],
  );

  // Keep the input in sync when the directory changes from outside (Up/Root/etc).
  useEffect(() => {
    setInputValue(path === '' ? '.' : path);
  }, [path, mode]);

  useEffect(() => {
    void list(rootOf(mode));
  }, [mode]);

  const refresh = () => void list(path);

  const openDir = (entry: FsEntry) => void list(joinPath(mode, path, entry.name));

  const openFile = async (entry: FsEntry) => {
    const target = joinPath(mode, path, entry.name);
    setPreviewLoading(true);
    setError(null);
    try {
      const data = await inspectorGet<ReadResponse>(mode, `op=read&path=${encodeURIComponent(target)}`);
      setPreview({ name: entry.name, path: data.path, data });
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const openInfo = async (entry: FsEntry) => {
    setInfoLoading(true);
    setInfoEntry(null);
    try {
      const data = await inspectorPost<{ entry: InfoEntry }>(mode, { op: 'info', path: joinPath(mode, path, entry.name) });
      setInfoEntry(data.entry);
    } catch (e) {
      toast.error('Info failed', { description: fmtError(e) });
    } finally {
      setInfoLoading(false);
    }
  };

  const mutation = async (fn: () => Promise<void>, success?: string) => {
    setBusyOp(true);
    try {
      await fn();
      if (success) toast.success(success);
      await list(path);
    } catch (e) {
      toast.error('Operation failed', { description: fmtError(e) });
      await list(path);
    } finally {
      setBusyOp(false);
    }
  };

  // ----- selection (checkbox + ctrl/cmd + shift-range) -----
  const toggleSelect = (entry: FsEntry, index: number, opts: { range?: boolean; additive?: boolean } = {}) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (opts.range && lastIndexRef.current >= 0 && entries) {
        const [a, b] = [Math.min(lastIndexRef.current, index), Math.max(lastIndexRef.current, index)];
        for (let i = a; i <= b; i++) next.add(entries[i].name);
        return next;
      }
      if (next.has(entry.name) && !opts.additive) next.delete(entry.name);
      else next.add(entry.name);
      return next;
    });
    lastIndexRef.current = index;
  };

  const allSelected = entries !== null && entries.length > 0 && selection.size === entries.length;
  const selectAll = () => {
    if (!entries) return;
    setSelection(allSelected ? new Set() : new Set(entries.map((e) => e.name)));
  };
  const selectedPaths = useMemo(
    () => (entries ? [...selection].map((name) => joinPath(mode, path, name)) : []),
    [selection, entries, mode, path],
  );
  const hasSelection = selection.size > 0;
  const selectedIsSingleFile = selection.size === 1 && entries?.find((e) => e.name === [...selection][0])?.kind === 'file';

  // ----- actions -----
  const doDelete = () => {
    if (!hasSelection) return;
    if (!window.confirm(`Delete ${selection.size} item(s) from ${mode === 'vfs' ? 'the shared VFS' : 'the real FS'}? This cannot be undone.`)) return;
    void mutation(async () => {
      const res = await inspectorPost<{ deleted: number; results: { ok: boolean; message?: string }[] }>(mode, { op: 'delete', paths: selectedPaths });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length > 0) toast.warning(`${failed.length} item(s) failed to delete`, { description: failed.map((f) => f.message).slice(0, 3).join(' · ') });
    }, `${selection.size} item(s) deleted`);
  };

  const doCopy = () => hasSelection && setClipboard({ cut: false, paths: selectedPaths });
  const doCut = () => hasSelection && setClipboard({ cut: true, paths: selectedPaths });

  const doPaste = () => {
    if (!clipboard) return;
    void mutation(async () => {
      await inspectorPost(mode, { op: clipboard.cut ? 'move' : 'copy', paths: clipboard.paths, dest: path });
      setClipboard(null);
    }, clipboard.cut ? 'Moved' : 'Copied');
  };

  const doDuplicate = () => hasSelection && void mutation(
    async () => {
      await inspectorPost(mode, { op: 'duplicate', paths: selectedPaths });
    },
    'Duplicated',
  );

  const doCompress = () => {
    if (!hasSelection) return;
    void mutation(async () => {
      await downloadPostZip(mode, selectedPaths);
    }, 'ZIP downloaded (hierarchy preserved)');
  };

  const doCompressToFolder = () => {
    if (!hasSelection) return;
    void mutation(async () => {
      await inspectorPost(mode, { op: 'zip', paths: selectedPaths, dest: path });
    }, 'ZIP written into the current folder');
  };

  const doDownload = () => {
    if (!hasSelection) return;
    if (selection.size === 1 && selectedIsSingleFile) {
      const p = selectedPaths[0];
      const name = [...selection][0];
      void downloadGet(mode, `op=download&path=${encodeURIComponent(p)}`, name)
        .then(() => toast.success('Download started', { description: name }))
        .catch((e) => toast.error('Download failed', { description: fmtError(e) }));
      return;
    }
    void downloadGet(mode, `op=download&paths=${encodeURIComponent(JSON.stringify(selectedPaths))}`, 'selection.zip')
      .then(() => toast.success('ZIP download started', { description: `${selection.size} item(s)` }))
      .catch((e) => toast.error('Download failed', { description: fmtError(e) }));
  };

  const doUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void mutation(async () => {
      const res = await inspectorUpload(mode, path, Array.from(files));
      toast.success(`Uploaded ${res.uploaded} file(s) → ${mode === 'vfs' ? 'VFS' : 'FS'} ${path || '.'}`);
    });
  };

  const doCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderOpen(false);
    void mutation(async () => {
      await inspectorPost(mode, { op: 'mkdir', path: joinPath(mode, path, name) });
    }, `Folder "${name}" created`);
    setNewFolderName('');
  };

  const doCreateFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    setNewFileOpen(false);
    void mutation(async () => {
      await inspectorPost(mode, { op: 'write', path: joinPath(mode, path, name), content: '' });
    }, `File "${name}" created`);
    setNewFileName('');
  };

  const doRename = () => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!newName || newName === renameTarget.name) return;
    setRenameTarget(null);
    void mutation(async () => {
      await inspectorPost(mode, { op: 'rename', path: renameTarget.path, newName });
    }, `Renamed to "${newName}"`);
  };

  const doMoveTo = () => {
    if (!moveDest) return;
    setMoveDest(null);
    void mutation(async () => {
      await inspectorPost(mode, { op: 'move', paths: selectedPaths, dest: moveDest });
    }, `Moved to ${moveDest}`);
  };

  const doSearch = () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    void inspectorPost<{ matches: SearchMatch[]; truncated: boolean }>(mode, { op: 'search', path, query: q, depth: Number(searchDepth) })
      .then((res) => {
        setSearchResults(res.matches);
        setSearchTruncated(res.truncated);
      })
      .catch((e) => toast.error('Search failed', { description: fmtError(e) }))
      .finally(() => setSearching(false));
  };

  const copyPath = (entry: FsEntry) => {
    const full = joinPath(mode, path, entry.name);
    void navigator.clipboard.writeText(full)
      .then(() => toast.success('Path copied', { description: full }))
      .catch(() => toast.error('Clipboard unavailable'));
  };

  const inputLabel = mode === 'vfs' ? 'Virtual path' : 'Real path (relative to runtime cwd)';

  // bulk-action validity (§2.2 — invalid actions are DISABLED, not silently failing)
  const canDownloadSelection = hasSelection;
  const canCompress = hasSelection;

  return (
    <div className="space-y-4">
      {/* path bar — mobile: path input gets its own row, actions flow below */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void list(normalizeInput(mode, inputValue));
          }}
          placeholder={mode === 'vfs' ? '/workspace' : './src'}
          aria-label={inputLabel}
          className="h-11 min-w-0 flex-1 basis-52 font-mono text-xs"
        />
        <Button type="button" size="sm" className="h-11 px-5" onClick={() => void list(normalizeInput(mode, inputValue))} disabled={loading}>
          Go
        </Button>
        <Button
          type="button" variant="outline" size="sm" className="h-11 px-3"
          onClick={() => { const parent = parentOf(mode, path); if (parent !== null) void list(parent); }}
          disabled={loading || parentOf(mode, path) === null}
          aria-label="Parent directory" title="Parent directory"
        >
          <CornerLeftUp className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-11 px-3" onClick={() => void list(rootOf(mode))} disabled={loading} aria-label="Root directory" title="Root">
          <FolderTree className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-11 px-3" onClick={refresh} disabled={loading} aria-label="Refresh listing" title="Refresh">
          {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
        </Button>
      </div>

      {/* toolbar — icons-only labels collapse on the narrowest screens (§2.9) */}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="h-11 px-3 text-xs" onClick={() => setNewFileOpen(true)} aria-label="Create file">
          <FilePlus2 className="size-4" aria-hidden /> <span className="hidden min-[420px]:inline">New file</span>
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-11 px-3 text-xs" onClick={() => setNewFolderOpen(true)} aria-label="Create folder">
          <FolderPlus className="size-4" aria-hidden /> <span className="hidden min-[420px]:inline">New folder</span>
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-11 px-3 text-xs" onClick={() => uploadInputRef.current?.click()} aria-label={`Upload files into ${mode === 'vfs' ? 'the VFS' : 'the real FS'}`}>
          <Upload className="size-4" aria-hidden /> <span className="hidden min-[420px]:inline">Upload</span><span className="min-[420px]:hidden" aria-hidden>→</span> {mode === 'vfs' ? 'VFS' : 'FS'}
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-11 px-3 text-xs" onClick={doPaste} disabled={!clipboard || busyOp} aria-label="Paste clipboard">
          <ClipboardPaste className="size-4" aria-hidden /> <span className="hidden min-[420px]:inline">Paste</span>{clipboard ? (clipboard.cut ? ' (cut)' : ' (copy)') : ''}
        </Button>
        {clipboard ? (
          <Button type="button" variant="ghost" size="sm" className="h-11 px-2 text-xs text-muted-foreground" onClick={() => setClipboard(null)} aria-label="Clear clipboard">
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>

      {/* search bar (§2.6) */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doSearch();
          }}
          placeholder="Search files..."
          aria-label="Search files"
          className="h-11 min-w-0 flex-1 text-xs"
        />
        <Select value={searchDepth} onValueChange={setSearchDepth}>
          <SelectTrigger className="h-11 w-[150px] border-white/[0.09] bg-white/[0.04] text-xs" aria-label="Search depth">
            <span className="text-muted-foreground">Depth:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['0', '1', '2', '3', '5', '7', '10'].map((d) => (
              <SelectItem key={d} value={d} className="text-xs">
                {d === '0' ? '0 · current only' : `${d} level${d === '1' ? '' : 's'}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" className="h-11 px-4 text-xs" onClick={doSearch} disabled={searching || !searchQuery.trim()}>
          {searching ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />} Search
        </Button>
        {searchResults ? (
          <Button type="button" variant="ghost" size="sm" className="h-11 px-3 text-xs" onClick={() => setSearchResults(null)}>
            <XCircle className="size-4" aria-hidden /> Clear results
          </Button>
        ) : null}
      </div>

      {/* search results */}
      {searchResults ? (
        <div className="glass-card rounded-lg border border-white/[0.06] p-3">
          <p className="mb-2 font-mono text-[11px] text-muted-foreground">
            {searchResults.length} match(es) for &quot;{searchQuery}&quot;{searchTruncated ? ' · capped — refine the query' : ''}
          </p>
          <div className="nextool-scroll max-h-52 space-y-1 overflow-y-auto">
            {searchResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">No matches.</p>
            ) : (
              searchResults.map((m) => (
                <button
                  key={m.path}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/[0.05]"
                  onClick={() => void list(m.kind === 'dir' ? m.path : m.folder)}
                >
                  {m.kind === 'dir' ? <Folder className="size-3.5 text-emerald-300/80" aria-hidden /> : <FileIcon className="size-3.5 text-slate-300/80" aria-hidden />}
                  <span className="font-mono text-xs text-foreground/90">{m.name}</span>
                  <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">{m.folder}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {/* real-FS confinement notice */}
      {mode === 'fs' ? (
        <Alert className="border-white/[0.09] bg-white/[0.03]">
          <ShieldCheck className="size-4 text-emerald-300" aria-hidden />
          <AlertTitle>Real FS · confined to the runtime working directory</AlertTitle>
          <AlertDescription>
            Full operator file management INSIDE the directory the NexTool runtime runs in. Paths resolving outside it — including symlinks — are rejected with <span className="font-mono text-[11px]">FS_ACCESS</span>.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Inspection failed</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs">{error}</span>
            <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11" onClick={refresh}>
              <RefreshCw className="size-3.5" aria-hidden /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* bulk action bar (§2.2) */}
      {hasSelection ? (
        <div className="glass-card sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2">
          <span className="font-mono text-[11px] text-foreground">{selection.size} selected</span>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={doCopy} disabled={busyOp}><Copy className="size-3.5" aria-hidden /> Copy</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={() => setMoveDest(path)} disabled={busyOp}><FolderOpen className="size-3.5" aria-hidden /> Move…</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={doCut} disabled={busyOp}><Scissors className="size-3.5" aria-hidden /> Cut</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={doDuplicate} disabled={busyOp}><Plus className="size-3.5" aria-hidden /> Duplicate</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={doDownload} disabled={!canDownloadSelection}><Download className="size-3.5" aria-hidden /> Download</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={doCompress} disabled={!canCompress}><FileArchive className="size-3.5" aria-hidden /> ZIP (download)</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={doCompressToFolder} disabled={!canCompress}><FileArchive className="size-3.5" aria-hidden /> ZIP (to folder)</Button>
          <Button type="button" variant="outline" size="sm" className="min-h-9 border-rose-500/40 text-xs text-rose-300 hover:bg-rose-500/10" onClick={doDelete} disabled={busyOp}><Trash2 className="size-3.5" aria-hidden /> Delete</Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-9 text-xs text-muted-foreground" onClick={() => setSelection(new Set())}>Clear selection</Button>
        </div>
      ) : null}

      {/* listing — mobile gets a taller viewport (55vh) so the file tree is usable */}
      <ScrollArea className="glass-card max-h-[55vh] rounded-lg border border-white/[0.06] sm:max-h-[26rem] md:max-h-96">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox checked={allSelected ? true : selection.size > 0 ? 'indeterminate' : false} onCheckedChange={selectAll} aria-label="Select all" />
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">name</TableHead>
              <TableHead className="hidden w-20 text-[10px] uppercase tracking-wider text-muted-foreground sm:table-cell">kind</TableHead>
              <TableHead className="hidden w-24 text-right text-[10px] uppercase tracking-wider text-muted-foreground md:table-cell">size</TableHead>
              <TableHead className="hidden w-44 text-right text-[10px] uppercase tracking-wider text-muted-foreground md:table-cell">updated</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries === null && !loading ? (
              <TableRow className="border-white/[0.06]">
                <TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">Nothing loaded — press Go to inspect a path.</TableCell>
              </TableRow>
            ) : null}
            {loading ? (
              <TableRow className="border-white/[0.06]">
                <TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" aria-hidden /> loading {path || '/'}…</span>
                </TableCell>
              </TableRow>
            ) : null}
            {entries !== null && !loading && entries.length === 0 ? (
              <TableRow className="border-white/[0.06]">
                <TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">Empty directory</TableCell>
              </TableRow>
            ) : null}
            {entries !== null && !loading
              ? entries.map((entry, index) => {
                const checked = selection.has(entry.name);
                const full = joinPath(mode, path, entry.name);
                return (
                  <TableRow key={entry.name} className={cn('border-white/[0.06]', checked && 'bg-sky-400/[0.05]')}>
                    <TableCell onClick={(e) => { e.stopPropagation(); toggleSelect(entry, index, { additive: e.nativeEvent instanceof MouseEvent && (e.nativeEvent as MouseEvent).ctrlKey || (e.nativeEvent as MouseEvent).metaKey }); }}>
                      <Checkbox checked={checked} onCheckedChange={() => toggleSelect(entry, index)} aria-label={`Select ${entry.name}`} />
                    </TableCell>
                    <TableCell className="max-w-[240px] py-2 md:max-w-[280px]">
                      <span className="flex min-w-0 items-center gap-2">
                        {/* mobile: the kind badge column is hidden — kind glyph stays inline before the name */}
                        <span className="font-mono text-[10px] uppercase text-muted-foreground sm:hidden" aria-hidden>
                          {entry.kind === 'dir' ? 'dir/' : entry.kind === 'link' ? 'lnk' : 'file'}
                        </span>
                        {entry.kind === 'dir' ? (
                          <Folder className="size-3.5 shrink-0 text-emerald-300/80" aria-hidden />
                        ) : entry.kind === 'link' ? (
                          <Link2 className="size-3.5 shrink-0 text-amber-300/80" aria-hidden />
                        ) : (
                          <FileIcon className="size-3.5 shrink-0 text-slate-300/80" aria-hidden />
                        )}
                        <button
                          type="button"
                          className={cn('truncate font-mono text-xs', entry.kind !== 'link' ? 'text-foreground/90 hover:text-sky-300' : 'text-muted-foreground')}
                          onClick={() => (entry.kind === 'dir' ? openDir(entry) : entry.kind === 'file' ? void openFile(entry) : undefined)}
                          title={entry.name}
                        >
                          {entry.name}
                        </button>
                        <span className="ml-auto hidden gap-1 sm:flex">
                          {entry.kind === 'file' && !isImageLike(entry.name) ? (
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-muted-foreground" onClick={() => onEdit(full, entry.name)} aria-label={`Edit ${entry.name}`}>
                              <Pencil className="size-3" aria-hidden /> Edit
                            </Button>
                          ) : null}
                          {isImageLike(entry.name) ? (
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-muted-foreground" onClick={() => void openFile(entry)} aria-label={`Preview ${entry.name}`}>
                              <Info className="size-3" aria-hidden /> Preview
                            </Button>
                          ) : null}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="hidden py-2 sm:table-cell">
                      <Badge variant="outline" className={cn('font-mono text-[11px]', kindBadgeClass(entry.kind))}>{entry.kind}</Badge>
                    </TableCell>
                    <TableCell className="hidden py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground md:table-cell">{humanBytes(entry.size)}</TableCell>
                    <TableCell className="hidden py-2 text-right font-mono text-[11px] text-muted-foreground md:table-cell">{entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '—'}</TableCell>
                    <TableCell className="py-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="sm" className="size-9 p-0 text-base leading-none" aria-label={`Actions for ${entry.name}`}>
                            ⋯
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="glass-strong">
                          <DropdownMenuItem onClick={() => (entry.kind === 'dir' ? openDir(entry) : void openFile(entry))}>
                            <FolderOpen className="size-3.5" aria-hidden /> Open / preview
                          </DropdownMenuItem>
                          {entry.kind === 'file' ? (
                            <DropdownMenuItem onClick={() => onEdit(full, entry.name)}>
                              <Pencil className="size-3.5" aria-hidden /> Edit
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onClick={() => { setRenameTarget({ path: full, name: entry.name }); setRenameValue(entry.name); }}>
                            <Pencil className="size-3.5" aria-hidden /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setSelection(new Set([entry.name])); setMoveDest(path); }}>
                            <FolderOpen className="size-3.5" aria-hidden /> Move to…
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void mutation(async () => { await inspectorPost(mode, { op: 'duplicate', paths: [full] }); }, 'Duplicated')}>
                            <Copy className="size-3.5" aria-hidden /> Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={copyPath}>
                            <Copy className="size-3.5" aria-hidden /> Copy path
                          </DropdownMenuItem>
                          {entry.kind === 'file' ? (
                            <DropdownMenuItem onClick={() => void downloadGet(mode, `op=download&path=${encodeURIComponent(full)}`, entry.name).then(() => toast.success('Download started', { description: entry.name })).catch((e) => toast.error('Download failed', { description: fmtError(e) }))}>
                              <Download className="size-3.5" aria-hidden /> Download
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => void downloadGet(mode, `op=download&path=${encodeURIComponent(full)}`, `${entry.name}.zip`).then(() => toast.success('ZIP download started', { description: entry.name })).catch((e) => toast.error('Download failed', { description: fmtError(e) }))}>
                              <FileArchive className="size-3.5" aria-hidden /> Download as ZIP
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => void openInfo(entry)}>
                            <Info className="size-3.5" aria-hidden /> Information
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-rose-300 focus:text-rose-300"
                            onClick={() => { setSelection(new Set([entry.name])); setTimeout(doDelete, 0); }}
                          >
                            <Trash2 className="size-3.5" aria-hidden /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
              : null}
          </TableBody>
        </Table>
      </ScrollArea>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          doUpload(e.target.files);
          e.target.value = '';
        }}
        aria-hidden
        tabIndex={-1}
      />

      {/* preview dialog (§2.3) */}
      <Dialog open={preview !== null || previewLoading} onOpenChange={(v) => (!v ? setPreview(null) : undefined)}>
        <DialogContent className="glass-strong sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-all font-mono text-sm">{preview?.name ?? 'Loading…'}</DialogTitle>
            <DialogDescription className="break-all font-mono text-[11px]">{preview?.path}</DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="border-white/[0.09] bg-white/[0.03] font-mono text-[10px] text-muted-foreground">{humanBytes(preview.data.size)}</Badge>
                <Badge variant="outline" className="border-white/[0.09] bg-white/[0.03] font-mono text-[10px] text-muted-foreground">{preview.data.mime}</Badge>
                {preview.data.truncated ? <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-300">first 64 KiB</Badge> : null}
                <Button type="button" size="sm" variant="outline" className="ml-auto min-h-9 text-xs" onClick={() => onEdit(joinPath(mode, preview.path.startsWith('/') ? '' : path, preview.name), preview.name)}>
                  <Pencil className="size-3.5" aria-hidden /> Edit
                </Button>
              </div>
              {isImageLike(preview.name) ? (
                <div className="flex max-h-[50vh] items-center justify-center overflow-hidden rounded-md border border-white/[0.08] bg-black/30 p-2">
                  <img
                    src={`data:${preview.data.mime};base64,${preview.data.encoding === 'base64' ? preview.data.content : btoa(unescape(encodeURIComponent(preview.data.content)))}`}
                    alt={`Preview of ${preview.name}`}
                    className="max-h-[48vh] max-w-full object-contain"
                  />
                </div>
              ) : isTextLike(preview.name) || preview.data.textual ? (
                <ScrollArea className="max-h-[50vh]">
                  <pre className="nextool-scroll max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-white/[0.08] bg-black/30 p-3 font-mono text-xs text-slate-200">
                    {preview.data.content}
                  </pre>
                </ScrollArea>
              ) : (
                <div className="rounded-md border border-white/[0.08] bg-black/30 p-4 text-center text-xs text-muted-foreground">
                  Binary content — no inline preview. Size {humanBytes(preview.data.size)}, type {preview.data.mime}. Use Download to export it.
                </div>
              )}
            </div>
          ) : (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> loading preview…</p>
          )}
        </DialogContent>
      </Dialog>

      {/* info dialog (§2.8) */}
      <Dialog open={infoEntry !== null || infoLoading} onOpenChange={(v) => (!v ? setInfoEntry(null) : undefined)}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>File information</DialogTitle>
            <DialogDescription>{infoEntry?.environment === 'vfs' ? 'Shared virtual filesystem entry' : 'Real filesystem entry (confined)'}</DialogDescription>
          </DialogHeader>
          {infoEntry ? (
            <div className="nextool-scroll max-h-[50vh] space-y-1.5 overflow-y-auto font-mono text-xs">
              <InfoRow label="name" value={infoEntry.name} />
              <InfoRow label="kind" value={infoEntry.kind} />
              <InfoRow label="size" value={humanBytes(infoEntry.size)} />
              <InfoRow label="created" value={infoEntry.createdAt ? new Date(infoEntry.createdAt).toLocaleString() : '—'} />
              <InfoRow label="modified" value={infoEntry.updatedAt ? new Date(infoEntry.updatedAt).toLocaleString() : '—'} />
              <InfoRow label="permissions" value={infoEntry.permissions ?? '—'} />
              <InfoRow label="environment" value={infoEntry.environment ?? '—'} />
              <InfoRow label="mime" value={infoEntry.mime ?? '—'} />
              {infoEntry.linkTarget ? <InfoRow label="link target" value={infoEntry.linkTarget} /> : null}
              {infoEntry.checksum ? <InfoRow label="sha256" value={infoEntry.checksum} monoBreak /> : null}
            </div>
          ) : (
            <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> loading info…</p>
          )}
        </DialogContent>
      </Dialog>

      {/* rename dialog */}
      <Dialog open={renameTarget !== null} onOpenChange={(v) => (!v ? setRenameTarget(null) : undefined)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription className="break-all font-mono text-[11px]">{renameTarget?.path}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-input">New name</Label>
            <Input id="rename-input" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doRename()} className="font-mono text-xs" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={doRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* new file / folder dialogs */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription className="font-mono text-[11px]">in {path || '.'} ({mode === 'vfs' ? 'VFS' : 'FS'})</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="newfolder-input">Folder name</Label>
            <Input id="newfolder-input" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doCreateFolder()} className="font-mono text-xs" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
            <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={doCreateFolder} disabled={!newFolderName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create file</DialogTitle>
            <DialogDescription className="font-mono text-[11px]">in {path || '.'} ({mode === 'vfs' ? 'VFS' : 'FS'}) — empty file; open it in the editor to add content.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="newfile-input">File name</Label>
            <Input id="newfile-input" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doCreateFile()} className="font-mono text-xs" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={() => setNewFileOpen(false)}>Cancel</Button>
            <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={doCreateFile} disabled={!newFileName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* move-to dialog */}
      <Dialog open={moveDest !== null} onOpenChange={(v) => (!v ? setMoveDest(null) : undefined)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move {selection.size} item(s)</DialogTitle>
            <DialogDescription>Destination folder path ({mode === 'vfs' ? 'virtual' : 'cwd-relative'}).</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="movedest-input">Destination</Label>
            <Input id="movedest-input" value={moveDest ?? ''} onChange={(e) => setMoveDest(e.target.value)} className="font-mono text-xs" />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={() => setMoveDest(null)}>Cancel</Button>
            <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={doMoveTo}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({ label, value, monoBreak }: { label: string; value: string; monoBreak?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 flex-1 break-all text-foreground/90', monoBreak && 'text-[10px]')} title={value}>{value}</span>
    </div>
  );
}

// =====================================================================
// EDITORS tab (§2.4 — Monaco ON / textarea OFF, multi tabs, dirty state)
// =====================================================================

const MONACO_KEY = 'nextool.inspector.monaco';
let editorTabSeq = 0;

function EditorsTab({ mode, editRequest }: { mode: FsMode; editRequest: { seq: number; mode: FsMode; path: string; name: string } | null }) {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  // Mirror of tabs for synchronous lookups inside callbacks (no side effects
  // inside state updaters — safe against StrictMode double-invocation).
  const tabsRef = useRef<EditorTab[]>([]);
  tabsRef.current = tabs;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [monacoOn, setMonacoOn] = useState(true);
  const [saveTarget, setSaveTarget] = useState<{ tabId: string } | null>(null);
  const [saveName, setSaveName] = useState('');
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    try {
      setMonacoOn(window.localStorage.getItem(MONACO_KEY) !== '0');
    } catch { /* session-only */ }
  }, []);

  const toggleMonaco = (on: boolean) => {
    setMonacoOn(on);
    try {
      window.localStorage.setItem(MONACO_KEY, on ? '1' : '0');
    } catch { /* ignore */ }
  };

  const openTab = useCallback(async (env: FsMode, path: string, name: string) => {
    const existing = tabsRef.current.find((t) => t.env === env && t.path === path);
    const id = existing ? existing.id : `edt_${Date.now().toString(36)}_${editorTabSeq++}`;
    if (!existing) {
      setTabs((prev) => (prev.some((t) => t.env === env && t.path === path) ? prev : [...prev, { id, env, path, name, saved: '', draft: '', loading: true, saving: false }]));
    }
    setActiveId(id);
    try {
      const data = await inspectorGet<ReadResponse>(env, `op=read&path=${encodeURIComponent(path)}`);
      setTabs((prev) => prev.map((t) => (t.env === env && t.path === path
        ? { ...t, loading: false, saved: data.encoding === 'base64' ? '' : data.content, draft: data.encoding === 'base64' ? '' : data.content, name: data.name ?? name }
        : t)));
      if (data.encoding === 'base64') {
        toast.warning('Binary file', { description: `${name} is binary — only text files can be edited here.` });
      }
    } catch (e) {
      toast.error('Could not open file', { description: fmtError(e) });
      setTabs((prev) => prev.filter((t) => !(t.env === env && t.path === path)));
    }
  }, []);

  // Files tab "Edit" → open here (prop-driven hand-off from InspectorView).
  useEffect(() => {
    if (!editRequest) return;
    void openTab(editRequest.mode, editRequest.path, editRequest.name);
  }, [editRequest, openTab]);

  const active = tabs.find((t) => t.id === activeId) ?? null;
  const visibleTabs = tabs.filter((t) => t.env === modeRef.current);
  const dirtyCount = tabs.filter((t) => t.draft !== t.saved).length;

  const updateDraft = (id: string, draft: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, draft } : t)));
  };

  const closeTab = (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    if (tab.draft !== tab.saved && !window.confirm(`"${tab.name}" has unsaved changes. Close anyway?`)) return;
    const rest = tabsRef.current.filter((t) => t.id !== id);
    setTabs(rest);
    if (activeId === id) setActiveId(rest.length > 0 ? rest[rest.length - 1].id : null);
  };

  const closeAll = () => {
    if (dirtyCount > 0 && !window.confirm(`${dirtyCount} unsaved tab(s) will be discarded. Close all?`)) return;
    setTabs((prev) => prev.filter((t) => t.env !== modeRef.current));
    setActiveId(null);
  };

  const doSave = useCallback(async (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.path === null) {
      setSaveTarget({ tabId: id });
      setSaveName(tab.name);
      return;
    }
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, saving: true } : t)));
    try {
      await inspectorPost(tab.env, { op: 'write', path: tab.path, content: tab.draft, encoding: 'utf8' });
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, saved: t.draft, saving: false } : t)));
      toast.success('Saved', { description: tab.path });
    } catch (e) {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, saving: false } : t)));
      toast.error('Save failed', { description: fmtError(e) });
    }
  }, [tabs]);

  // Ctrl/Cmd+S saves the ACTIVE tab while the editors tab is visible.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (activeId) void doSave(activeId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeId, doSave]);

  const doSaveAs = () => {
    if (!saveTarget) return;
    const tab = tabs.find((t) => t.id === saveTarget.tabId);
    const name = saveName.trim();
    if (!tab || !name) return;
    const parent = tab.path === null ? (parentOf(modeRef.current, '') ?? '') : parentOf(modeRef.current, tab.path) ?? '';
    const full = parent === '' ? name : `${parent}/${name}`;
    setSaveTarget(null);
    void (async () => {
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, saving: true } : t)));
      try {
        await inspectorPost(tab.env, { op: 'write', path: full, content: tab.draft, encoding: 'utf8' });
        setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, path: full, name, saved: t.draft, saving: false } : t)));
        toast.success('Saved', { description: full });
      } catch (e) {
        setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, saving: false } : t)));
        toast.error('Save failed', { description: fmtError(e) });
      }
    })();
  };

  const monacoOnMount: OnMount = (editor) => {
    editor.focus();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-tech text-[10px] uppercase tracking-wider text-muted-foreground">
          editor tabs · {mode === 'vfs' ? 'VFS' : 'FS'} {dirtyCount > 0 ? `· ${dirtyCount} unsaved` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="monaco-toggle" className="text-[11px] text-muted-foreground">Use Monaco Editor</Label>
          <Switch id="monaco-toggle" checked={monacoOn} onCheckedChange={toggleMonaco} aria-label="Toggle Monaco editor" />
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={closeAll} disabled={visibleTabs.length === 0}>
            Close all
          </Button>
        </div>
      </div>

      {visibleTabs.length === 0 ? (
        <div className="glass-card rounded-lg border border-white/[0.06] p-8 text-center">
          <p className="text-xs text-muted-foreground">
            No open editors for {mode === 'vfs' ? 'the VFS' : 'the FS'}. Use <span className="font-mono">Edit</span> on a file in the Files tab.
          </p>
        </div>
      ) : (
        <div className="glass-card rounded-lg border border-white/[0.06]">
          {/* tab strip */}
          <div className="nextool-scroll flex items-center gap-1 overflow-x-auto border-b border-white/[0.06] p-1.5">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveId(t.id)}
                className={cn(
                  'group flex min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px]',
                  activeId === t.id ? 'border-sky-400/40 bg-sky-400/10 text-foreground' : 'border-white/[0.07] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]',
                )}
                title={t.path ?? '(unsaved)'}
              >
                {t.loading ? <Loader2 className="size-3 animate-spin shrink-0" aria-hidden /> : t.draft !== t.saved ? <span className="size-1.5 shrink-0 rounded-full bg-amber-300" aria-label="unsaved changes" /> : <FileIcon className="size-3 shrink-0" aria-hidden />}
                <span className="truncate">{t.name}</span>
                <X
                  className="size-3 shrink-0 text-muted-foreground hover:text-rose-300"
                  aria-label={`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                />
              </button>
            ))}
          </div>

          {/* editor area — ONLY the active tab mounts (performance) */}
          {active ? (
            <div className="relative">
              <div className="flex items-center justify-between gap-2 px-3 pt-2">
                <span className="truncate font-mono text-[10px] text-muted-foreground" title={active.path ?? undefined}>{active.path ?? '(new file)'}</span>
                <Button type="button" size="sm" className="min-h-8 bg-primary-gradient text-[11px] text-primary-foreground hover:opacity-90" onClick={() => void doSave(active.id)} disabled={active.saving || active.loading}>
                  {active.saving ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Save className="size-3" aria-hidden />} Save
                </Button>
              </div>
              {monacoOn ? (
                <MonacoEditor
                  key={active.id}
                  height="420px"
                  theme="vs-dark"
                  language={active.name ? monacoLanguage(active.name) : 'plaintext'}
                  value={active.draft}
                  onChange={(v) => updateDraft(active.id, v ?? '')}
                  onMount={monacoOnMount}
                  loading={<p className="flex items-center gap-2 py-12 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> loading editor…</p>}
                  options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2 }}
                />
              ) : (
                /* textarea fallback — NOT optional per spec §2.4 */
                <textarea
                  value={active.draft}
                  onChange={(e) => updateDraft(active.id, e.target.value)}
                  spellCheck={false}
                  className="nextool-scroll h-[420px] w-full resize-y bg-black/30 p-3 font-mono text-xs text-slate-200 outline-none"
                  aria-label={`Edit ${active.name} (plain textarea)`}
                />
              )}
            </div>
          ) : (
            <p className="p-6 text-center text-xs text-muted-foreground">Select a tab.</p>
          )}
        </div>
      )}

      <Dialog open={saveTarget !== null} onOpenChange={(v) => (!v ? setSaveTarget(null) : undefined)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save new file</DialogTitle>
            <DialogDescription>File name in {mode === 'vfs' ? 'the VFS' : 'the FS'} root of the current directory context.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="saveas-input">File name</Label>
            <Input id="saveas-input" value={saveName} onChange={(e) => setSaveName(e.target.value)} className="font-mono text-xs" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={() => setSaveTarget(null)}>Cancel</Button>
            <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={doSaveAs} disabled={!saveName.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =====================================================================
// TERMINAL tab (§2.5 — FS real sessions / VFS sandboxed virtual shell)
// =====================================================================

let terminalSessionSeq = 0;

function TerminalTab({ mode, initialCwd }: { mode: FsMode; initialCwd: string }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const [vfsCwd, setVfsCwd] = useState('/');

  const visible = sessions.filter((s) => s.cwd !== undefined && (mode === 'fs' ? s.id.startsWith('fs_') : s.id.startsWith('vfs_')));
  const active = visible.find((s) => s.id === activeId) ?? visible[visible.length - 1] ?? null;

  useEffect(() => {
    if (mode === 'fs' && visible.length === 0) {
      const id = `fs_${Date.now().toString(36)}_${terminalSessionSeq++}`;
      setSessions((prev) => [...prev, { id, cwd: initialCwd || '.', lines: [{ kind: 'meta', text: 'Real FS terminal — bash, confined to the NexTool runtime working directory. 30 s hard timeout.' }] }]);
      setActiveId(id);
    }
    // VFS: ensure the sandbox shell session exists (side effects NEVER run
    // during render — the old inline `setSessions` in JSX could loop under
    // StrictMode).
    if (mode === 'vfs' && !sessions.some((s) => s.id === 'vfs_shell')) {
      setSessions((prev) => (prev.some((s) => s.id === 'vfs_shell') ? prev : [...prev, { id: 'vfs_shell', cwd: '/', lines: [{ kind: 'meta', text: 'VFS sandboxed shell — every command maps onto the VFS API; host paths are unreachable. Type "help".' }] }]));
    }
  }, [mode]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [active?.lines.length]);

  const appendLines = (id: string, lines: TerminalLine[]) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, lines: [...s.lines, ...lines] } : s)));
  };

  const setRunning = (id: string, running: boolean) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, running } : s)));
  };

  const runFsCommand = async (session: TerminalSession, command: string) => {
    appendLines(session.id, [{ kind: 'cmd', text: `${session.cwd} $ ${command}` }]);
    setRunning(session.id, true);
    try {
      const res = await apiFetch<{ stdout: string; stderr: string; code: number | null; signal: string | null; truncated: boolean; timedOut: boolean; cwd: string }>(
        '/api/inspector/terminal',
        { method: 'POST', body: JSON.stringify({ cwd: session.cwd, command }) },
      );
      const lines: TerminalLine[] = [];
      if (res.stdout) lines.push({ kind: 'out', text: res.stdout.replace(/\n$/, '') });
      if (res.stderr) lines.push({ kind: 'err', text: res.stderr.replace(/\n$/, '') });
      if (res.timedOut) lines.push({ kind: 'meta', text: 'command killed — 30 s hard timeout reached' });
      lines.push({ kind: 'code', text: `[exit ${res.code ?? 'null'}${res.signal ? ` · ${res.signal}` : ''}${res.truncated ? ' · output truncated' : ''}]` });
      appendLines(session.id, lines);
      if (command.trim().startsWith('cd ')) {
        setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, cwd: res.cwd } : s)));
      }
    } catch (e) {
      appendLines(session.id, [{ kind: 'err', text: fmtError(e) }]);
    } finally {
      setRunning(session.id, false);
    }
  };

  // VFS sandboxed virtual shell — mapped onto the VFS API, CANNOT escape.
  const runVfsCommand = async (command: string) => {
    const trimmed = command.trim();
    const out: TerminalLine[] = [{ kind: 'cmd', text: `${vfsCwd} $ ${command}` }];
    const failLine = (message: string): TerminalLine => ({ kind: 'err', text: message });
    const resolve = (p: string): string => {
      const t = p.trim();
      if (!t || t === '.') return vfsCwd;
      if (t.startsWith('/')) return normalizeInput('vfs', t);
      return childVfs(vfsCwd, t);
    };
    try {
      if (trimmed === 'pwd') out.push({ kind: 'out', text: vfsCwd });
      else if (trimmed === 'help') {
        out.push({ kind: 'out', text: 'sandboxed VFS shell — commands: pwd · ls [path] · cd <path> · cat <file> · mkdir <dir> · touch <file> · rm <path> · cp <a> <b> · mv <a> <b> · echo <text> [> file] · find <query> · clear · help' });
      } else if (trimmed === 'clear') {
        setSessions((prev) => prev.map((s) => (s.id === 'vfs_shell' ? { ...s, lines: [] } : s)));
        return;
      } else if (trimmed.startsWith('ls')) {
        const target = resolve(trimmed.slice(2));
        const data = await inspectorGet<ListResponse>('vfs', `op=list&path=${encodeURIComponent(target)}`);
        out.push({ kind: 'out', text: data.entries.length === 0 ? '(empty)' : data.entries.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name)).join('  ') });
      } else if (trimmed.startsWith('cd')) {
        const target = trimmed.slice(2).trim() ? resolve(trimmed.slice(2)) : '/';
        const st = await inspectorPost<{ entry: InfoEntry }>('vfs', { op: 'info', path: target });
        if (st.entry.kind !== 'dir') out.push(failLine(`cd: not a directory: ${target}`));
        else setVfsCwd(st.entry.name === '/' ? '/' : target);
      } else if (trimmed.startsWith('cat ')) {
        const data = await inspectorGet<ReadResponse>('vfs', `op=read&path=${encodeURIComponent(resolve(trimmed.slice(4)))}`);
        out.push({ kind: 'out', text: data.encoding === 'text' ? data.content : '(binary content)' });
      } else if (trimmed.startsWith('mkdir ')) {
        await inspectorPost('vfs', { op: 'mkdir', path: resolve(trimmed.slice(6)) });
      } else if (trimmed.startsWith('touch ')) {
        await inspectorPost('vfs', { op: 'write', path: resolve(trimmed.slice(6)), content: '' });
      } else if (trimmed.startsWith('rm ')) {
        await inspectorPost('vfs', { op: 'delete', paths: [resolve(trimmed.slice(3))] });
      } else if (trimmed.startsWith('cp ')) {
        const [, a, b] = trimmed.split(/\s+/);
        if (!a || !b) throw new Error('usage: cp <src> <dest>');
        await inspectorPost('vfs', { op: 'copy', paths: [resolve(a)], dest: parentVfs(resolve(b)) });
      } else if (trimmed.startsWith('mv ')) {
        const [, a, b] = trimmed.split(/\s+/);
        if (!a || !b) throw new Error('usage: mv <src> <dest>');
        await inspectorPost('vfs', { op: 'move', paths: [resolve(a)], dest: parentVfs(resolve(b)) });
      } else if (trimmed.startsWith('find ')) {
        const q = trimmed.slice(5).trim();
        const res = await inspectorPost<{ matches: SearchMatch[] }>('vfs', { op: 'search', path: vfsCwd, query: q, depth: 3 });
        out.push({ kind: 'out', text: res.matches.length === 0 ? '(no matches)' : res.matches.map((m) => m.path).join('\n') });
      } else if (trimmed.startsWith('echo ')) {
        const m = /\>\s*([^\s]+)\s*$/.exec(trimmed);
        if (m) {
          const text = trimmed.slice(5, trimmed.length - m[0].length).replace(/^["']|["']$/g, '');
          await inspectorPost('vfs', { op: 'write', path: resolve(m[1]), content: `${text}\n` });
        } else {
          out.push({ kind: 'out', text: trimmed.slice(5).replace(/^["']|["']$/g, '') });
        }
      } else {
        out.push(failLine(`command not found: ${trimmed.split(/\s+/)[0]} — type "help"`));
      }
    } catch (e) {
      out.push(failLine(fmtError(e)));
    }
    appendLines('vfs_shell', out);
  };

  const submit = (session: TerminalSession) => {
    const command = (inputs[session.id] ?? '').trim();
    if (!command || session.running) return;
    setInputs((prev) => ({ ...prev, [session.id]: '' }));
    if (mode === 'fs') void runFsCommand(session, command);
    else void runVfsCommand(command);
  };

  const newSession = () => {
    const id = `fs_${Date.now().toString(36)}_${terminalSessionSeq++}`;
    setSessions((prev) => [...prev, { id, cwd: '.', lines: [{ kind: 'meta', text: 'Real FS terminal session — confined to the runtime cwd.' }] }]);
    setActiveId(id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-tech text-[10px] uppercase tracking-wider text-muted-foreground">terminal sessions</span>
        <Badge variant="outline" className={cn('font-mono text-[10px]', mode === 'vfs' ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300')}>
          {mode === 'vfs' ? 'VFS sandbox — virtual shell (cannot escape)' : 'REAL FS — bash, confined to runtime cwd'}
        </Badge>
        {mode === 'fs' ? (
          <Button type="button" variant="outline" size="sm" className="min-h-9 text-xs" onClick={newSession} disabled={visible.length >= 4}>
            <Plus className="size-3.5" aria-hidden /> New session {visible.length >= 4 ? '(cap 4)' : ''}
          </Button>
        ) : null}
        {active ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto min-h-9 text-xs text-muted-foreground" onClick={() => setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, lines: [] } : s)))}>
            <XCircle className="size-3.5" aria-hidden /> Clear
          </Button>
        ) : null}
      </div>

      {mode === 'fs' && visible.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveId(s.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px]',
                active?.id === s.id ? 'border-sky-400/40 bg-sky-400/10 text-foreground' : 'border-white/[0.07] bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]',
              )}
            >
              <TerminalSquare className="size-3" aria-hidden /> {s.cwd} {s.running ? '· running' : ''}
              <X className="size-3 text-muted-foreground hover:text-rose-300" aria-label="Close session" onClick={(e) => { e.stopPropagation(); setSessions((prev) => prev.filter((x) => x.id !== s.id)); }} />
            </button>
          ))}
        </div>
      ) : null}

      <div className="glass-card rounded-lg border border-white/[0.06]">
        <div ref={scrollRef} className="nextool-scroll h-[50vh] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed md:h-[360px]">
          {(active?.lines ?? []).map((line, i) => (
            <p
              key={i}
              className={cn(
                'whitespace-pre-wrap break-all',
                line.kind === 'cmd' && 'text-sky-300',
                line.kind === 'out' && 'text-slate-200',
                line.kind === 'err' && 'text-rose-300',
                line.kind === 'meta' && 'text-muted-foreground',
                line.kind === 'code' && 'text-amber-300/80',
              )}
            >
              {line.text}
            </p>
          ))}
          {active?.running ? <p className="flex items-center gap-1.5 text-amber-300"><Loader2 className="size-3 animate-spin" aria-hidden /> running…</p> : null}
        </div>
        {active ? (
          <div className="flex items-center gap-2 border-t border-white/[0.06] p-2">
            <span className={cn('shrink-0 font-mono text-[11px]', mode === 'vfs' ? 'text-sky-300' : 'text-emerald-300')}>{mode === 'vfs' ? vfsCwd : active.cwd} $</span>
            <Input
              value={inputs[active.id] ?? ''}
              onChange={(e) => setInputs((prev) => ({ ...prev, [active.id]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && submit(active)}
              placeholder={mode === 'vfs' ? 'ls · cat · mkdir · echo hi > file.txt … (help)' : 'command (30 s timeout)…'}
              className="h-9 min-w-0 flex-1 border-white/[0.09] bg-white/[0.04] font-mono text-xs"
              aria-label="Terminal command"
              autoComplete="off"
            />
          </div>
        ) : null}
      </div>
      {mode === 'vfs' ? (
        <p className="text-[10px] text-muted-foreground">
          The VFS terminal is a sandboxed interpreter: each command maps onto the same secure VFS API the restricted tool runtimes use — MCP and virtual tools can never reach the real host filesystem (spec §4.3/§19).
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">
          The FS terminal executes REAL commands on the self-hosted machine (bash, minimal env, 30 s hard timeout, output-capped) but its working directory stays confined to the NexTool runtime directory.
        </p>
      )}
    </div>
  );
}

function childVfs(dir: string, name: string): string {
  const clean = name.replace(/\/+$/, '');
  return dir === '/' ? `/${clean}` : `${dir}/${clean}`;
}

function parentVfs(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}
