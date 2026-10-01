/**
 * Virtual environment tool handlers — operate on the in-memory server fleet.
 * Environment: 'virtual-env' (transparent in-memory simulation, labeled as such in the registry).
 */
import { driftServer, getServer, listServers, restartServer, RESTART_DELAY_MS } from '../environment';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';

function requireServerId(params: Record<string, unknown>): string {
  const serverId = params.serverId === undefined ? undefined : String(params.serverId);
  if (!serverId) throw new ToolFailure('Missing required param: serverId', 'INVALID_PARAMS');
  if (!getServer(serverId)) throw new ToolFailure(`Unknown server: ${serverId}`, 'INVALID_PARAMS');
  return serverId;
}

/** server.list — no params. */
export const serverList: ToolHandler = async () => {
  return {
    environment: 'virtual-env',
    servers: listServers(),
  };
};

/** server.health — drifts the server then reports state. */
export const serverHealth: ToolHandler = async (params) => {
  const serverId = requireServerId(params);
  const server = driftServer(serverId);
  return {
    serverId: server.id,
    health: server.health,
    cpu: server.cpu,
    memory: server.memory,
    uptimeSec: server.uptimeSec,
    checkedAt: server.lastCheckAt,
  };
};

/** server.restart — initiates restart (healthy after ~2.5s). */
export const serverRestart: ToolHandler = async (params) => {
  const serverId = requireServerId(params);
  restartServer(serverId);
  return {
    serverId,
    status: 'restart_initiated',
    healthyAfterMs: RESTART_DELAY_MS,
  };
};

/** service.restart — alias of server.restart. */
export const serviceRestart: ToolHandler = serverRestart;
