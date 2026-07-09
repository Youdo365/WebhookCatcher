import crypto from 'node:crypto';

const SIGNATURE_HEADERS = ['x-hub-signature-256', 'x-signature', 'x-webhook-signature'];

/**
 * HMAC-SHA256 signature check (GitHub/Stripe style). The sender must put
 * hex(hmac_sha256(secret, rawBody)) — optionally prefixed with "sha256=" —
 * in one of the common signature headers.
 */
export function verifySignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  for (const name of SIGNATURE_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) continue;
    const given = value.replace(/^sha256=/, '').trim();
    if (given.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return true;
    }
  }
  return false;
}
