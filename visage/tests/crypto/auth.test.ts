import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/server/auth/password';
import { generateTotpSecret, verifyTotp } from '../../src/server/auth/totp';
import { generateSessionToken, hashSessionToken } from '../../src/server/auth/session';
import { TOTP, Secret } from 'otpauth';

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h)).toBe(false);
  });

  it('salts, so identical passwords hash differently', async () => {
    expect(await hashPassword('correct horse battery'))
      .not.toBe(await hashPassword('correct horse battery'));
  });

  it('rejects short passwords at the hashing boundary', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });

  it('treats a corrupted hash as a failed login, not an error', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
  });
});

describe('TOTP', () => {
  it('accepts a current code and rejects a wrong one', () => {
    const secret = generateTotpSecret();
    const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

    expect(verifyTotp(secret, code)).not.toBeNull();
    expect(verifyTotp(secret, '000000')).toBeNull();
  });

  it('rejects malformed input without consulting the secret', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, 'abcdef')).toBeNull();
    expect(verifyTotp(secret, '12345')).toBeNull();
  });

  it('returns the step so the caller can prevent replay', () => {
    const secret = generateTotpSecret();
    const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    expect(typeof verifyTotp(secret, code)).toBe('number');
  });
});

describe('session tokens', () => {
  it('are unique and high-entropy', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateSessionToken));
    expect(tokens.size).toBe(100);
    expect(generateSessionToken().length).toBeGreaterThanOrEqual(43);
  });

  it('are stored hashed, so a database read is not a usable credential', () => {
    const token = generateSessionToken();
    const stored = hashSessionToken(token);
    expect(stored).not.toBe(token);
    expect(stored).toHaveLength(64);
    expect(hashSessionToken(token)).toBe(stored);
  });
});
