import type { FastifyInstance } from 'fastify';
import * as repo from '../db/repo.js';
import { HEARTBEAT_KEY } from '../worker.js';

const WORKER_STALE_MS = 15_000;

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  // Public health check for uptime monitors (Uptime Kuma HTTP monitor):
  // 200 when the delivery worker is alive, 503 when it has stalled.
  // Deliberately exposes no route or event data.
  app.get('/health', async (_req, reply) => {
    const heartbeat = Number(repo.getMeta(HEARTBEAT_KEY) ?? 0);
    const healthy = Date.now() - heartbeat < WORKER_STALE_MS;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      worker_last_tick: heartbeat ? new Date(heartbeat).toISOString() : null,
    });
  });

  app.get('/api/status', async () => {
    const heartbeat = Number(repo.getMeta(HEARTBEAT_KEY) ?? 0);
    const routes = repo.statusSummary().map((r) => {
      const finished = r.delivered_24h + r.dead_24h;
      return {
        ...r,
        success_rate_24h: finished > 0 ? r.delivered_24h / finished : null,
        health: r.dead_total > 0 ? 'red' : r.pending > 0 ? 'amber' : 'green',
      };
    });
    return {
      worker: {
        last_tick_at: heartbeat ? new Date(heartbeat).toISOString() : null,
        healthy: Date.now() - heartbeat < WORKER_STALE_MS,
      },
      routes,
    };
  });
}
