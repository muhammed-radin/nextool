'use client';

import { create } from 'zustand';
import type { ToolEntry } from '@/lib/nexool/api-contract';

export type ConsoleView =
  | 'dashboard'
  | 'task-console'
  | 'live-monitor'
  | 'tools'
  | 'tool-editor'
  | 'memory'
  | 'live-state'
  | 'events'
  | 'history'
  | 'models'
  | 'datasets'
  | 'training'
  | 'benchmark'
  | 'docs'
  | 'settings'
  | 'task-preview';

export interface ToolEditorRequest {
  mode: 'new' | 'edit' | 'duplicate';
  name: string | null;
  /** Source entry for duplicate prefill. */
  source?: ToolEntry;
}

interface ConsoleStore {
  activeView: ConsoleView;
  selectedTaskId: string | null;
  sidebarOpen: boolean;
  toolEditor: ToolEditorRequest | null;
  /** Monotonically increasing key so duplicate edits of the same tool remount. */
  toolEditorKey: number;
  setActiveView: (view: ConsoleView) => void;
  /** Select a task and switch to the dedicated Task Preview screen. */
  openTaskPreview: (taskId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  openToolEditor: (req: ToolEditorRequest) => void;
  closeToolEditor: () => void;
}

export const useConsoleStore = create<ConsoleStore>((set) => ({
  activeView: 'dashboard',
  selectedTaskId: null,
  sidebarOpen: false,
  toolEditor: null,
  toolEditorKey: 0,
  setActiveView: (view) => set({ activeView: view }),
  openTaskPreview: (taskId) => set({ selectedTaskId: taskId, activeView: 'task-preview' }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  openToolEditor: (req) => set((s) => ({ toolEditor: req, toolEditorKey: s.toolEditorKey + 1, activeView: 'tool-editor' })),
  closeToolEditor: () => set({ activeView: 'tools' }),
}));

export const shortId = (id: string | undefined | null): string =>
  (id ?? '').length > 8 ? (id ?? '').slice(0, 8) : (id ?? '');
