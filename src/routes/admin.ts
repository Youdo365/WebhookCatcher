import type { FastifyInstance } from 'fastify';
import * as repo from '../db/repo.js';
import { transform, validateSpec } from '../core/transform.js';
import { triggerEvent } from '../core/trigger.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface RouteBody {
  slug?: string; name?: string; signing_secret?: string | null;
  transform_spec?: string; destination_url?: string | null;
  destination_headers?: string; active?: boolean | number;
}

function validateRouteBody(b: RouteBody): string | null {
  if (!b.slug || !SLUG_RE.test(b.slug)) return 'slug is required: lowercase letters, digits and dashes';
  if (!b.name) return 'name is required';
  if (b.transform_spec) {
    const err = validateSpec(b.transform_spec);
    if (err) return `transform_spec: ${err}`;
  }
  if (b.destination_url) {
    try { new URL(b.destination_url); } catch { return 'destination_url is not a valid URL'; }
  }
  if (b.destination_headers) {
    try {
      const parsed = JSON.parse(b.destination_headers);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    } catch { return 'destination_headers must be a JSON object'; }
  }
  return null;
}

function toRouteFields(b: RouteBody) {
  return {
    slug: b.slug!,
    name: b.name!,
    signing_secret: b.signing_secret || null,
    transform_spec: b.transform_spec || 'body',
    destination_url: b.destination_url || null,
    destination_headers: b.destination_headers || '{}',
    active: b.active === undefined ? 1 : (b.active ? 1 : 0),
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── routes CRUD ──────────────────────────────────────────────────
  app.get('/api/routes', async () => repo.listRoutes());

  app.post('/api/routes', async (req, reply) => {
    const body = (req.body ?? {}) as RouteBody;
    const err = validateRouteBody(body);
    if (err) return reply.code(400).send({ error: err });
    if (repo.getRouteBySlug(body.slug!)) return reply.code(409).send({ error: 'slug already exists' });
    const route = repo.createRoute(toRouteFields(body));
    req.log.info({ route: route.slug }, 'route.created');
    return reply.code(201).send(route);
  });

  app.get('/api/routes/:id', async (req, reply) => {
    const route = repo.getRoute(Number((req.params as { id: string }).id));
    if (!route) return reply.code(404).send({ error: 'not found' });
    return route;
  });

  app.put('/api/routes/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repo.getRoute(id)) return reply.code(404).send({ error: 'not found' });
    const body = (req.body ?? {}) as RouteBody;
    const err = validateRouteBody(body);
    if (err) return reply.code(400).send({ error: err });
    const existing = repo.getRouteBySlug(body.slug!);
    if (existing && existing.id !== id) return reply.code(409).send({ error: 'slug already exists' });
    const route = repo.updateRoute(id, toRouteFields(body));
    req.log.info({ route: route!.slug }, 'route.updated');
    return route;
  });

  app.delete('/api/routes/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const route = repo.getRoute(id);
    if (!route) return reply.code(404).send({ error: 'not found' });
    repo.deleteRoute(id);
    req.log.info({ route: route.slug }, 'route.deleted');
    return { ok: true };
  });

  // ── events ───────────────────────────────────────────────────────
  app.get('/api/events', async (req) => {
    const q = req.query as { route_id?: string; before?: string; limit?: string };
    return repo.listEvents({
      routeId: q.route_id ? Number(q.route_id) : undefined,
      before: q.before ? Number(q.before) : undefined,
      limit: q.limit ? Math.min(Number(q.limit), 200) : 50,
    });
  });

  app.get('/api/events/:id', async (req, reply) => {
    const event = repo.getEvent(Number((req.params as { id: string }).id));
    if (!event) return reply.code(404).send({ error: 'not found' });
    return { ...event, attempts: repo.attemptsForEvent(event.id) };
  });

  // Replay: re-run a stored payload through the pipeline as a fresh event.
  app.post('/api/events/:id/replay', async (req, reply) => {
    const event = repo.getEvent(Number((req.params as { id: string }).id));
    if (!event) return reply.code(404).send({ error: 'not found' });
    const route = repo.getRoute(event.route_id);
    if (!route) return reply.code(404).send({ error: 'route not found' });
    const replayed = triggerEvent(
      route, JSON.parse(event.payload_json), 'replay', req.log, JSON.parse(event.headers_json),
    );
    return reply.code(201).send(replayed);
  });

  // Manual trigger: fire the pipeline with a custom payload.
  app.post('/api/routes/:id/trigger', async (req, reply) => {
    const route = repo.getRoute(Number((req.params as { id: string }).id));
    if (!route) return reply.code(404).send({ error: 'not found' });
    const { payload } = (req.body ?? {}) as { payload?: unknown };
    const event = triggerEvent(route, payload ?? {}, 'manual', req.log);
    return reply.code(201).send(event);
  });

  // Transform preview: run a spec against a sample input without touching the DB.
  app.post('/api/preview', async (req, reply) => {
    const { spec, body, headers } = (req.body ?? {}) as {
      spec?: string; body?: unknown; headers?: Record<string, unknown>;
    };
    if (!spec) return reply.code(400).send({ error: 'spec is required' });
    try {
      const result = await transform(spec, {
        headers: headers ?? {},
        body: body ?? {},
        route: { slug: 'preview', name: 'preview' },
      });
      return { ok: true, result: result ?? null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
