import type { FastifyBaseLogger as Logger } from 'fastify';
import * as repo from '../db/repo.js';
import { transform } from './transform.js';
import { nextRetryDelay } from './retry.js';
import { publishEvent } from './bus.js';

const DELIVERY_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 2_000;

/**
 * Deliver one event: transform, POST to the route's destination, record the
 * attempt, and schedule a retry or dead-letter on failure.
 */
export async function deliverEvent(eventId: number, log: Logger): Promise<void> {
  const event = repo.getEvent(eventId);
  if (!event || event.status === 'delivered' || event.status === 'dead') return;
  const route = repo.getRoute(event.route_id);
  if (!route) return;

  const attemptNo = event.attempt_count + 1;
  const elog = log.child({ eventId, route: route.slug, attempt: attemptNo });

  // 1. Transform. A transform error is permanent — retrying won't fix the
  //    spec — so dead-letter immediately; a replay after fixing it re-runs.
  let transformed: unknown;
  try {
    transformed = await transform(route.transform_spec, {
      headers: JSON.parse(event.headers_json),
      body: JSON.parse(event.payload_json),
      route: { slug: route.slug, name: route.name },
    });
    repo.saveTransformed(event.id, JSON.stringify(transformed ?? null));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    repo.insertAttempt({ event_id: event.id, attempt_no: attemptNo, error: `transform: ${message}` });
    repo.markDead(event.id, attemptNo);
    publishEvent('event.updated', repo.getEvent(event.id)!);
    elog.error({ err: message }, 'delivery.dead (transform error)');
    return;
  }

  // 2. No destination configured: catch-only route, nothing to forward.
  if (!route.destination_url) {
    repo.markDelivered(event.id, event.attempt_count);
    publishEvent('event.updated', repo.getEvent(event.id)!);
    elog.info('event.stored (no destination configured)');
    return;
  }

  // 3. Forward.
  let failure: string | null = null;
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...JSON.parse(route.destination_headers || '{}'),
    };
    const res = await fetch(route.destination_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformed ?? null),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    const body = (await res.text()).slice(0, RESPONSE_BODY_LIMIT);
    repo.insertAttempt({ event_id: event.id, attempt_no: attemptNo, status_code: res.status, response_body: body });
    if (res.ok) {
      repo.markDelivered(event.id, attemptNo);
      publishEvent('event.updated', repo.getEvent(event.id)!);
      elog.info({ statusCode: res.status }, 'delivery.success');
      return;
    }
    failure = `destination responded ${res.status}`;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    repo.insertAttempt({ event_id: event.id, attempt_no: attemptNo, error: message });
    failure = message;
  }

  // 4. Failure: retry with backoff, or dead-letter when exhausted.
  const delay = nextRetryDelay(attemptNo);
  if (delay !== null) {
    repo.scheduleRetry(event.id, attemptNo, Date.now() + delay * 1000);
    elog.warn({ err: failure, retryInSeconds: delay }, 'delivery.retry_scheduled');
  } else {
    repo.markDead(event.id, attemptNo);
    elog.error({ err: failure }, 'delivery.dead (retries exhausted)');
  }
  publishEvent('event.updated', repo.getEvent(event.id)!);
}
