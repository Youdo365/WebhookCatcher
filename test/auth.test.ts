import { test } from 'node:test';
import assert from 'node:assert/strict';

// Point the DB at a throwaway location BEFORE importing anything that opens it.
process.env.DATA_DIR = `/tmp/whc-auth-test-${process.pid}`;
process.env.ADMIN_PASSWORD = 'correct horse battery staple';

const { initAuth, verifyLogin, createSessionToken, verifySessionToken, hashPassword } =
  await import('../src/core/auth.js');
const repo = await import('../src/db/repo.js');

const silentLog = { info: () => {}, warn: () => {} };
initAuth(silentLog);

test('ADMIN_PASSWORD creates the admin user; login verifies credentials', () => {
  const user = verifyLogin('admin', 'correct horse battery staple');
  assert.ok(user);
  assert.equal(user.username, 'admin');
  assert.equal(verifyLogin('admin', 'wrong'), null);
  assert.equal(verifyLogin('ghost', 'correct horse battery staple'), null);
});

test('session token round-trips to the user id', () => {
  const admin = repo.getUserByUsername('admin')!;
  const token = createSessionToken(admin.id);
  assert.equal(verifySessionToken(token), admin.id);
});

test('tampered or malformed tokens are rejected', () => {
  const admin = repo.getUserByUsername('admin')!;
  const token = createSessionToken(admin.id);
  const [uid, expires, mac] = token.split('.');
  assert.equal(verifySessionToken(`${uid}.${Number(expires) + 9999999}.${mac}`), null); // forged expiry
  assert.equal(verifySessionToken(`${Number(uid) + 1}.${expires}.${mac}`), null); // forged user
  assert.equal(verifySessionToken(`${uid}.${expires}.${'0'.repeat(mac.length)}`), null); // forged mac
  assert.equal(verifySessionToken('garbage'), null);
  assert.equal(verifySessionToken(undefined), null);
});

test('deleting a user revokes their valid sessions', () => {
  const temp = repo.createUser('temp-user', hashPassword('temporary-pass'));
  const token = createSessionToken(temp.id);
  assert.equal(verifySessionToken(token), temp.id);
  repo.deleteUser(temp.id);
  assert.equal(verifySessionToken(token), null);
});

test('user CRUD basics', () => {
  const before = repo.countUsers();
  const u = repo.createUser('roy', hashPassword('password123'));
  assert.equal(repo.countUsers(), before + 1);
  assert.ok(verifyLogin('roy', 'password123'));
  repo.updateUserPassword(u.id, hashPassword('newpassword1'));
  assert.equal(verifyLogin('roy', 'password123'), null);
  assert.ok(verifyLogin('roy', 'newpassword1'));
  repo.deleteUser(u.id);
  assert.equal(repo.getUserByUsername('roy'), undefined);
});
