/**
 * NexTool Virtual Environment — in-memory server fleet state machine.
 * Transparently labeled 'virtual-env' in the tool registry (no fabricated data:
 * this is a real in-memory simulation environment for the runtime to act on).
 */
import { emitEvent } from './eventbus';
import type { VirtualServer, GlobalLiveState } from './types';

interface EnvState {
  servers: Map<string, VirtualServer>;
  startedAt: string;
}

const g = globalThis as unknown as { __nextoolEnv?: EnvState };

const SEED: { id: string; cpu: number; memory: number }[] = [
  { id: 'api-01', cpu: 34, memory: 51 },
  { id: 'web-01', cpu: 22, memory: 40 },
  { id: 'db-01', cpu: 41, memory: 58 },
];

function state(): EnvState {
  if (!g.__nextoolEnv) {
    const servers = new Map<string, VirtualServer>();
    const now = new Date().toISOString();
    for (const s of SEED) {
      servers.set(s.id, {
        id: s.id,
        health: 'healthy',
        cpu: s.cpu,
        memory: s.memory,
        uptimeSec: 3600 + Math.floor(Math.random() * 86400),
        lastCheckAt: now,
      });
    }
    g.__nextoolEnv = { servers, startedAt: now };
  }
  return g.__nextoolEnv;
}

function rand(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Random-walk a server's cpu/mem; 10% chance to degrade. */
export function driftServer(id: string): VirtualServer {
  const env = state();
  const server = env.servers.get(id);
  if (!server) throw new Error(`Unknown server: ${id}`);
  if (server.health === 'unhealthy') {
    server.cpu = 0;
    server.memory = 0;
  } else if (server.health === 'restarting') {
    server.cpu = rand(30, 60);
    server.memory = rand(30, 55);
  } else {
    server.cpu = Math.min(90, Math.max(5, server.cpu + rand(-12, 12)));
    server.memory = Math.min(90, Math.max(10, server.memory + rand(-8, 8)));
    if (server.health === 'healthy' && Math.random() < 0.1) {
      server.health = 'degraded';
    } else if (server.health === 'degraded' && Math.random() < 0.25) {
      server.health = 'healthy';
    }
  }
  server.uptimeSec += 5;
  server.lastCheckAt = new Date().toISOString();
  return { ...server };
}

export function crashServer(id: string): VirtualServer {
  const env = state();
  const server = env.servers.get(id);
  if (!server) throw new Error(`Unknown server: ${id}`);
  server.health = 'unhealthy';
  server.cpu = 0;
  server.memory = 0;
  server.lastCheckAt = new Date().toISOString();
  void emitEvent({
    type: 'env.server.crash',
    source: 'environment',
    message: `Server ${id} crashed (virtual environment event)`,
    data: { serverId: id, health: 'unhealthy' },
    priority: 2,
  });
  return { ...server };
}

export function degradeServer(id: string): VirtualServer {
  const env = state();
  const server = env.servers.get(id);
  if (!server) throw new Error(`Unknown server: ${id}`);
  server.health = 'degraded';
  server.cpu = rand(70, 90);
  server.memory = rand(60, 90);
  server.lastCheckAt = new Date().toISOString();
  void emitEvent({
    type: 'env.server.degrade',
    source: 'environment',
    message: `Server ${id} degraded (virtual environment event)`,
    data: { serverId: id, health: 'degraded' },
    priority: 4,
  });
  return { ...server };
}

export function recoverServer(id: string): VirtualServer {
  const env = state();
  const server = env.servers.get(id);
  if (!server) throw new Error(`Unknown server: ${id}`);
  server.health = 'healthy';
  server.cpu = rand(15, 45);
  server.memory = rand(15, 50);
  server.lastCheckAt = new Date().toISOString();
  return { ...server };
}

export const RESTART_DELAY_MS = 2500;

/** Restart: health → 'restarting', after 2.5s becomes healthy with cpu ~20. Emits env.server.recovered. */
export function restartServer(id: string): VirtualServer {
  const env = state();
  const server = env.servers.get(id);
  if (!server) throw new Error(`Unknown server: ${id}`);
  server.health = 'restarting';
  server.cpu = rand(35, 70);
  server.memory = rand(40, 60);
  server.lastCheckAt = new Date().toISOString();
  setTimeout(() => {
    try {
      const s = env.servers.get(id);
      if (!s || s.health !== 'restarting') return;
      s.health = 'healthy';
      s.cpu = rand(15, 25);
      s.memory = rand(20, 40);
      s.uptimeSec = 0;
      s.lastCheckAt = new Date().toISOString();
      void emitEvent({
        type: 'env.server.recovered',
        source: 'environment',
        message: `Server ${id} recovered after restart`,
        data: { serverId: id, health: 'healthy' },
        priority: 3,
      });
    } catch (err) {
      console.error('[environment] restart completion failed:', err);
    }
  }, RESTART_DELAY_MS);
  return { ...server };
}

export function getServer(id: string): VirtualServer | undefined {
  const s = state().servers.get(id);
  return s ? { ...s } : undefined;
}

export function listServers(): VirtualServer[] {
  return [...state().servers.values()].map((s) => ({ ...s }));
}

export function getGlobalLiveState(
  activeGoalTasks: number,
  activeLiveTasks: number,
): GlobalLiveState {
  const servers = listServers();
  const runtimeStatus: GlobalLiveState['runtimeStatus'] =
    servers.every((s) => s.health === 'healthy')
      ? 'online'
      : servers.some((s) => s.health === 'unhealthy')
        ? 'offline'
        : 'degraded';
  return {
    servers,
    runtimeStatus,
    activeGoalTasks,
    activeLiveTasks,
    startedAt: state().startedAt,
  };
}
