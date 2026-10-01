'use client';

/**
 * NexTool Q1 console shell — single-page app. The ONLY visible route is `/`;
 * all 13 screens are client-side views switched by `useConsoleStore.activeView`.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Toaster } from '@/components/ui/sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useConsoleStore, shortId, type ConsoleView } from './console-store';
import { GlobalStreamProvider, NotificationsProvider, SystemStatsProvider, useGlobalStream, useNotifications, useSystemStats } from './providers';
import { fmtUptime, statusTone } from './ui-bits';
import DashboardView from './views/dashboard';
import TaskConsoleView from './views/task-console';
import TaskPreviewView from './views/task-preview';
import LiveMonitorView from './views/live-monitor';
import ToolsView from './views/tools';
import MemoryView from './views/memory';
import LiveStateView from './views/live-state';
import EventsView from './views/events';
import HistoryView from './views/history';
import ModelsView from './views/models';
import DatasetsView from './views/datasets';
import SettingsView from './views/settings';
import {
  Activity,
  Bell,
  Box,
  Database,
  FileJson,
  History,
  LayoutDashboard,
  ListFilter,
  Menu,
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
  { view: 'memory', label: 'Memory', icon: Database },
  { view: 'live-state', label: 'Live State', icon: Activity },
  { view: 'events', label: 'Events', icon: ListFilter },
  { view: 'history', label: 'History', icon: History },
  { view: 'models', label: 'Models', icon: Box },
  { view: 'datasets', label: 'Datasets', icon: FileJson },
  { view: 'settings', label: 'Settings', icon: SlidersHorizontal },
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
        'flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
        active ? 'bg-emerald-500/10 font-medium text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden />
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
        <Separator className="bg-zinc-800/80" />
      </div>
      <button
        type="button"
        onClick={() => {
          setActiveView('task-preview');
          onNavigate?.();
        }}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'mx-3 flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
          active ? 'bg-emerald-500/10 font-medium text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
        )}
      >
        <TerminalSquare className="size-4 shrink-0 text-emerald-500/70" aria-hidden />
        <span className="truncate">
          Task Preview <span className="font-mono text-xs text-zinc-500">#{shortId(selectedTaskId)}</span>
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

function ConnectionPill() {
  const { status } = useGlobalStream();
  const live = status === 'live';
  const offline = status === 'offline';
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="status"
            aria-label={`Event stream ${status}`}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-full border px-3 font-mono text-xs',
              live && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
              status === 'connecting' && 'border-amber-500/30 bg-amber-500/10 text-amber-300',
              offline && 'border-rose-500/30 bg-rose-500/10 text-rose-300',
            )}
          >
            <span className="relative inline-flex size-2" aria-hidden>
              <span className={cn('absolute inline-flex size-full rounded-full opacity-60', live && 'animate-ping bg-emerald-400', status === 'connecting' && 'animate-ping bg-amber-400', offline && 'bg-rose-400')} />
              <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-emerald-400' : status === 'connecting' ? 'bg-amber-400' : 'bg-rose-400')} />
            </span>
            {live ? 'live' : status}
          </span>
        </TooltipTrigger>
        <TooltipContent>Server-Sent Events stream — /api/stream</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function NotificationBell() {
  const { notifications, unread, markAllRead, loading } = useNotifications();
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-9" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell className="size-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 font-mono text-[10px] font-bold text-zinc-950">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 border-zinc-800 bg-popover p-0">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Notifications</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-emerald-300 hover:text-emerald-200" onClick={() => void markAllRead()} disabled={loading || unread === 0}>
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
                className={cn('flex w-full flex-col items-start gap-0.5 border-b border-zinc-800/60 px-3 py-2.5 text-left hover:bg-zinc-800/40', !n.read && 'bg-emerald-500/5')}
              >
                <span className="flex w-full items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      n.level === 'critical' ? 'bg-rose-400' : n.level === 'warning' ? 'bg-amber-400' : 'bg-zinc-400',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">{n.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-500">{new Date(n.createdAt).toLocaleTimeString('en-GB', { hour12: false })}</span>
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

  const runtimeStatus = stats?.runtimeStatus ?? (status === 'offline' ? 'offline' : 'connecting');
  const tone = statusTone(runtimeStatus);

  return (
    <footer className="mt-auto border-t border-zinc-800/80 bg-zinc-950/95">
      <div className="mx-auto flex h-9 w-full max-w-[1600px] items-center justify-between gap-3 px-4 font-mono text-[11px] text-zinc-500">
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden sm:inline">RUNTIME</span>
          <span
            aria-label={`Runtime ${runtimeStatus}`}
            className={cn('inline-flex items-center gap-1.5', tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : 'text-rose-300')}
          >
            <span className={cn('size-1.5 rounded-full', tone === 'ok' ? 'animate-pulse bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : 'bg-rose-400')} aria-hidden />
            {stats ? runtimeStatus : 'offline'}
          </span>
        </div>
        <div className="hidden min-w-0 items-center gap-3 truncate md:flex">
          <span>active {stats ? stats.tasks.active : '—'}</span>
          <span>live {stats ? stats.tasks.live : '—'}</span>
          <span>engine {stats ? stats.engine.active : '—'}</span>
          <span>up {stats ? fmtUptime(stats.runtimeUptimeSec) : '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn('size-1.5 rounded-full', status === 'live' ? 'animate-pulse bg-emerald-400' : status === 'connecting' ? 'bg-amber-400' : 'bg-rose-400')} />
          <span>SSE: {status}</span>
          <span aria-hidden className="text-zinc-700">│</span>
          <span className="tabular-nums">{clock ?? '--:--:--'}</span>
        </div>
      </div>
    </footer>
  );
}

function ViewRouter() {
  const activeView = useConsoleStore((s) => s.activeView);
  const selectedTaskId = useConsoleStore((s) => s.selectedTaskId);

  const view = (() => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardView />;
      case 'task-console':
        return <TaskConsoleView />;
      case 'live-monitor':
        return <LiveMonitorView />;
      case 'tools':
        return <ToolsView />;
      case 'memory':
        return <MemoryView />;
      case 'live-state':
        return <LiveStateView />;
      case 'events':
        return <EventsView />;
      case 'history':
        return <HistoryView />;
      case 'models':
        return <ModelsView />;
      case 'datasets':
        return <DatasetsView />;
      case 'settings':
        return <SettingsView />;
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
  const sidebarOpen = useConsoleStore((s) => s.sidebarOpen);
  const setSidebarOpen = useConsoleStore((s) => s.setSidebarOpen);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4">
          {/* Mobile nav */}
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-11 md:hidden" aria-label="Open navigation">
                <Menu className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 border-zinc-800 bg-zinc-950 p-0">
              <SheetHeader className="border-b border-zinc-800 px-4 py-3">
                <SheetTitle className="flex items-center gap-2 text-sm text-zinc-200">
                  <span className="flex size-6 items-center justify-center rounded-md bg-emerald-500/15">
                    <Wrench className="size-3.5 text-emerald-400" aria-hidden />
                  </span>
                  NexTool
                </SheetTitle>
                <SheetDescription className="sr-only">Console navigation</SheetDescription>
              </SheetHeader>
              <div className="p-3">
                <NavList onNavigate={() => setSidebarOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>

          {/* Logo */}
          <button
            type="button"
            onClick={() => useConsoleStore.getState().setActiveView('dashboard')}
            className="flex items-center gap-2.5 rounded-md px-1 py-1 outline-ring/50 focus-visible:ring-2"
            aria-label="Go to dashboard"
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-emerald-500/15 ring-1 ring-emerald-500/30">
              <Wrench className="size-4 text-emerald-400" aria-hidden />
            </span>
            <span className="text-sm font-semibold tracking-tight text-zinc-100">NexTool</span>
            <Badge variant="outline" className="border-zinc-700/80 font-mono text-[10px] text-zinc-400">
              Q1 v1.0.0
            </Badge>
          </button>

          <div className="ml-auto flex items-center gap-2">
            <ConnectionPill />
            <NotificationBell />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="hidden h-9 items-center gap-1.5 border-zinc-700/80 px-3 font-mono text-[11px] text-zinc-300 sm:inline-flex">
                    <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
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
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800/80 p-3 nextool-scroll md:flex" aria-label="Console sections">
          <NavList />
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <div className="mx-auto w-full max-w-[1400px]">
            <ViewRouter />
          </div>
        </main>
      </div>

      <StatusBar />
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
