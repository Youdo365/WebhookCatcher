import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA } from './schema.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'webhooks.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(SCHEMA);

export type EventStatus = 'received' | 'delivered' | 'failed' | 'dead';
export type EventSource = 'webhook' | 'manual' | 'replay';

export interface Route {
  id: number;
  slug: string;
  name: string;
  signing_secret: string | null;
  transform_spec: string;
  destination_url: string | null;
  destination_headers: string;
  active: number;
  created_at: string;
}

export interface EventRow {
  id: number;
  route_id: number;
  source: EventSource;
  received_at: string;
  headers_json: string;
  payload_json: string;
  transformed_json: string | null;
  status: EventStatus;
  attempt_count: number;
  next_attempt_at: number | null;
  route_slug?: string;
}

export interface Attempt {
  id: number;
  event_id: number;
  attempt_no: number;
  at: string;
  status_code: number | null;
  response_body: string | null;
  error: string | null;
}

// ── routes ─────────────────────────────────────────────────────────

export function listRoutes(): Route[] {
  return db.prepare('SELECT * FROM routes ORDER BY id').all() as unknown as Route[];
}

export function getRoute(id: number): Route | undefined {
  return db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as Route | undefined;
}

export function getRouteBySlug(slug: string): Route | undefined {
  return db.prepare('SELECT * FROM routes WHERE slug = ?').get(slug) as Route | undefined;
}

export function createRoute(r: {
  slug: string; name: string; signing_secret?: string | null;
  transform_spec?: string; destination_url?: string | null;
  destination_headers?: string; active?: number;
}): Route {
  const info = db.prepare(`
    INSERT INTO routes (slug, name, signing_secret, transform_spec, destination_url, destination_headers, active)
    VALUES (@slug, @name, @signing_secret, @transform_spec, @destination_url, @destination_headers, @active)
  `).run({
    slug: r.slug,
    name: r.name,
    signing_secret: r.signing_secret ?? null,
    transform_spec: r.transform_spec ?? 'body',
    destination_url: r.destination_url ?? null,
    destination_headers: r.destination_headers ?? '{}',
    active: r.active ?? 1,
  });
  return getRoute(Number(info.lastInsertRowid))!;
}

export function updateRoute(id: number, r: {
  slug: string; name: string; signing_secret?: string | null;
  transform_spec?: string; destination_url?: string | null;
  destination_headers?: string; active?: number;
}): Route | undefined {
  db.prepare(`
    UPDATE routes SET slug=@slug, name=@name, signing_secret=@signing_secret,
      transform_spec=@transform_spec, destination_url=@destination_url,
      destination_headers=@destination_headers, active=@active
    WHERE id=@id
  `).run({
    id,
    slug: r.slug,
    name: r.name,
    signing_secret: r.signing_secret ?? null,
    transform_spec: r.transform_spec ?? 'body',
    destination_url: r.destination_url ?? null,
    destination_headers: r.destination_headers ?? '{}',
    active: r.active ?? 1,
  });
  return getRoute(id);
}

export function deleteRoute(id: number): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM attempts WHERE event_id IN (SELECT id FROM events WHERE route_id = ?)').run(id);
    db.prepare('DELETE FROM events WHERE route_id = ?').run(id);
    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── events ─────────────────────────────────────────────────────────

export function insertEvent(e: {
  route_id: number; source: EventSource;
  headers_json: string; payload_json: string;
}): EventRow {
  const info = db.prepare(`
    INSERT INTO events (route_id, source, headers_json, payload_json, status, next_attempt_at)
    VALUES (@route_id, @source, @headers_json, @payload_json, 'received', @now)
  `).run({ ...e, now: Date.now() });
  return getEvent(Number(info.lastInsertRowid))!;
}

export function getEvent(id: number): EventRow | undefined {
  return db.prepare(`
    SELECT e.*, r.slug AS route_slug FROM events e
    JOIN routes r ON r.id = e.route_id
    WHERE e.id = ?
  `).get(id) as EventRow | undefined;
}

export function listEvents(opts: { routeId?: number; before?: number; limit?: number } = {}): EventRow[] {
  return db.prepare(`
    SELECT e.*, r.slug AS route_slug FROM events e
    JOIN routes r ON r.id = e.route_id
    WHERE (@routeId IS NULL OR e.route_id = @routeId)
      AND (@before IS NULL OR e.id < @before)
    ORDER BY e.id DESC
    LIMIT @limit
  `).all({
    routeId: opts.routeId ?? null,
    before: opts.before ?? null,
    limit: opts.limit ?? 50,
  }) as unknown as EventRow[];
}

export function dueEvents(now: number, limit = 20): EventRow[] {
  return db.prepare(`
    SELECT e.*, r.slug AS route_slug FROM events e
    JOIN routes r ON r.id = e.route_id
    WHERE e.status IN ('received', 'failed') AND e.next_attempt_at <= ?
    ORDER BY e.next_attempt_at
    LIMIT ?
  `).all(now, limit) as unknown as EventRow[];
}

export function saveTransformed(id: number, transformedJson: string): void {
  db.prepare('UPDATE events SET transformed_json = ? WHERE id = ?').run(transformedJson, id);
}

export function markDelivered(id: number, attemptCount: number): void {
  db.prepare(`UPDATE events SET status='delivered', attempt_count=?, next_attempt_at=NULL WHERE id=?`)
    .run(attemptCount, id);
}

export function scheduleRetry(id: number, attemptCount: number, nextAttemptAt: number): void {
  db.prepare(`UPDATE events SET status='failed', attempt_count=?, next_attempt_at=? WHERE id=?`)
    .run(attemptCount, nextAttemptAt, id);
}

export function markDead(id: number, attemptCount: number): void {
  db.prepare(`UPDATE events SET status='dead', attempt_count=?, next_attempt_at=NULL WHERE id=?`)
    .run(attemptCount, id);
}

export function requeueEvent(id: number): void {
  db.prepare(`UPDATE events SET status='received', attempt_count=0, next_attempt_at=? WHERE id=?`)
    .run(Date.now(), id);
}

// ── attempts ───────────────────────────────────────────────────────

export function insertAttempt(a: {
  event_id: number; attempt_no: number;
  status_code?: number | null; response_body?: string | null; error?: string | null;
}): void {
  db.prepare(`
    INSERT INTO attempts (event_id, attempt_no, status_code, response_body, error)
    VALUES (@event_id, @attempt_no, @status_code, @response_body, @error)
  `).run({
    event_id: a.event_id,
    attempt_no: a.attempt_no,
    status_code: a.status_code ?? null,
    response_body: a.response_body ?? null,
    error: a.error ?? null,
  });
}

export function attemptsForEvent(eventId: number): Attempt[] {
  return db.prepare('SELECT * FROM attempts WHERE event_id = ? ORDER BY id').all(eventId) as unknown as Attempt[];
}

// ── status / meta ──────────────────────────────────────────────────

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function deleteMeta(key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

// ── users ──────────────────────────────────────────────────────────

export interface User {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

export type PublicUser = Omit<User, 'password_hash'>;

export function listUsers(): PublicUser[] {
  return db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all() as unknown as PublicUser[];
}

export function getUser(id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
}

export function createUser(username: string, passwordHash: string): PublicUser {
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  const { password_hash: _ph, ...user } = getUser(Number(info.lastInsertRowid))!;
  return user;
}

export function updateUserPassword(id: number, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

export function deleteUser(id: number): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export interface RouteStatus {
  id: number; slug: string; name: string; active: number;
  last_received_at: string | null;
  received_24h: number; delivered_24h: number; dead_24h: number;
  pending: number; dead_total: number;
}

export function statusSummary(): RouteStatus[] {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.active,
      (SELECT MAX(received_at) FROM events WHERE route_id = r.id) AS last_received_at,
      (SELECT COUNT(*) FROM events WHERE route_id = r.id AND received_at >= datetime('now','-1 day')) AS received_24h,
      (SELECT COUNT(*) FROM events WHERE route_id = r.id AND status = 'delivered' AND received_at >= datetime('now','-1 day')) AS delivered_24h,
      (SELECT COUNT(*) FROM events WHERE route_id = r.id AND status = 'dead' AND received_at >= datetime('now','-1 day')) AS dead_24h,
      (SELECT COUNT(*) FROM events WHERE route_id = r.id AND status IN ('received','failed')) AS pending,
      (SELECT COUNT(*) FROM events WHERE route_id = r.id AND status = 'dead') AS dead_total
    FROM routes r ORDER BY r.id
  `).all() as unknown as RouteStatus[];
}
