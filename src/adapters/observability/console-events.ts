import { createHash } from 'node:crypto';
import type { EventSink } from '../../domain/ports.js';
import type { AppEvent } from '../../domain/model.js';
const tag = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex').slice(0,16);
/** Explicit projection: even extra fields on a cast/untrusted event cannot reach logs. */
export function safeEvent(event: AppEvent): Readonly<Record<string,unknown>> {
  if (event.type === 'poll.completed') return { type:event.type,target:tag(event.targetId),
    newPosts:Number.isSafeInteger(event.newPosts) && event.newPosts>=0?event.newPosts:0 };
  if (event.type === 'notification.finished') return { type:event.type,id:tag(event.id),
    status:['accepted','rejected','unknown'].includes(event.status)?event.status:'unknown' };
  return { type:'cycle.failed',stage:['ingest','analysis','delivery','digest'].includes(event.stage)?event.stage:'unknown' };
}
export class ConsoleEvents implements EventSink {
  record(event: AppEvent): void { console.log(JSON.stringify(safeEvent(event))); }
}
