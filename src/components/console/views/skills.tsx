'use client';

/**
 * Skills (v1.0.16 §10.4) — management UI for the portable SKILL.md system.
 *
 *   view installed skills (metadata) · open details (SKILL.md + resources) ·
 *   create · edit · import ZIP · export ZIP · enable/disable · validate
 *   frontmatter (useful errors) · reload/discover changes
 *
 * A skill TEACHES a workflow; a TOOL performs an operation. The UI keeps that
 * distinction visible. Single-user, self-hosted operator surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/nexool/client';
import { EmptyState, ErrorCard, SectionTitle, TimeAgo } from '../ui-bits';
import { BookMarked, Download, FileWarning, FolderInput, Loader2, Plus, RefreshCw, Save, ScrollText, Sparkles, Trash2 } from 'lucide-react';

interface SkillEntry {
  name: string;
  description: string;
  enabled: boolean;
  builtIn: boolean;
  hasReferences: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
  modifiedAt: string;
  valid?: boolean;
}

interface SkillDetailResponse extends SkillEntry {
  content: string;
  frontmatterError?: string;
  resources: string[];
}

export default function SkillsView() {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // detail drawer
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newBody, setNewBody] = useState('');
  const [creating, setCreating] = useState(false);

  // import
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ skills: SkillEntry[] }>('/api/skills');
      setSkills(res.skills);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skills');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (name: string) => {
    setDetailLoading(true);
    try {
      const res = await apiFetch<SkillDetailResponse>(`/api/skills/${encodeURIComponent(name)}`);
      setDetail(res);
      setEditContent(res.content);
    } catch (e) {
      toast.error('Cannot open skill', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleEnabled = async (name: string, enabled: boolean) => {
    setSkills((prev) => (prev ?? []).map((s) => (s.name === name ? { ...s, enabled } : s)));
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      toast.success(enabled ? 'Skill enabled' : 'Skill disabled', { description: `${name} — disabled skills are never selected for tasks.` });
    } catch (e) {
      toast.error('Toggle failed', { description: e instanceof Error ? e.message : String(e) });
      void load();
    }
  };

  const saveContent = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await apiFetch<SkillDetailResponse>(`/api/skills/${encodeURIComponent(detail.name)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      });
      setDetail(res);
      toast.success('SKILL.md saved', { description: 'The registry re-scanned the skill — changes are live.' });
      void load();
    } catch (e) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const createSkill = async () => {
    setCreating(true);
    try {
      const created = await apiFetch<{ created: string }>('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', name: newName.trim().toLowerCase(), description: newDescription.trim(), body: newBody }),
      });
      toast.success('Skill created', { description: `${created.created}/SKILL.md is now discoverable.` });
      setCreateOpen(false);
      setNewName('');
      setNewDescription('');
      setNewBody('');
      void load();
      void openDetail(created.created);
    } catch (e) {
      toast.error('Create failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setCreating(false);
    }
  };

  const importZip = async (file: File) => {
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/skills/import', { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { imported?: string }; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `Import failed (HTTP ${res.status})`);
      toast.success('Skill imported', { description: body.data?.imported ?? 'installed' });
      void load();
    } catch (e) {
      toast.error('Import failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const exportSkill = (name: string) => {
    window.location.href = `/api/skills/${encodeURIComponent(name)}/export`;
  };

  const removeSkill = async (name: string) => {
    if (!window.confirm(`Delete skill "${name}" and its folder? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast.success('Skill deleted', { description: `${name} removed from the registry.` });
      if (detail?.name === name) setDetail(null);
      void load();
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ count: number }>('/api/skills', { method: 'POST', body: JSON.stringify({ action: 'reload' }) });
      toast.success('Registry reloaded', { description: `${res.count} skill(s) discovered — the skills.md catalog was refreshed.` });
      void load();
    } catch (e) {
      toast.error('Reload failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <Sparkles className="size-4 text-sky-300" aria-hidden />
            Skills
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Portable <span className="font-mono">SKILL.md</span> workflows (v1.0.16). A skill <span className="text-foreground">teaches</span> how to perform a
            workflow; tools still <span className="text-foreground">perform</span> every operation. Discovery loads metadata only — full instructions are
            injected only when a skill is selected for a task, and imported content is treated as untrusted (it can never bypass approvals or environment boundaries).
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:shrink-0">
          <Button size="sm" variant="outline" className="min-h-11 gap-1.5 px-4 sm:min-h-9 sm:w-auto" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" aria-hidden /> New skill
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 gap-1.5 px-4 sm:min-h-9 sm:w-auto"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FolderInput className="size-3.5" aria-hidden />} Import ZIP
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            className="hidden"
            aria-label="Import skill ZIP"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importZip(f);
            }}
          />
          <Button size="sm" variant="ghost" className="min-h-11 gap-1.5 px-4 text-muted-foreground sm:min-h-9 sm:w-auto" onClick={() => void reload()} disabled={busy}>
            <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} aria-hidden /> Reload
          </Button>
        </div>
      </div>

      {error ? <ErrorCard title="Skills registry unavailable" message={error} /> : null}

      {skills === null && !error ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : null}

      {skills !== null && skills.length === 0 ? (
        <EmptyState
          title="No skills installed"
          hint="Create a skill or import a SKILL.md folder ZIP — discovered skills are selectable for tasks automatically."
        />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(skills ?? []).map((s) => (
          <div key={s.name} className="glass-card flex flex-col rounded-lg p-4">
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                onClick={() => void openDetail(s.name)}
                className="min-h-9 text-left font-mono text-xs font-semibold text-foreground hover:text-sky-300"
              >
                {s.name}
              </button>
              <Switch
                checked={s.enabled}
                onCheckedChange={(v) => void toggleEnabled(s.name, v)}
                aria-label={`Toggle skill ${s.name}`}
              />
            </div>
            <p className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">{s.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {s.builtIn ? <Badge variant="outline" className="border-sky-400/30 px-1.5 py-0 text-[9px] text-sky-300">built-in</Badge> : null}
              {s.valid === false ? <Badge variant="outline" className="border-rose-400/30 px-1.5 py-0 text-[9px] text-rose-300">invalid frontmatter</Badge> : null}
              {s.hasReferences ? <Badge variant="outline" className="border-white/[0.09] px-1.5 py-0 font-mono text-[9px] text-muted-foreground">references/</Badge> : null}
              {s.hasScripts ? <Badge variant="outline" className="border-amber-400/30 px-1.5 py-0 font-mono text-[9px] text-amber-300">scripts/ (never auto-run)</Badge> : null}
              {!s.enabled ? <Badge variant="outline" className="border-rose-400/30 px-1.5 py-0 text-[9px] text-rose-300">disabled</Badge> : null}
              <span className="ml-auto font-mono text-[9px] text-muted-foreground"><TimeAgo iso={s.modifiedAt} /></span>
            </div>
            <div className="mt-3 flex gap-1.5">
              <Button type="button" size="sm" variant="outline" className="min-h-8 gap-1 px-2 text-[11px]" onClick={() => void openDetail(s.name)}>
                <ScrollText className="size-3" aria-hidden /> Open
              </Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-8 gap-1 px-2 text-[11px] text-muted-foreground" onClick={() => exportSkill(s.name)}>
                <Download className="size-3" aria-hidden /> Export
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto min-h-8 gap-1 px-2 text-[11px] text-rose-300 hover:bg-rose-500/10"
                onClick={() => void removeSkill(s.name)}
                disabled={busy}
                aria-label={`Delete skill ${s.name}`}
              >
                <Trash2 className="size-3" aria-hidden />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* detail / editor dialog */}
      <Dialog open={detail !== null || detailLoading} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="glass-strong max-h-[88dvh] overflow-hidden md:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              <BookMarked className="size-4 text-sky-300" aria-hidden />
              {detailLoading ? 'loading…' : detail?.name}
              {detail?.builtIn ? <Badge variant="outline" className="border-sky-400/30 px-1.5 py-0 text-[9px] text-sky-300">built-in</Badge> : null}
            </DialogTitle>
            <DialogDescription className="line-clamp-2">
              {detail?.description ?? 'Full SKILL.md — edit and save to refresh the registry.'}
            </DialogDescription>
          </DialogHeader>

          {detail?.frontmatterError ? (
            <div role="alert" className="rounded-md border border-rose-400/30 bg-rose-400/[0.06] p-3">
              <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-rose-300">
                <FileWarning className="size-3.5" aria-hidden /> invalid frontmatter
              </p>
              <p className="mt-1 font-mono text-[11px] text-rose-200">{detail.frontmatterError}</p>
            </div>
          ) : null}

          {detail && detail.resources.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {detail.resources.map((r) => (
                <Badge key={r} variant="outline" className="border-white/[0.09] px-1.5 py-0 font-mono text-[9px] text-muted-foreground">
                  {detail.name}/{r}
                </Badge>
              ))}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <Label htmlFor="skill-content" className="font-tech text-[9px] uppercase tracking-widest text-muted-foreground">SKILL.md</Label>
            <Textarea
              id="skill-content"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="nextool-scroll mt-1.5 min-h-[40vh] w-full resize-none border-white/[0.09] bg-white/[0.03] font-mono text-[11px] leading-relaxed"
              spellCheck={false}
            />
          </div>

          <DialogFooter className="gap-2">
            <p className="mr-auto text-[10px] text-muted-foreground">
              {detail ? <>last modified <TimeAgo iso={detail.modifiedAt} /></> : ''}
            </p>
            <Button size="sm" variant="outline" className="min-h-9" onClick={() => setDetail(null)}>Close</Button>
            <Button size="sm" className="min-h-9 gap-1.5 bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => void saveContent()} disabled={saving || !detail}>
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="glass-strong max-h-[88dvh] overflow-y-auto md:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Plus className="size-4 text-sky-300" aria-hidden /> New skill
            </DialogTitle>
            <DialogDescription>
              Creates <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> with validated frontmatter (name + description).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="skill-name">Name (lowercase, hyphens)</Label>
              <Input id="skill-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="release-notes" className="mt-1 font-mono text-xs" />
            </div>
            <div>
              <Label htmlFor="skill-desc">Description (12-500 chars — this is what CoreModule/Planner sees during selection)</Label>
              <Textarea
                id="skill-desc"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Write release notes from the changelog, recent commits and task results."
                className="mt-1 min-h-16 text-xs"
              />
            </div>
            <div>
              <Label htmlFor="skill-body">SKILL.md body (workflow instructions)</Label>
              <Textarea
                id="skill-body"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder={'# Release Notes\n\n1. Read CHANGELOG.md…\n2. …'}
                className="nextool-scroll mt-1 min-h-40 font-mono text-[11px]"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" className="min-h-9" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="min-h-9 bg-primary-gradient text-primary-foreground hover:opacity-90"
              onClick={() => void createSkill()}
              disabled={creating || newName.trim().length < 3 || newDescription.trim().length < 12}
            >
              {creating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null} Create skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SectionTitle
        icon={<BookMarked className="size-4 text-sky-300" aria-hidden />}
        title="skills.md catalog"
        desc="The root skills/skills.md catalog (system + installed skills index) is regenerated on every registry change — distinct from each skill's own SKILL.md entrypoint."
      />
    </div>
  );
}
