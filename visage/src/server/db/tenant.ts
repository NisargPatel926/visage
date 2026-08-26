import type { Prisma, Role } from '@prisma/client';
import { prisma } from './client';

/**
 * Who is asking. Built from the authenticated session and nothing else — never
 * from a request body, query parameter, or header.
 */
export interface AuthContext {
  userId: string;
  firmId: string;
  role: Role;
}

export type TenantClient = Prisma.TransactionClient;

const STAFF_ROLES: ReadonlySet<Role> = new Set(['OWNER', 'ATTORNEY', 'PARALEGAL'] as Role[]);
export const isStaff = (ctx: AuthContext): boolean => STAFF_ROLES.has(ctx.role);

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * The three `set_config(..., true)` calls are transaction-local, so the
 * settings vanish when the transaction ends and a connection handed back to the
 * pool carries no tenant identity. Postgres policies read these settings; if
 * they are absent the helper functions return NULL and every policy evaluates
 * false, so an unscoped query returns nothing rather than everything.
 *
 * Passing values as bind parameters (not string interpolation) is what keeps
 * `set_config` from becoming an injection point of its own.
 */
export async function withTenant<T>(
  ctx: AuthContext,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select set_config('app.firm_id', ${ctx.firmId}, true)`;
    await tx.$executeRaw`select set_config('app.user_id', ${ctx.userId}, true)`;
    await tx.$executeRaw`select set_config('app.role', ${ctx.role}, true)`;
    return fn(tx);
  });
}

/**
 * Resolve a firm by slug before any tenant context exists — the one query the
 * login flow needs and RLS cannot serve. Backed by a SECURITY DEFINER function
 * that returns three non-sensitive columns and nothing else.
 */
export async function resolveFirmBySlug(
  slug: string,
): Promise<{ id: string; name: string; slug: string } | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; slug: string }>>`
    select * from app.resolve_firm(${slug})
  `;
  return rows[0] ?? null;
}
