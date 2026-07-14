import { test } from 'node:test';
import assert from 'node:assert/strict';

// Point the DB at a throwaway location BEFORE importing anything that opens it.
process.env.DATA_DIR = `/tmp/whc-auth-test-${process.pid}`;
process.env.ADMIN_PASSWORD = 'correct horse battery staple';

const { initAuth, verifyPassword, createSessionToken, verifySessionToken } =
  await import('../src/core/auth.js');

const silentLog = { info: () => {}, warn: () => {} };

test('password from ADMIN_PASSWORD verifies, wrong password does not', () => {
  initAuth(silentLog);
  assert.equal(verifyPassword('correct horse battery staple'), true);
  assert.equal(verifyPassword('wrong'), false);
  assert.equal(verifyPassword(''), false);
});

test('session token round-trips', () => {
  initAuth(silentLog);
  const token = createSessionToken();
  assert.equal(verifySessionToken(token), true);
});

test('tampered or malformed tokens are rejected', () => {
  initAuth(silentLog);
  const token = createSessionToken();
  const [expires, mac] = token.split('.');
  assert.equal(verifySessionToken(`${Number(expires) + 9999999}.${mac}`), false); // forged expiry
  assert.equal(verifySessionToken(`${expires}.${'0'.repeat(mac.length)}`), false); // forged mac
  assert.equal(verifySessionToken('garbage'), false);
  assert.equal(verifySessionToken(undefined), false);
});

test('expired tokens are rejected', () => {
  initAuth(silentLog);
  // A token whose expiry is in the past fails even with a valid signature shape.
  const past = String(Date.now() - 1000);
  const forged = `${past}.deadbeef`;
  assert.equal(verifySessionToken(forged), false);
});
