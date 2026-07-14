import type { FastifyInstance } from 'fastify';
import * as repo from '../db/repo.js';
import { COOKIE_NAME, SESSION_TTL_SECONDS, createSessionToken, verifyLogin } from '../core/auth.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', (_req, reply) => reply.sendFile('login.html'));

  app.post('/api/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const user = username && password ? verifyLogin(username, password) : null;
    if (!user) {
      req.log.warn({ username }, 'auth.login_failed');
      await new Promise((r) => setTimeout(r, 500)); // slow down brute force
      return reply.code(401).send({ error: 'wrong username or password' });
    }
    req.log.info({ username: user.username }, 'auth.login_success');
    // Secure only over HTTPS (via trustProxy) so plain-HTTP local dev still works.
    const secure = req.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie',
      `${COOKIE_NAME}=${createSessionToken(user.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
    return { ok: true, user };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  // Who am I? (protected by the global guard like every other /api route)
  app.get('/api/me', async (req, reply) => {
    const user = req.userId !== null ? repo.getUser(req.userId) : undefined;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { id: user.id, username: user.username };
  });
}
