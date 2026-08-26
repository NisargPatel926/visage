import { Secret, TOTP } from 'otpauth';

const ISSUER = 'Visage';

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secret: string, email: string, firmName: string): string {
  return new TOTP({
    issuer: `${ISSUER} (${firmName})`,
    label: email,
    algorithm: 'SHA1', // authenticator apps are near-universal on SHA1
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).toString();
}

/**
 * `window: 1` accepts the adjacent 30-second steps, tolerating clock drift.
 * Wider windows meaningfully enlarge the guessing surface.
 *
 * Replay is not handled here: the caller must record the accepted step and
 * refuse to reuse it, or a code stays valid for its whole period.
 */
export function verifyTotp(secret: string, token: string): number | null {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return null;
  const delta = new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).validate({ token: cleaned, window: 1 });
  return delta === null ? null : Math.floor(Date.now() / 30_000) + delta;
}
