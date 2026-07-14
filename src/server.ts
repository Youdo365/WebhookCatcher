import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRoutes } from './routes/ingest.js';
import { adminRoutes } from './routes/admin.js';
import { statusRoutes } from './routes/status.js';
import { streamRoutes } from './routes/stream.js';
import { authRoutes } from './routes/auth.js';
import { initAuth, sessionFromCookieHeader, verifySessionToken } from './core/auth.js';
import { startWorker } from './worker.js';

const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({
  logger: process.stdout.isTTY
    ? { level: 'info', transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
    : { level: 'info' },
});

initAuth(app.log);

// Everything requires a login except the catch endpoints (senders can't
// authenticate) and the login flow itself.
const PUBLIC_PATHS = ['/hooks/', '/login', '/api/login', '/style.css'];
app.addHook('onRequest', async (req, reply) => {
  const path = (req.raw.url ?? '/').split('?')[0];
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) return;
  if (verifySessionToken(sessionFromCookieHeader(req.headers.cookie))) return;
  if (path.startsWith('/api/')) return reply.code(401).send({ error: 'unauthorized' });
  return reply.redirect('/login');
});

// Ingest is registered in its own scope: it swaps the content-type parser
// to raw-buffer so signatures can be verified against the exact bytes sent.
await app.register(ingestRoutes);
await app.register(adminRoutes);
await app.register(statusRoutes);
await app.register(streamRoutes);

await app.register(fastifyStatic, {
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
});
await app.register(authRoutes);

startWorker(app.log);

await app.listen({ port: PORT, host: HOST });
app.log.info(`Dashboard: http://${HOST}:${PORT}/`);
