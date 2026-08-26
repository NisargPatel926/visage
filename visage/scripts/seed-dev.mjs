#!/usr/bin/env node
/**
 * Development fixtures: one firm, one attorney, one client, one empty case.
 *
 *   node scripts/seed-dev.mjs
 *
 * Connects as superuser because every table is FORCE ROW LEVEL SECURITY — even
 * the owner role cannot insert without first assuming a tenant identity.
 * Refuses to run against NODE_ENV=production; the passwords below are public.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m?.[1]) process.env[m[1]] ??= (m[2] ?? '').replace(/^["']|["']$/g, '');
}

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to seed known-password accounts in production');
  process.exit(1);
}

const { PrismaClient } = await import('@prisma/client');
const { hash } = await import('@node-rs/argon2');

const db = new PrismaClient({
  datasources: { db: { url: process.env.TEST_ADMIN_DATABASE_URL } },
});

const PASSWORD = 'visage-dev-password';
const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

const firm = await db.firm.upsert({
  where: { slug: 'alpha' },
  update: {},
  create: { name: 'Alpha Immigration Law', slug: 'alpha', kmsKeyId: 'local:alpha' },
});

const mkUser = (email, role) =>
  db.user.upsert({
    where: { firmId_email: { firmId: firm.id, email } },
    update: { passwordHash, status: 'ACTIVE' },
    create: { firmId: firm.id, email, role, passwordHash, status: 'ACTIVE' },
  });

const attorney = await mkUser('attorney@alpha.test', 'ATTORNEY');
const client = await mkUser('client@alpha.test', 'CLIENT');

const existing = await db.case.findFirst({ where: { firmId: firm.id, caseNumber: 'A-1001' } });
const kase = existing ?? await db.case.create({
  data: {
    firmId: firm.id, caseNumber: 'A-1001', category: 'FAMILY_AOS',
    leadAttorneyId: attorney.id, status: 'INTAKE',
  },
});

await db.caseMember.upsert({
  where: { caseId_userId: { caseId: kase.id, userId: client.id } },
  update: {},
  create: { caseId: kase.id, firmId: firm.id, userId: client.id, role: 'PRIMARY_APPLICANT' },
});
await db.caseMember.upsert({
  where: { caseId_userId: { caseId: kase.id, userId: attorney.id } },
  update: {},
  create: { caseId: kase.id, firmId: firm.id, userId: attorney.id, role: 'STAFF' },
});

console.log(`
Seeded.

  Firm code   alpha
  Client      client@alpha.test
  Attorney    attorney@alpha.test
  Password    ${PASSWORD}
`);
await db.$disconnect();
