import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id baseline. Tuned to ~50ms on a modern server;
// revisit alongside the hosting decision, since these numbers are only
// meaningful relative to the hardware they run on.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// `async` so the length check rejects rather than throwing synchronously —
// otherwise a caller awaiting this would still need a surrounding try/catch.
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) throw new Error('password must be at least 12 characters');
  return hash(plain, OPTIONS);
}

/**
 * Returns false rather than throwing on a malformed hash: a corrupted row
 * should read as "wrong password", not as a 500 that tells an attacker they
 * found something interesting.
 */
export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
