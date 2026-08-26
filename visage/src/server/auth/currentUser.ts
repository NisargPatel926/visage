import { cookies } from 'next/headers';
import { prisma } from '../db/client';
import type { AuthContext } from '../db/tenant';
import type { Role } from '@prisma/client';
import {
  ABSOLUTE_SESSION_LIFETIME_MS, CLIENT_IDLE_TIMEOUT_MS, STAFF_IDLE_TIMEOUT_MS,
  generateSessionToken, hashSessionToken,
} from './session';

export const SESSION_COOKIE = 'visage_session';

interface SessionRow {
  user_id: string;
  firm_id: string;
  role: Role;
  status: string;
  expires_at: Date;
  last_seen: Date;
  revoked_at: Date | null;
}

/**
 * Resolve the caller from their session cookie.
 *
 * The only place an AuthContext is constructed. Nothing here reads a firm id or
 * a role from a request body, query parameter, or header — if it did, tenant
 * scoping would become caller-controlled and every RLS policy downstream would
 * be decoration.
 *
 * Goes through app.auth_find_session rather than Prisma because this runs
 * before any tenant context exists: an ordinary query would be filtered to zero
 * rows by the very policies that make the rest of the app safe.
 */
export async function currentUser(): Promise<AuthContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const rows = await prisma.$queryRaw<SessionRow[]>`
    select * from app.auth_find_session(${tokenHash})
  `;
  const s = rows[0];
  if (!s) return null;
  if (s.revoked_at) return null;
  if (s.status !== 'ACTIVE') return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;

  const idleLimit = s.role === 'CLIENT' ? CLIENT_IDLE_TIMEOUT_MS : STAFF_IDLE_TIMEOUT_MS;
  if (Date.now() - new Date(s.last_seen).getTime() > idleLimit) return null;

  // Sliding idle window; the absolute expiry set at login still caps it.
  await prisma.$executeRaw`select app.auth_touch_session(${tokenHash})`;

  return { userId: s.user_id, firmId: s.firm_id, role: s.role };
}

export async function createSession(
  user: { id: string; firmId: string },
  meta: { ip?: string; userAgent?: string } = {},
): Promise<string> {
  const token = generateSessionToken();
  const expires = new Date(Date.now() + ABSOLUTE_SESSION_LIFETIME_MS);
  await prisma.$executeRaw`
    select app.auth_create_session(
      ${user.firmId}::uuid, ${user.id}::uuid, ${hashSessionToken(token)},
      ${expires}::timestamptz, ${meta.ip ?? null}, ${meta.userAgent ?? null}
    )
  `;
  return token;
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.$executeRaw`select app.auth_revoke_session(${hashSessionToken(token)})`;
}
