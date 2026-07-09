import type { FastifyBaseLogger as Logger } from 'fastify';
import * as repo from '../db/repo.js';
import { publishEvent } from './bus.js';
import { wake } from '../worker.js';

/**
 * Create an event by hand (manual trigger or replay of a stored event) and
 * push it through the exact same transform → deliver → retry pipeline as a
 * real webhook.
 */
export function triggerEvent(
  route: repo.Route,
  payload: unknown,
  source: 'manual' | 'replay',
  log: Logger,
  headers: Record<string, unknown> = {},
): repo.EventRow {
  const event = repo.insertEvent({
    route_id: route.id,
    source,
    headers_json: JSON.stringify(headers),
    payload_json: JSON.stringify(payload ?? null),
  });
  publishEvent('event.received', event);
  log.info({ eventId: event.id, route: route.slug, source }, 'event.triggered');
  wake();
  return event;
}
