import { createHash, randomBytes } from 'node:crypto';

/** 32 bytes of entropy, base64url. The raw value only ever lives in the cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Sessions are stored as a SHA-256 of the token, so a database read does not
 * yield a usable credential. Plain SHA-256 rather than argon2 is correct here:
 * the token is already high-entropy, so there is nothing to brute-force, and
 * session lookup happens on every request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Staff sessions are short because the console shows every client's documents.
export const STAFF_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const CLIENT_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
