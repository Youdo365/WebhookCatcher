import { EventEmitter } from 'node:events';
import type { EventRow } from '../db/repo.js';

/** In-process pub/sub feeding the SSE stream for the live inbox. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export interface BusMessage {
  type: 'event.received' | 'event.updated';
  event: {
    id: number;
    route_id: number;
    route_slug: string;
    source: string;
    received_at: string;
    status: string;
    attempt_count: number;
  };
}

export function publishEvent(type: BusMessage['type'], e: EventRow): void {
  bus.emit('message', {
    type,
    event: {
      id: e.id,
      route_id: e.route_id,
      route_slug: e.route_slug ?? '',
      source: e.source,
      received_at: e.received_at,
      status: e.status,
      attempt_count: e.attempt_count,
    },
  } satisfies BusMessage);
}
