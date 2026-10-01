'use client';

/**
 * Memory (spec §57) — TWO distinct sections: Persistent Memory (durable
 * key/value store) and Live State (ephemeral runtime snapshot, linked view).
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError, addMemory, deleteMemory, getLiveState, listMemory } from '@/lib/nexool/client';
import type { GlobalLiveState } from '@/lib/nexool/types';
import type { MemoryEntryDTO } from '@/lib/nexool/api-contract';
import { ServerCard } from '../server-card';
import { useConsoleStore } from '../console-store';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, TimeAgo } from '../ui-bits';
import { ArrowUpRight, Database, Loader2, Plus, ScanEye, Trash2 } from 'lucide-react';

function MemoryRow({ entry, onDelete, deleting }: { entry: MemoryEntryDTO; onDelete: (key: string) => void; deleting: boolean }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-card/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-zinc-100">{entry.key}</span>
        <Badge variant="outline" className="border-zinc-700 font-mono text-[10px] text-zinc-400">{entry.source}</Badge>
        <TimeAgo iso={entry.updatedAt} className="font-mono text-[10px] text-zinc-500" />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"
          disabled={deleting}
          onClick={() => onDelete(entry.key)}
          aria-label={`Delete memory entry ${entry.key}`}
        >
          {deleting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
        </Button>
      </div>
      <div className="mt-2">
        <JsonBlock value={entry.value} maxHeight="max-h-32" />
      </div>
      {entry.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {entry.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="border-emerald-500/30 font-mono text-[10px] text-emerald-300/80">{tag}</Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function MemoryView() {
  const setActiveView = useConsoleStore((s) => s.setActiveView);

  const [entries, setEntries] = useState<MemoryEntryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ key: '', value: '{}', tags: '' });

  const [liveState, setLiveState] = useState<GlobalLiveState | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listMemory();
      setEntries(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Memory store unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      getLiveState()
        .then((d) => alive && setLiveState(d))
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const submitAdd = async () => {
    if (!form.key.trim()) {
      toast.error('Key required');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(form.value);
    } catch {
      toast.error('Value is not valid JSON');
      return;
    }
    setBusy(true);
    try {
      await addMemory({
        key: form.key.trim(),
        value,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      toast.success('Memory entry saved', { description: form.key.trim() });
      setAddOpen(false);
      setForm({ key: '', value: '{}', tags: '' });
      void load();
    } catch (e) {
      toast.error('Save failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteKey) return;
    setBusy(true);
    try {
      await deleteMemory(deleteKey);
      toast.success('Entry deleted', { description: deleteKey });
      setDeleteKey(null);
      void load();
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<Database className="size-4 text-emerald-400" aria-hidden />}
        title="Memory"
        desc="Persistent memory is durable across tasks. Live state is ephemeral and resets with the runtime."
      />

      {/* ---------- Section 1: Persistent Memory ---------- */}
      <section aria-label="Persistent memory" className="rounded-lg border bg-card p-4 md:p-6">
        <SectionTitle
          icon={<Database className="size-4 text-emerald-400" aria-hidden />}
          title="Persistent Memory"
          desc="Durable key/value store the runtime reads and writes across tasks."
          right={
            <Button size="sm" className="min-h-9 gap-1.5 bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400" onClick={() => setAddOpen(true)}>
              <Plus className="size-3.5" aria-hidden /> Add entry
            </Button>
          }
        />
        <div className="mt-4">
          {error && entries === null ? (
            <ErrorCard title="Memory store unavailable" message={error} onRetry={load} />
          ) : entries === null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<Database className="size-6" aria-hidden />}
              title="No memory entries yet"
              hint="The runtime stores learned facts here (useMemory enabled), or add one manually."
            />
          ) : (
            <div className="nextool-scroll max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {entries.map((entry) => (
                <MemoryRow key={entry.id} entry={entry} onDelete={setDeleteKey} deleting={false} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ---------- Section 2: Live State ---------- */}
      <section aria-label="Live state" className="rounded-lg border border-amber-500/20 bg-card p-4 md:p-6">
        <SectionTitle
          icon={<ScanEye className="size-4 text-amber-400" aria-hidden />}
          title="Live State"
          desc="Ephemeral working state (server fleet, counters). NOT persistent memory — it resets when the runtime restarts."
          right={
            <Button variant="outline" size="sm" className="min-h-9 gap-1.5 border-amber-500/30 text-amber-300 hover:bg-amber-500/10" onClick={() => setActiveView('live-state')}>
              Open Live State view <ArrowUpRight className="size-3.5" aria-hidden />
            </Button>
          }
        />
        <div className="mt-4">
          {liveState === null ? (
            <p className="text-xs text-muted-foreground">Live state unavailable — the runtime has not reported yet.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {liveState.servers.map((server) => (
                <ServerCard key={server.id} server={server} compact />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="border-zinc-800 bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add memory entry</DialogTitle>
            <DialogDescription>Writes directly to persistent memory with source <code className="font-mono">console</code>.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mem-key">Key</Label>
              <Input id="mem-key" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="preferred.server" className="font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-value">Value (JSON)</Label>
              <Textarea id="mem-value" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} rows={4} className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mem-tags">Tags <span className="text-muted-foreground">(comma separated)</span></Label>
              <Input id="mem-tags" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} placeholder="ops, preference" className="text-sm" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="min-h-10 bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400" disabled={busy} onClick={() => void submitAdd()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />} Save entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteKey !== null} onOpenChange={(open) => !open && setDeleteKey(null)}>
        <DialogContent className="border-zinc-800 bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-rose-300">Delete memory entry?</DialogTitle>
            <DialogDescription>
              <code className="font-mono">{deleteKey}</code> will be removed from persistent memory. Tasks will no longer recall it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setDeleteKey(null)}>Cancel</Button>
            <Button variant="destructive" className="min-h-10" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
