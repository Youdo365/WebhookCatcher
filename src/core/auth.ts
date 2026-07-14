import crypto from 'node:crypto';
import * as repo from '../db/repo.js';

const PASSWORD_KEY = 'admin_password_hash'; // "salthex:hashhex"
const SECRET_KEY = 'session_secret';
export const COOKIE_NAME = 'wc_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

let sessionSecret = '';

interface AuthLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Boot-time setup. The password comes from ADMIN_PASSWORD (hashed and stored,
 * so it also updates an existing one), or is generated once on first start
 * and printed to the logs. The session-signing secret persists in the DB so
 * logins survive restarts.
 */
export function initAuth(log: AuthLog): void {
  let secret = repo.getMeta(SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    repo.setMeta(SECRET_KEY, secret);
  }
  sessionSecret = secret;

  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword) {
    repo.setMeta(PASSWORD_KEY, hashPassword(envPassword));
    log.info('auth: admin password set from ADMIN_PASSWORD env var');
  } else if (!repo.getMeta(PASSWORD_KEY)) {
    const generated = crypto.randomBytes(9).toString('base64url');
    repo.setMeta(PASSWORD_KEY, hashPassword(generated));
    log.warn(`auth: no ADMIN_PASSWORD set — generated initial password: ${generated} (shown only once; set ADMIN_PASSWORD to choose your own)`);
  }
}

export function verifyPassword(password: string): boolean {
  const stored = repo.getMeta(PASSWORD_KEY);
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
}

/** Token format: "<expiryEpochMs>.<hmac>" — stateless, verified by signature. */
export function createSessionToken(): string {
  const expires = String(Date.now() + SESSION_TTL_SECONDS * 1000);
  return `${expires}.${sign(expires)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token || !sessionSecret) return false;
  const [expires, mac] = token.split('.');
  if (!expires || !mac) return false;
  const expected = sign(expires);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))) return false;
  return Number(expires) > Date.now();
}

export function sessionFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}
