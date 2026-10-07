'use client';

/**
 * FS Inspector (v1.0.13 "THE OPERATOR CONSOLE") — single-user operator,
 * strictly read-only inspection of BOTH filesystems the runtime works with:
 *
 *   · Virtual FS  — the GLOBAL shared tool filesystem (lib/nexool/tools/vfs)
 *     via /api/inspector/vfs. Includes a live usage snapshot.
 *   · Real FS     — the host filesystem, confined by the API to the runtime
 *     working directory (process.cwd()) via /api/inspector/fs.
 *
 * Pure inspection: nothing polls and nothing mutates. Listings and previews
 * load on demand (path change / tab switch / manual refresh). Errors from the
 * API (traversal attempts, FS_ACCESS confinement, size caps) surface honestly
 * with their codes.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, apiFetch } from '@/lib/nexool/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { SectionTitle } from '../ui-bits';
import {
  ChevronUp,
  CornerLeftUp,
  File as FileIcon,
  Folder,
  FolderTree,
  HardDrive,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

// ---------- shared types ----------

type FsMode = 'vfs' | 'real';
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
  limits: {
    maxTotalBytes: number;
    [key: string]: unknown;
  };
}

interface ListResponse {
  path: string;
  entries: FsEntry[];
  usage?: VfsUsage;
}

interface ReadResponse {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

interface Preview {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

// ---------- helpers ----------

/** Human-readable byte sizes (B/KB/MB/GB/TB). */
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

function fmtError(e: unknown): string {
  if (e instanceof ApiClientError) {
    return e.code && e.code !== 'http_error' ? `${e.message} (${e.code})` : e.message;
  }
  return e instanceof Error ? e.message : 'Inspection request failed.';
}

const MODE_API: Record<FsMode, string> = {
  vfs: '/api/inspector/vfs',
  real: '/api/inspector/fs',
};

function rootOf(mode: FsMode): string {
  return mode === 'vfs' ? '/' : '';
}

/** Join a directory path with a child entry name for the given mode. */
function joinPath(mode: FsMode, base: string, name: string): string {
  if (mode === 'vfs') return base === '/' ? `/${name}` : `${base}/${name}`;
  return base === '' ? name : `${base}/${name}`;
}

/** Parent path (null already at the root). */
function parentOf(mode: FsMode, p: string): string | null {
  if (mode === 'vfs') {
    if (p === '/') return null;
    const idx = p.lastIndexOf('/');
    return idx <= 0 ? '/' : p.slice(0, idx);
  }
  if (p === '') return null;
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** Normalize free-typed input into a navigable path for the given mode. */
function normalizeInput(mode: FsMode, raw: string): string {
  const t = raw.trim();
  if (mode === 'vfs') {
    const withSlash = t === '' ? '/' : t.startsWith('/') ? t : `/${t}`;
    return withSlash.replace(/\/+$/, '') || '/';
  }
  const stripped = t.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return stripped;
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

// ---------- one filesystem browser (per tab) ----------

function FsBrowser({ mode, onUsage }: { mode: FsMode; onUsage?: (usage: VfsUsage) => void }) {
  const [path, setPath] = useState<string>(() => rootOf(mode));
  const [inputValue, setInputValue] = useState<string>(() => rootOf(mode));
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const list = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch<ListResponse>(
          `${MODE_API[mode]}?op=list&path=${encodeURIComponent(target)}`,
        );
        setEntries(data.entries);
        // Adopt the API's canonical path (e.g. '/a/../b' normalizes server-side)
        // so the path bar and breadcrumb always reflect what is actually shown.
        setPath(data.path);
        setInputValue(data.path);
        if (mode === 'vfs' && data.usage) onUsage?.(data.usage);
      } catch (e) {
        setEntries(null);
        setError(fmtError(e));
      } finally {
        setLoading(false);
      }
    },
    [mode, onUsage],
  );

  // Fetch on demand: mount (tab switch), never polled.
  useEffect(() => {
    void list(rootOf(mode));
  }, [list]);

  const openDir = (entry: FsEntry) => {
    void list(joinPath(mode, path, entry.name));
  };

  const openFile = async (entry: FsEntry) => {
    const target = joinPath(mode, path, entry.name);
    setPreviewLoading(true);
    setError(null);
    try {
      const data = await apiFetch<ReadResponse>(
        `${MODE_API[mode]}?op=read&path=${encodeURIComponent(target)}`,
      );
      setPreview({ path: data.path, content: data.content, truncated: data.truncated, size: data.size });
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const goUp = () => {
    const parent = parentOf(mode, path);
    if (parent !== null) void list(parent);
  };

  const goRoot = () => {
    void list(rootOf(mode));
  };

  const go = () => {
    void list(normalizeInput(mode, inputValue));
  };

  const inputPlaceholder = mode === 'vfs' ? '/workspace' : './src';
  const inputLabel = mode === 'vfs' ? 'Virtual path' : 'Real path (relative to runtime cwd)';

  return (
    <div className="space-y-4">
      {/* Path bar — Input + Go / Up / Root / Refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          placeholder={inputPlaceholder}
          aria-label={inputLabel}
          className="h-11 min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="button" size="sm" className="h-11 px-4" onClick={go} disabled={loading}>
          Go
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 px-3"
          onClick={goUp}
          disabled={loading || parentOf(mode, path) === null}
          aria-label="Parent directory"
          title="Parent directory"
        >
          <CornerLeftUp className="size-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 px-3"
          onClick={goRoot}
          disabled={loading}
          aria-label="Root directory"
          title="Root directory"
        >
          <FolderTree className="size-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 px-3"
          onClick={() => void list(path)}
          disabled={loading}
          aria-label="Refresh listing"
          title="Refresh"
        >
          {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
        </Button>
      </div>

      {/* Confined-to-cwd notice (Real FS only) */}
      {mode === 'real' ? (
        <Alert className="border-white/[0.09] bg-white/[0.03]">
          <ShieldCheck className="size-4 text-emerald-300" aria-hidden />
          <AlertTitle>Read-only · confined to the runtime working directory</AlertTitle>
          <AlertDescription>
            The Real FS tab can only look inside the directory the NexTool runtime runs in
            (process.cwd(), shown as <span className="font-mono text-[11px]">.</span>). Paths that resolve
            outside it — including symlinks — are rejected with <span className="font-mono text-[11px]">FS_ACCESS</span>.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Error — destructive alert with the honest API code */}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Inspection failed</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs">{error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 min-h-11"
              onClick={() => void list(path)}
            >
              <RefreshCw className="size-3.5" aria-hidden /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Listing */}
      <ScrollArea className="glass-card max-h-96 rounded-lg border border-white/[0.06]">
        <Table>
          <TableHeader>
            <TableRow className="border-white/[0.06] hover:bg-transparent">
              <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">name</TableHead>
              <TableHead className="w-20 text-[10px] uppercase tracking-wider text-muted-foreground">kind</TableHead>
              <TableHead className="w-24 text-right text-[10px] uppercase tracking-wider text-muted-foreground">size</TableHead>
              <TableHead className="w-44 text-right text-[10px] uppercase tracking-wider text-muted-foreground">updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries === null && !loading ? (
              <TableRow className="border-white/[0.06]">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                  Nothing loaded — press Go to inspect a path.
                </TableCell>
              </TableRow>
            ) : null}
            {loading ? (
              <TableRow className="border-white/[0.06]">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden /> loading {path || '/'}…
                  </span>
                </TableCell>
              </TableRow>
            ) : null}
            {entries !== null && !loading && entries.length === 0 ? (
              <TableRow className="border-white/[0.06]">
                <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                  Empty directory
                </TableCell>
              </TableRow>
            ) : null}
            {entries !== null && !loading
              ? entries.map((entry) => {
                  const clickable = entry.kind === 'dir' || entry.kind === 'file';
                  return (
                    <TableRow
                      key={entry.name}
                      className={cn('border-white/[0.06]', clickable && 'cursor-pointer')}
                      onClick={() => {
                        if (entry.kind === 'dir') openDir(entry);
                        else if (entry.kind === 'file') void openFile(entry);
                      }}
                    >
                      <TableCell className="max-w-[280px] py-2">
                        <span className="flex min-w-0 items-center gap-2">
                          {entry.kind === 'dir' ? (
                            <Folder className="size-3.5 shrink-0 text-emerald-300/80" aria-hidden />
                          ) : entry.kind === 'link' ? (
                            <Link2 className="size-3.5 shrink-0 text-amber-300/80" aria-hidden />
                          ) : (
                            <FileIcon className="size-3.5 shrink-0 text-slate-300/80" aria-hidden />
                          )}
                          <span
                            className={cn(
                              'truncate font-mono text-xs',
                              clickable ? 'text-foreground/90' : 'text-muted-foreground',
                            )}
                          >
                            {entry.name}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge variant="outline" className={cn('font-mono text-[11px]', kindBadgeClass(entry.kind))}>
                          {entry.kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                        {humanBytes(entry.size)}
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-[11px] text-muted-foreground">
                        {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })
              : null}
          </TableBody>
        </Table>
      </ScrollArea>

      {/* File preview */}
      {previewLoading ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          <Loader2 className="mr-1.5 inline size-3 animate-spin" aria-hidden /> loading preview…
        </p>
      ) : null}
      {preview && !previewLoading ? (
        <Card className="glass-card border-white/[0.08]">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <FileIcon className="size-4 shrink-0 text-slate-300" aria-hidden />
              <span className="min-w-0 break-all font-mono text-xs text-foreground/90">{preview.path}</span>
              <Badge variant="outline" className="border-white/[0.09] bg-white/[0.03] font-mono text-[11px] text-muted-foreground">
                {humanBytes(preview.size)}
              </Badge>
              {preview.truncated ? (
                <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[11px] text-amber-300">
                  truncated · first 64 KiB
                </Badge>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-11 px-3 text-muted-foreground"
                onClick={() => setPreview(null)}
                aria-label="Close preview"
              >
                Close
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-96">
              <pre className="nextool-scroll text-xs font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                {preview.content}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------- the view ----------

export default function InspectorView() {
  const [usage, setUsage] = useState<VfsUsage | null>(null);

  return (
    <div className="space-y-4">
      <SectionTitle
        icon={<FolderTree className="size-4 text-sky-300" aria-hidden />}
        title="FS Inspector"
        desc="v1.0.13 single-user operator console — read-only inspection of the shared Virtual FS and the real host filesystem (confined to the runtime working directory)."
      />

      {/* VFS usage snapshot (refreshed with every Virtual FS listing) */}
      <div className="glass-card flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-4 py-2.5">
        <span className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-sky-300/80">
          <HardDrive className="size-3.5" aria-hidden /> shared VFS usage
        </span>
        <span className="font-mono text-xs text-foreground/90">{usage ? humanBytes(usage.usedBytes) : '—'}</span>
        <span className="font-mono text-xs text-muted-foreground">{usage ? `${usage.files} files` : '—'}</span>
        <span className="font-mono text-xs text-muted-foreground">
          cap {usage ? humanBytes(usage.limits.maxTotalBytes) : '—'} (maxTotalBytes)
        </span>
      </div>

      <Tabs defaultValue="vfs" className="gap-4">
        <TabsList>
          <TabsTrigger value="vfs">Virtual FS</TabsTrigger>
          <TabsTrigger value="real">Real FS</TabsTrigger>
        </TabsList>
        <TabsContent value="vfs">
          <FsBrowser mode="vfs" onUsage={setUsage} />
        </TabsContent>
        <TabsContent value="real">
          <FsBrowser mode="real" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
