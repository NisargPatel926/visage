import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Application-layer encryption for the handful of fields that are dangerous on
 * their own: SSN, A-number, passport number.
 *
 * These are encrypted separately from the row so that a database dump — a
 * backup, a replica, a support export — does not carry them in the clear.
 */
const FIELD_INFO = Buffer.from('visage-field-key');

function fieldKey(firmKeyId: string): Buffer {
  const master = process.env.KMS_LOCAL_MASTER_KEY ?? '';
  if (master.length < 32) throw new Error('KMS_LOCAL_MASTER_KEY must be at least 32 bytes');
  return Buffer.from(hkdfSync('sha256', Buffer.from(master), Buffer.from(firmKeyId), FIELD_INFO, 32));
}

export function encryptField(value: string, firmKeyId: string): string {
  const key = fieldKey(firmKeyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  key.fill(0);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptField(encoded: string, firmKeyId: string): string {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length <= 28) throw new Error('field ciphertext is malformed');
  const key = fieldKey(firmKeyId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } finally {
    key.fill(0);
  }
}

/**
 * Deterministic index for equality search over an encrypted field.
 *
 * Peppered separately from the field key on purpose: if the field key leaks,
 * the index still resists a dictionary attack, and vice versa. It is
 * deterministic by necessity, so it does reveal equality — two clients with the
 * same passport number produce the same index. That is the accepted cost of
 * being able to search at all, and it is why only identifiers get one.
 */
export function blindIndex(value: string, firmKeyId: string): string {
  const pepper = process.env.BLIND_INDEX_PEPPER ?? '';
  if (!pepper) throw new Error('BLIND_INDEX_PEPPER is not set');
  return createHmac('sha256', `${pepper}:${firmKeyId}`)
    .update(value.trim().toLowerCase())
    .digest('hex');
}

export function blindIndexMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
