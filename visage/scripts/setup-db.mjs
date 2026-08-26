#!/usr/bin/env node
/**
 * Bootstrap a Visage database from nothing.
 *
 *   node scripts/setup-db.mjs
 *
 * Idempotent. Runs three steps that must happen in this order:
 *   1. roles.sql  — create visage_owner / visage_app (as superuser)
 *   2. prisma db push — create tables (as visage_owner, the table owner)
 *   3. rls.sql    — enable, FORCE, and define policies (as visage_owner)
 *
 * Step 3 cannot be folded into the Prisma schema: Prisma has no concept of a
 * policy, so the security model would silently vanish on the next `db push`
 * if it were not applied separately and verified afterwards.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (!existsSync(envPath)) {
  console.error('.env not found — copy .env.example and adjust');
  process.exit(1);
}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m?.[1]) process.env[m[1]] ??= (m[2] ?? '').replace(/^["']|["']$/g, '');
}

const { ADMIN_DATABASE_URL, MIGRATE_DATABASE_URL, TEST_ADMIN_DATABASE_URL } = process.env;
for (const [k, v] of Object.entries({ ADMIN_DATABASE_URL, MIGRATE_DATABASE_URL, TEST_ADMIN_DATABASE_URL })) {
  if (!v) { console.error(`${k} is not set`); process.exit(1); }
}

// Prisma URLs carry `?schema=`, which libpq rejects as an invalid query
// parameter. Strip the query string before handing a URL to psql.
const pgUrl = (url) => {
  const u = new URL(url);
  u.search = '';
  return u.toString();
};

const psql = (url, file) =>
  execFileSync('psql', [pgUrl(url), '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], { stdio: 'inherit' });

const dbName = new URL(TEST_ADMIN_DATABASE_URL).pathname.slice(1);

console.log('1/3  roles and grants');
psql(ADMIN_DATABASE_URL, 'prisma/sql/roles.sql');
try {
  execFileSync('psql', [pgUrl(ADMIN_DATABASE_URL), '-q', '-v', 'ON_ERROR_STOP=1', '-c',
    `create database ${dbName} owner visage_owner`], { stdio: 'pipe' });
  console.log(`     created database ${dbName}`);
} catch (err) {
  // Only "already exists" is benign. Swallowing everything here once hid a
  // malformed connection URL and made step 2 fail with an unrelated message.
  const stderr = String(err.stderr ?? '');
  if (!/already exists/.test(stderr)) {
    console.error(stderr || err.message);
    process.exit(1);
  }
  console.log(`     database ${dbName} already exists`);
}
psql(TEST_ADMIN_DATABASE_URL, 'prisma/sql/roles.sql');

console.log('2/3  schema');
execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: MIGRATE_DATABASE_URL },
});

console.log('3/3  row-level security');
psql(MIGRATE_DATABASE_URL, 'prisma/sql/rls.sql');

// A schema push that quietly dropped the policies is the failure mode this
// guards against — the app would keep working and stop isolating.
const check = execFileSync('psql', [pgUrl(TEST_ADMIN_DATABASE_URL), '-tAc', `
  select count(*) from pg_class c
  where c.relnamespace='public'::regnamespace and c.relkind='r'
    and c.relname <> '_prisma_migrations'
    and (not c.relrowsecurity or not c.relforcerowsecurity
         or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
`]).toString().trim();

if (check !== '0') {
  console.error(`\nFAIL: ${check} table(s) lack RLS, FORCE, or a policy.`);
  process.exit(1);
}
console.log('\nOK — every tenant table has RLS enabled, forced, and policied.');
