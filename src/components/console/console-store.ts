'use client';

import { create } from 'zustand';

export type ConsoleView =
  | 'dashboard'
  | 'task-console'
  | 'live-monitor'
  | 'tools'
  | 'memory'
  | 'live-state'
  | 'events'
  | 'history'
  | 'models'
  | 'datasets'
  | 'docs'
  | 'settings'
  | 'task-preview';

interface ConsoleStore {
  activeView: ConsoleView;
  selectedTaskId: string | null;
  sidebarOpen: boolean;
  setActiveView: (view: ConsoleView) => void;
  /** Select a task and switch to the dedicated Task Preview screen. */
  openTaskPreview: (taskId: string) => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useConsoleStore = create<ConsoleStore>((set) => ({
  activeView: 'dashboard',
  selectedTaskId: null,
  sidebarOpen: false,
  setActiveView: (view) => set({ activeView: view }),
  openTaskPreview: (taskId) => set({ selectedTaskId: taskId, activeView: 'task-preview' }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}));

export const shortId = (id: string | undefined | null): string =>
  (id ?? '').length > 8 ? (id ?? '').slice(0, 8) : (id ?? '');
