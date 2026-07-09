import type { FastifyInstance } from 'fastify';
import * as repo from '../db/repo.js';
import { verifySignature } from '../core/verify.js';
import { publishEvent } from '../core/bus.js';
import { wake } from '../worker.js';

/** Headers that are transport noise, not part of the webhook's meaning. */
const SKIP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  // Capture the raw body as a buffer regardless of content type — needed
  // both for HMAC verification and for senders that don't send JSON.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/hooks/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const route = repo.getRouteBySlug(slug);
    if (!route || !route.active) {
      return reply.code(404).send({ error: 'unknown route' });
    }

    const rawBody = (req.body as Buffer | undefined) ?? Buffer.alloc(0);

    if (route.signing_secret && !verifySignature(route.signing_secret, req.headers, rawBody)) {
      req.log.warn({ route: slug }, 'ingest.signature_rejected');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      payload = { raw: rawBody.toString('utf8') }; // non-JSON bodies still get caught
    }

    const headers: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!SKIP_HEADERS.has(key)) headers[key] = value;
    }

    // Persist BEFORE acking — once the sender sees 200, the event must be durable.
    const event = repo.insertEvent({
      route_id: route.id,
      source: 'webhook',
      headers_json: JSON.stringify(headers),
      payload_json: JSON.stringify(payload),
    });

    req.log.info({ eventId: event.id, route: slug }, 'event.received');
    publishEvent('event.received', event);
    wake();

    return reply.code(200).send({ ok: true, event_id: event.id });
  });
}
