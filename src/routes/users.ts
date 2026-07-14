import type { FastifyInstance } from 'fastify';
import * as repo from '../db/repo.js';
import { hashPassword } from '../core/auth.js';

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async () => repo.listUsers());

  app.post('/api/users', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: 'username: 2-32 characters, letters/digits/._-' });
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    if (repo.getUserByUsername(username)) {
      return reply.code(409).send({ error: 'username already exists' });
    }
    const user = repo.createUser(username, hashPassword(password));
    req.log.info({ username, by: req.userId }, 'user.created');
    return reply.code(201).send(user);
  });

  app.put('/api/users/:id/password', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repo.getUser(id)) return reply.code(404).send({ error: 'not found' });
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    repo.updateUserPassword(id, hashPassword(password));
    req.log.info({ userId: id, by: req.userId }, 'user.password_changed');
    return { ok: true };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const user = repo.getUser(id);
    if (!user) return reply.code(404).send({ error: 'not found' });
    if (id === req.userId) return reply.code(400).send({ error: 'you cannot delete your own account' });
    if (repo.countUsers() === 1) return reply.code(400).send({ error: 'cannot delete the last user' });
    repo.deleteUser(id); // also invalidates that user's sessions
    req.log.info({ username: user.username, by: req.userId }, 'user.deleted');
    return { ok: true };
  });
}
