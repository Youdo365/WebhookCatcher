import crypto from 'node:crypto';
import * as repo from '../db/repo.js';

const LEGACY_PASSWORD_KEY = 'admin_password_hash'; // pre-user-management single password
const SECRET_KEY = 'session_secret';
export const COOKIE_NAME = 'wc_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

let sessionSecret = '';

interface AuthLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

/**
 * Boot-time setup. Ensures the session-signing secret and at least one user:
 * - ADMIN_PASSWORD env var creates/updates the "admin" user.
 * - A pre-existing single-password install is migrated to the "admin" user.
 * - Otherwise a password is generated for "admin" and printed once.
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
    const admin = repo.getUserByUsername('admin');
    if (admin) repo.updateUserPassword(admin.id, hashPassword(envPassword));
    else repo.createUser('admin', hashPassword(envPassword));
    log.info('auth: "admin" password set from ADMIN_PASSWORD env var');
  }

  if (repo.countUsers() === 0) {
    const legacyHash = repo.getMeta(LEGACY_PASSWORD_KEY);
    if (legacyHash) {
      repo.createUser('admin', legacyHash);
      log.info('auth: migrated existing password to user "admin" — log in as admin with your current password');
    } else {
      const generated = crypto.randomBytes(9).toString('base64url');
      repo.createUser('admin', hashPassword(generated));
      log.warn(`auth: created user "admin" with generated password: ${generated} (shown only once; set ADMIN_PASSWORD to choose your own)`);
    }
  }
  repo.deleteMeta(LEGACY_PASSWORD_KEY);
}

export function verifyLogin(username: string, password: string): repo.PublicUser | null {
  const user = repo.getUserByUsername(username);
  if (!user || !passwordMatches(password, user.password_hash)) return null;
  const { password_hash: _ph, ...publicUser } = user;
  return publicUser;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
}

/** Token format: "<userId>.<expiryEpochMs>.<hmac>" — stateless except that the user must still exist. */
export function createSessionToken(userId: number): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_SECONDS * 1000}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the user id for a valid session, or null. Deleting a user revokes their sessions. */
export function verifySessionToken(token: string | undefined): number | null {
  if (!token || !sessionSecret) return null;
  const [userId, expires, mac] = token.split('.');
  if (!userId || !expires || !mac) return null;
  const expected = sign(`${userId}.${expires}`);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  if (Number(expires) <= Date.now()) return null;
  const id = Number(userId);
  return repo.getUser(id) ? id : null;
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
