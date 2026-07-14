import type { FastifyInstance } from 'fastify';
import { COOKIE_NAME, SESSION_TTL_SECONDS, createSessionToken, verifyPassword } from '../core/auth.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', (_req, reply) => reply.sendFile('login.html'));

  app.post('/api/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !verifyPassword(password)) {
      req.log.warn('auth.login_failed');
      await new Promise((r) => setTimeout(r, 500)); // slow down brute force
      return reply.code(401).send({ error: 'wrong password' });
    }
    req.log.info('auth.login_success');
    reply.header('set-cookie',
      `${COOKIE_NAME}=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`);
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });
}
