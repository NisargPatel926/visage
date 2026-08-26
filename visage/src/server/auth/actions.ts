'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Role } from '@prisma/client';
import { prisma } from '../db/client';
import { verifyPassword } from './password';
import { SESSION_COOKIE, createSession, revokeSession } from './currentUser';
import { ABSOLUTE_SESSION_LIFETIME_MS } from './session';

export interface LoginState {
  error?: string;
}

/**
 * Sign in against a firm.
 *
 * Login is firm-scoped by slug because email is unique per firm, not globally —
 * the same person can be a client of two firms. The firm is resolved through
 * app.resolve_firm(), the one narrow SECURITY DEFINER hole that exists because
 * we cannot scope a query to a tenant we have not identified yet.
 */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const slug = String(formData.get('firm') ?? '').trim().toLowerCase();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  // One message for every failure mode. Distinguishing "no such firm" from
  // "wrong password" hands an attacker a membership oracle.
  const failed: LoginState = { error: 'That firm, email, or password is not right.' };
  if (!slug || !email || !password) return failed;

  const firms = await prisma.$queryRaw<Array<{ id: string }>>`
    select id from app.resolve_firm(${slug})
  `;
  const firm = firms[0];
  if (!firm) return failed;

  // app.auth_find_user, not prisma.user.findFirst: this runs before any tenant
  // context exists, so an ordinary query is filtered to zero rows by RLS and
  // login could never succeed.
  const users = await prisma.$queryRaw<Array<{
    id: string; firm_id: string; role: Role; status: string; password_hash: string;
  }>>`select * from app.auth_find_user(${firm.id}::uuid, ${email})`;

  const user = users[0];
  if (!user || user.status !== 'ACTIVE') return failed;
  if (!(await verifyPassword(password, user.password_hash))) return failed;

  const token = await createSession({ id: user.id, firmId: user.firm_id });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ABSOLUTE_SESSION_LIFETIME_MS / 1000,
  });

  redirect(user.role === 'CLIENT' ? '/portal' : '/console');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
