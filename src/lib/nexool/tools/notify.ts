/**
 * Notification tool handler — persists NotificationRecord + emits notification.sent event.
 */
import { emitEvent } from '../eventbus';
import { db } from '@/lib/db';
import type { ToolHandler } from './handler';
import { ToolFailure } from './handler';

const LEVEL_PRIORITY: Record<string, number> = { critical: 2, warning: 4, info: 6 };

/** notification.send — { title required, body?, level: info|warning|critical }. */
export const notificationSend: ToolHandler = async (params, ctx) => {
  const title = params.title === undefined ? undefined : String(params.title);
  if (!title) throw new ToolFailure('Missing required param: title', 'INVALID_PARAMS');
  const body = params.body === undefined ? '' : String(params.body);
  const level = params.level === undefined ? 'info' : String(params.level);
  if (level !== 'info' && level !== 'warning' && level !== 'critical') {
    throw new ToolFailure('level must be one of: info, warning, critical', 'INVALID_PARAMS');
  }

  const record = await db.notificationRecord.create({
    data: { title, body, source: 'tool', taskId: ctx.taskId ?? null, level },
  });

  void emitEvent({
    taskId: ctx.taskId,
    type: 'notification.sent',
    source: 'tool',
    message: `Notification [${level}]: ${title}`,
    data: { id: record.id, title, body, level },
    priority: LEVEL_PRIORITY[level] ?? 6,
  });

  return {
    id: record.id,
    title: record.title,
    body: record.body,
    level: record.level as 'info' | 'warning' | 'critical',
    createdAt: record.createdAt.toISOString(),
  };
};
