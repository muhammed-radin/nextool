'use client';

/**
 * NexTool Q1 v1.0.1 console shell — single-page app. The ONLY visible route is
 * `/`; all screens are client-side views switched by `useConsoleStore.activeView`.
 *
 * v1.0.1: blue gradient Glassmorphism, Readex Pro + Michroma typography,
 * mobile-first responsive shell (bottom nav Dashboard/Tasks/Live/Tools/More on
 * <md, glass sidebar on ≥md), real runtime connection indicator.
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Toaster } from '@/components/ui/sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { APP_NAME, APP_VERSION } from '@/lib/nexool/version';
import { getTool, ApiClientError } from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import { useConsoleStore, shortId, type ConsoleView } from './console-store';
import { BrandLogo } from './brand-logo';
import { RuntimeConnectionStatus } from './runtime-connection-status';
import { GlobalStreamProvider, NotificationsProvider, SystemStatsProvider, useGlobalStream, useNotifications, useSystemStats } from './providers';
import { fmtUptime, statusTone } from './ui-bits';
import DashboardView from './views/dashboard';
import TaskConsoleView from './views/task-console';
import TaskPreviewView from './views/task-preview';
import LiveMonitorView from './views/live-monitor';
import ToolsView from './views/tools';
import ToolEditorView from './views/tool-editor';
import ConnectorsView from './views/connectors';
import TrainingView from './views/training';
import BenchmarkView from './views/benchmark';
import MemoryView from './views/memory';
import LiveStateView from './views/live-state';
import EventsView from './views/events';
import HistoryView from './views/history';
import InspectorView from './views/inspector';
import ModelsView from './views/models';
import DatasetsView from './views/datasets';
import SettingsView from './views/settings';
import LimitationsView from './views/limitations';
import AssistantView from './views/assistant';
import DocsView from './views/docs';
import {
  Activity,
  Bell,
  BookOpen,
  Bot,
  Box,
  Cable,
  Database,
  FileJson,
  FlaskConical,
  FolderTree,
  Gauge,
  GraduationCap,
  History,
  LayoutDashboard,
  ListFilter,
  Menu,
  MoreHorizontal,
  RadioTower,
  SlidersHorizontal,
  TerminalSquare,
  Wrench,
} from 'lucide-react';

const NAV_ITEMS: { view: ConsoleView; label: string; icon: typeof Wrench }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'task-console', label: 'Task Console', icon: TerminalSquare },
  { view: 'live-monitor', label: 'Live Monitor', icon: RadioTower },
  { view: 'tools', label: 'Tools', icon: Wrench },
  { view: 'connectors', label: 'Connectors', icon: Cable },
  { view: 'training', label: 'Training', icon: GraduationCap },
  { view: 'benchmark', label: 'Benchmark', icon: FlaskConical },
  { view: 'memory', label: 'Memory', icon: Database },
  { view: 'live-state', label: 'Live State', icon: Activity },
  { view: 'inspector', label: 'FS Inspector', icon: FolderTree },
  { view: 'events', label: 'Events', icon: ListFilter },
  { view: 'history', label: 'History', icon: History },
  { view: 'models', label: 'Models', icon: Box },
  { view: 'datasets', label: 'Datasets', icon: FileJson },
  { view: 'docs', label: 'Documentation', icon: BookOpen },
  { view: 'limitations', label: 'Limitations', icon: Gauge },
  { view: 'settings', label: 'Settings', icon: SlidersHorizontal },
  { view: 'assistant', label: 'Assistant', icon: Bot },
];

/** Mobile bottom-nav primary destinations (everything else lives in "More"). */
const MOBILE_PRIMARY: { view: ConsoleView; label: string; icon: typeof Wrench }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'task-console', label: 'Tasks', icon: TerminalSquare },
  { view: 'live-monitor', label: 'Live', icon: RadioTower },
  { view: 'tools', label: 'Tools', icon: Wrench },
];

function NavLink({ view, label, icon: Icon, onNavigate }: { view: ConsoleView; label: string; icon: typeof Wrench; onNavigate?: () => void }) {
  const activeView = useConsoleStore((s) => s.activeView);
  const setActiveView = useConsoleStore((s) => s.setActiveView);
  const active = activeView === view;
  return (
    <button
      type="button"
      onClick={() => {
        setActiveView(view);
        onNavigate?.();
      }}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-ring/50 focus-visible:ring-2',
        active
          ? 'bg-primary-gradient-soft font-medium text-sky-100 ring-1 ring-sky-400/25'
          : 'text-slate-300/85 hover:bg-white/[0.05] hover:text-foreground',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-sky-300' : 'text-slate-400')} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

function TaskPreviewNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const selectedTaskId = useConsoleStore((s) => s.selectedTaskId);
  const setActiveView = useConsoleStore((s) => s.setActiveView);
  const activeView = useConsoleStore((s) => s.activeView);
  if (!selectedTaskId) return null;
  const active = activeView === 'task-preview';
  return (
    <>
      <div className="mx-3 my-1">
        <Separator className="bg-white/[0.08]" />
      </div>
      <button
        type="button"
        onClick={() => {
          setActiveView('task-preview');
          onNavigate?.();
        }}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'mx-3 flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors outline-ring/50 focus-visible:ring-2',
          active
            ? 'bg-primary-gradient-soft font-medium text-sky-100 ring-1 ring-sky-400/25'
            : 'text-slate-300/85 hover:bg-white/[0.05] hover:text-foreground',
        )}
      >
        <TerminalSquare className="size-4 shrink-0 text-sky-300/80" aria-hidden />
        <span className="truncate">
          Task Preview <span className="font-mono text-xs text-slate-400">#{shortId(selectedTaskId)}</span>
        </span>
      </button>
    </>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Console sections" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.view} {...item} onNavigate={onNavigate} />
      ))}
      <TaskPreviewNavLink onNavigate={onNavigate} />
    </nav>
  );
}

/**
 * v1.0.4 §1 — the product identity mark is the REAL NexTool logo (from the
 * active icon package). Functional nav icons (Wrench etc.) are untouched —
 * only the brand tile changed.
 */
function LogoMark({ className }: { className?: string }) {
  return <BrandLogo className={className} />;
}

function BrandButton() {
  return (
    <button
      type="button"
      onClick={() => useConsoleStore.getState().setActiveView('dashboard')}
      className="flex items-center gap-2.5 rounded-md px-1 py-1 outline-ring/50 focus-visible:ring-2"
      aria-label="Go to dashboard"
    >
      <LogoMark />
      <span className="text-sm font-semibold tracking-tight text-foreground">{APP_NAME.replace(' Q1', '')}</span>
      {/* v1.0.3 §28: hidden below sm so the 320px header never overflows —
          version stays visible in the mobile More sheet + Settings → About. */}
      <Badge variant="outline" className="font-tech hidden border-sky-400/30 bg-sky-400/10 text-[9px] uppercase tracking-wider text-sky-300 sm:inline-flex">
        Q1 v{APP_VERSION}
      </Badge>
    </button>
  );
}

function NotificationBell() {
  const { notifications, unread, markAllRead, loading } = useNotifications();
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-9 text-slate-300 hover:bg-white/[0.06] hover:text-foreground" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell className="size-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary-gradient px-1 font-mono text-[10px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="glass-strong w-80 p-0">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-2">
          <span className="font-tech text-[10px] uppercase tracking-widest text-sky-300/80">Notifications</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-sky-300 hover:text-sky-200" onClick={() => void markAllRead()} disabled={loading || unread === 0}>
            Mark all read
          </Button>
        </div>
        <div className="nextool-scroll max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">{loading ? 'Loading…' : 'No notifications yet.'}</p>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                disabled={!n.taskId}
                onClick={() => n.taskId && openTaskPreview(n.taskId)}
                className={cn('flex w-full flex-col items-start gap-0.5 border-b border-white/[0.06] px-3 py-2.5 text-left hover:bg-white/[0.05]', !n.read && 'bg-sky-400/[0.07]')}
              >
                <span className="flex w-full items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      n.level === 'critical' ? 'bg-rose-400' : n.level === 'warning' ? 'bg-amber-400' : 'bg-slate-400',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/95">{n.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-400">{new Date(n.createdAt).toLocaleTimeString('en-GB', { hour12: false })}</span>
                </span>
                <span className="line-clamp-2 pl-3.5 text-[11px] text-muted-foreground">{n.body}</span>
              </button>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusBar() {
  const { stats } = useSystemStats();
  const { status } = useGlobalStream();
  const [clock, setClock] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString('en-GB', { hour12: false }));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);

  const runtimeStatus = stats?.runtimeStatus ?? (status === 'error' || status === 'disconnected' ? 'offline' : 'connecting');
  const tone = statusTone(runtimeStatus);

  return (
    <footer className="glass-shell mt-auto hidden border-t border-white/[0.07] md:block">
      <div className="mx-auto flex h-9 w-full max-w-[1600px] items-center justify-between gap-3 px-4 font-mono text-[11px] text-slate-400">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-tech text-[9px] uppercase tracking-widest text-sky-300/70">Runtime</span>
          <span
            aria-label={`Runtime ${runtimeStatus}`}
            className={cn('inline-flex items-center gap-1.5', tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-rose-300')}
          >
            <span className={cn('size-1.5 rounded-full', tone === 'ok' ? 'animate-pulse bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : 'bg-rose-400')} aria-hidden />
            {stats ? runtimeStatus : 'offline'}
          </span>
        </div>
        <div className="hidden min-w-0 items-center gap-3 truncate lg:flex">
          <span>active {stats ? stats.tasks.active : '—'}</span>
          <span>live {stats ? stats.tasks.live : '—'}</span>
          <span>engine {stats ? stats.engine.active : '—'}</span>
          <span>up {stats ? fmtUptime(stats.runtimeUptimeSec) : '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn('size-1.5 rounded-full', status === 'connected' ? 'animate-pulse bg-emerald-400' : status === 'error' ? 'bg-rose-400' : status === 'reconnecting' ? 'bg-amber-400' : 'bg-sky-400')} />
          <span>stream: {status}</span>
          <span aria-hidden className="text-slate-600">│</span>
          <span className="font-tech text-[9px] tracking-wider text-sky-300/70">v{APP_VERSION}</span>
          <span aria-hidden className="text-slate-600">│</span>
          <span className="tabular-nums">{clock ?? '--:--:--'}</span>
        </div>
      </div>
    </footer>
  );
}

/** Mobile bottom navigation — primary destinations + "More" sheet. */
function MobileBottomNav() {
  const activeView = useConsoleStore((s) => s.activeView);
  const setActiveView = useConsoleStore((s) => s.setActiveView);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = !MOBILE_PRIMARY.some((i) => i.view === activeView) && activeView !== 'task-preview';

  return (
    <nav
      aria-label="Primary"
      className="glass-shell fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] pb-safe md:hidden"
    >
      <div className="mx-auto grid h-15 max-w-lg grid-cols-5">
        {MOBILE_PRIMARY.map(({ view, label, icon: Icon }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              type="button"
              onClick={() => setActiveView(view)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex min-h-[3.75rem] flex-col items-center justify-center gap-1 px-1 text-[10px] transition-colors outline-ring/50 focus-visible:ring-2',
                active ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {active && <span aria-hidden className="bg-primary-gradient absolute top-0 h-0.5 w-8 rounded-full" />}
              <Icon className="size-5" aria-hidden />
              <span className={cn(active && 'font-medium')}>{label}</span>
            </button>
          );
        })}
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label="More sections"
              aria-expanded={moreOpen}
              className={cn(
                'relative flex min-h-[3.75rem] flex-col items-center justify-center gap-1 px-1 text-[10px] transition-colors outline-ring/50 focus-visible:ring-2',
                moreActive ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {moreActive && <span aria-hidden className="bg-primary-gradient absolute top-0 h-0.5 w-8 rounded-full" />}
              <MoreHorizontal className="size-5" aria-hidden />
              <span>More</span>
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="glass-strong h-[70dvh] rounded-t-2xl border-white/[0.1] p-0">
            <SheetHeader className="border-b border-white/[0.08] px-4 py-3">
              <SheetTitle className="flex items-center gap-2 text-sm text-foreground">
                <LogoMark className="size-6" />
                All sections
              </SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground">
                {APP_NAME} v{APP_VERSION} — every console screen stays reachable on mobile.
              </SheetDescription>
            </SheetHeader>
            <div className="nextool-scroll h-[calc(70dvh-5rem)] overflow-y-auto p-3">
              <div className="grid grid-cols-2 gap-2">
                {NAV_ITEMS.filter((i) => !MOBILE_PRIMARY.some((p) => p.view === i.view)).map(({ view, label, icon: Icon }) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => {
                      setActiveView(view);
                      setMoreOpen(false);
                    }}
                    aria-current={activeView === view ? 'page' : undefined}
                    className={cn(
                      'flex min-h-12 items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-ring/50 focus-visible:ring-2',
                      activeView === view
                        ? 'border-sky-400/30 bg-primary-gradient-soft text-sky-100'
                        : 'border-white/[0.07] bg-white/[0.03] text-slate-200 hover:bg-white/[0.06]',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', activeView === view ? 'text-sky-300' : 'text-slate-400')} aria-hidden />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
              </div>
              <TaskPreviewNavLinkMobile onNavigate={() => setMoreOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </nav>
  );
}

function TaskPreviewNavLinkMobile({ onNavigate }: { onNavigate?: () => void }) {
  const selectedTaskId = useConsoleStore((s) => s.selectedTaskId);
  const setActiveView = useConsoleStore((s) => s.setActiveView);
  const activeView = useConsoleStore((s) => s.activeView);
  if (!selectedTaskId) return null;
  return (
    <button
      type="button"
      onClick={() => {
        setActiveView('task-preview');
        onNavigate?.();
      }}
      className={cn(
        'mt-2 flex min-h-12 w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm',
        activeView === 'task-preview'
          ? 'border-sky-400/30 bg-primary-gradient-soft text-sky-100'
          : 'border-white/[0.07] bg-white/[0.03] text-slate-200 hover:bg-white/[0.06]',
      )}
    >
      <TerminalSquare className="size-4 shrink-0 text-sky-300/80" aria-hidden />
      <span className="truncate">
        Task Preview <span className="font-mono text-xs text-slate-400">#{shortId(selectedTaskId)}</span>
      </span>
    </button>
  );
}

function ToolEditorRoute() {
  const toolEditor = useConsoleStore((s) => s.toolEditor);
  const closeToolEditor = useConsoleStore((s) => s.closeToolEditor);
  // The parent remounts this route per editor session (key=toolEditorKey), so
  // the prefill state can be initialized lazily without effect-time setState.
  const [state, setState] = useState<{ entry: ToolEntry | null; error: string | null }>(() => ({
    entry: toolEditor && toolEditor.mode !== 'edit' ? toolEditor.source ?? null : null,
    error: null,
  }));
  const { entry, error } = state;

  useEffect(() => {
    if (!toolEditor || toolEditor.mode !== 'edit' || !toolEditor.name) return;
    let alive = true;
    getTool(toolEditor.name)
      .then((d) => {
        if (alive) setState({ entry: d, error: null });
      })
      .catch((e) => {
        if (alive) setState({ entry: null, error: e instanceof ApiClientError ? e.message : 'Tool not found' });
      });
    return () => {
      alive = false;
    };
  }, [toolEditor]);

  if (!toolEditor) return null;

  const loading = toolEditor.mode === 'edit' && entry === null && error === null;

  if (error) {
    return (
      <div className="space-y-4">
        <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/5 p-4 text-sm text-rose-300">{error}</p>
        <Button variant="outline" size="sm" onClick={closeToolEditor}>← Back to tools</Button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="glass-panel flex h-16 w-full items-center gap-3 rounded-lg px-4">
          <BrandLogo className="size-8" />
          <div className="min-w-0">
            <div className="h-4 w-40 animate-pulse rounded bg-white/[0.08]" />
            <div className="mt-1.5 h-3 w-56 animate-pulse rounded bg-white/[0.05]" />
          </div>
          <span className="ml-auto font-tech text-[9px] uppercase tracking-widest text-sky-300/70">loading tool…</span>
        </div>
        <div className="h-96 w-full animate-pulse rounded-lg bg-white/[0.05]" />
      </div>
    );
  }

  const initial = toolEditor.mode === 'edit'
    ? entry
    : entry
      ? {
          ...entry,
          name: entry.name.includes('.') ? `${entry.name.split('.')[0]}.copy` : `${entry.name}.copy`,
          toolVersion: '1.0.0',
          stats: { callCount: 0, successCount: 0, failureCount: 0, timeoutCount: 0, avgMs: 0, enabled: true },
        }
      : null;

  return (
    <ToolEditorView
      toolName={toolEditor.mode === 'edit' ? toolEditor.name : null}
      initial={initial}
      onSaved={() => closeToolEditor()}
      onDeleted={() => closeToolEditor()}
      onClose={closeToolEditor}
    />
  );
}

function ViewRouter() {
  const activeView = useConsoleStore((s) => s.activeView);
  const selectedTaskId = useConsoleStore((s) => s.selectedTaskId);
  const openToolEditor = useConsoleStore((s) => s.openToolEditor);
  const toolEditorKey = useConsoleStore((s) => s.toolEditorKey);

  const view = (() => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardView />;
      case 'task-console':
        return <TaskConsoleView />;
      case 'live-monitor':
        return <LiveMonitorView />;
      case 'tools':
        return <ToolsView onOpenEditor={openToolEditor} />;
      case 'tool-editor':
        return <ToolEditorRoute key={toolEditorKey} />;
      case 'connectors':
        return <ConnectorsView />;
      case 'training':
        return <TrainingView />;
      case 'benchmark':
        return <BenchmarkView />;
      case 'memory':
        return <MemoryView />;
      case 'live-state':
        return <LiveStateView />;
      case 'inspector':
        return <InspectorView />;
      case 'events':
        return <EventsView />;
      case 'history':
        return <HistoryView />;
      case 'models':
        return <ModelsView />;
      case 'datasets':
        return <DatasetsView />;
      case 'docs':
        return <DocsView />;
      case 'settings':
        return <SettingsView />;
      case 'limitations':
        return <LimitationsView />;
      case 'assistant':
        return <AssistantView />;
      case 'task-preview':
        return selectedTaskId ? <TaskPreviewView key={selectedTaskId} taskId={selectedTaskId} /> : <DashboardView />;
      default:
        return <DashboardView />;
    }
  })();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeView}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
      >
        {view}
      </motion.div>
    </AnimatePresence>
  );
}

function Shell() {
  const menuOpen = useState(false);
  const [open, setOpen] = menuOpen;
  return (
    // v1.0.8 §19 — `relative` makes this shell the containing block for the
    // hidden absolutely-positioned inputs Radix renders inside Checkbox/Switch
    // form controls. Without it those inputs anchor to the initial containing
    // block (the viewport) and can extend the document scroll height past the
    // footer, creating an artificial blank area below the footer on tall
    // pages (observed on Task Console). No overflow is hidden — the page
    // simply ends after the footer again.
    <div className="relative flex min-h-screen flex-col bg-background">
      {/* Ambient blue gradient field + faint tech grid (behind everything) */}
      <div className="ambient-bg" aria-hidden />
      <div className="ambient-grid" aria-hidden />

      {/* Top bar */}
      <header className="glass-shell sticky top-0 z-40 border-b border-white/[0.08]">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-3 sm:px-4">
          {/* Mobile menu (secondary access — primary is the bottom nav) */}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-11 text-slate-300 hover:bg-white/[0.06] hover:text-foreground md:hidden" aria-label="Open all sections">
                <Menu className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="glass-strong w-72 border-white/[0.1] p-0">
              <SheetHeader className="border-b border-white/[0.08] px-4 py-3">
                <SheetTitle className="flex items-center gap-2 text-sm text-foreground">
                  <LogoMark className="size-6" />
                  {APP_NAME}
                </SheetTitle>
                <SheetDescription className="font-tech text-[9px] uppercase tracking-widest text-sky-300/70">
                  v{APP_VERSION} · AI Operations Console
                </SheetDescription>
              </SheetHeader>
              <div className="nextool-scroll h-[calc(100dvh-6rem)] overflow-y-auto p-3">
                <NavList onNavigate={() => setOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>

          {/* Logo + version */}
          <BrandButton />

          <div className="ml-auto flex items-center gap-2">
            <RuntimeConnectionStatus compact />
            <NotificationBell />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="font-tech hidden h-9 items-center gap-1.5 border-sky-400/25 bg-sky-400/[0.07] px-3 text-[9px] uppercase tracking-wider text-sky-300 sm:inline-flex">
                    <span className="size-1.5 rounded-full bg-sky-400" aria-hidden />
                    engine: llm-core
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Active decision engine (CoreModule)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="mx-auto flex w-full max-w-[1600px] flex-1">
        {/* Desktop sidebar */}
        <aside className="nextool-scroll sticky top-14 hidden h-[calc(100vh-3.5rem-2.25rem)] w-56 shrink-0 flex-col overflow-y-auto border-r border-white/[0.07] p-3 md:flex" aria-label="Console sections">
          <NavList />
        </aside>

        {/* Main — extra bottom padding clears the mobile bottom nav */}
        <main className="min-w-0 flex-1 p-3 pb-24 sm:p-4 md:p-6 md:pb-6">
          <div className="mx-auto w-full max-w-[1400px]">
            <ViewRouter />
          </div>
        </main>
      </div>

      <StatusBar />
      <MobileBottomNav />
    </div>
  );
}

export default function ConsoleApp() {
  return (
    <SystemStatsProvider>
      <GlobalStreamProvider>
        <NotificationsProvider>
          <Shell />
          <Toaster position="bottom-right" theme="dark" richColors />
        </NotificationsProvider>
      </GlobalStreamProvider>
    </SystemStatsProvider>
  );
}
