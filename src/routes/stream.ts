import type { FastifyInstance } from 'fastify';
import { bus, type BusMessage } from '../core/bus.js';

const KEEPALIVE_MS = 25_000;

/** Server-Sent Events stream powering the live inbox. */
export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');

    const onMessage = (msg: BusMessage) => {
      reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
    };
    bus.on('message', onMessage);

    const keepalive = setInterval(() => reply.raw.write(': keepalive\n\n'), KEEPALIVE_MS);

    req.raw.on('close', () => {
      bus.off('message', onMessage);
      clearInterval(keepalive);
    });
  });
}
