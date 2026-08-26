import { PrismaClient } from '@prisma/client';

/**
 * The application's database handle.
 *
 * DATABASE_URL must point at the `visage_app` role, which is NOBYPASSRLS and
 * owns no tables. Pointing it at `visage_owner` would still be subject to
 * policies (every table is FORCE ROW LEVEL SECURITY), but it would grant DDL
 * rights the request path has no business holding.
 */
declare global {
  // eslint-disable-next-line no-var
  var __visagePrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__visagePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalThis.__visagePrisma = prisma;
