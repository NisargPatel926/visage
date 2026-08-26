import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/server/db/client';
import { hashSessionToken, generateSessionToken } from '../../src/server/auth/session';
import { reseed, type Seed } from '../fixtures';

/**
 * The authentication surface.
 *
 * Auth is pre-tenant by nature: a user must be found before we know the tenant,
 * and a session read before we know who is asking. RLS correctly refuses both,
 * so a small set of SECURITY DEFINER functions exists to serve exactly those
 * lookups. Because they bypass RLS, what they can reach is itself an invariant
 * worth testing.
 */
let s: Seed;
beforeAll(async () => { s = await reseed(); });

describe('firm resolution', () => {
  it('finds a firm by slug with no tenant context', async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      select * from app.resolve_firm('alpha')`;
    expect(rows[0]?.id).toBe(s.firmA.id);
  });

  it('returns nothing for an unknown slug', async () => {
    const rows = await prisma.$queryRaw`select * from app.resolve_firm('nope')`;
    expect(rows).toHaveLength(0);
  });
});

describe('user lookup', () => {
  it('finds a user by firm and email', async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string; firm_id: string }>>`
      select * from app.auth_find_user(${s.firmA.id}::uuid, 'client1@alpha.test')`;
    expect(rows[0]?.id).toBe(s.firmA.client1.userId);
  });

  it('is case-insensitive on email', async () => {
    const rows = await prisma.$queryRaw`
      select * from app.auth_find_user(${s.firmA.id}::uuid, 'CLIENT1@ALPHA.TEST')`;
    expect(rows).toHaveLength(1);
  });

  it("will not find a user through another firm's id", async () => {
    // Email is unique per firm, not globally — the same person can hold an
    // account at two firms, and a lookup must never cross between them.
    const rows = await prisma.$queryRaw`
      select * from app.auth_find_user(${s.firmB.id}::uuid, 'client1@alpha.test')`;
    expect(rows).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('creates, finds, and revokes', async () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    const expires = new Date(Date.now() + 3600_000);

    await prisma.$executeRaw`select app.auth_create_session(
      ${s.firmA.id}::uuid, ${s.firmA.client1.userId}::uuid, ${hash},
      ${expires}::timestamptz, null, null)`;

    const found = await prisma.$queryRaw<Array<{ user_id: string; revoked_at: Date | null }>>`
      select * from app.auth_find_session(${hash})`;
    expect(found[0]?.user_id).toBe(s.firmA.client1.userId);
    expect(found[0]?.revoked_at).toBeNull();

    await prisma.$executeRaw`select app.auth_revoke_session(${hash})`;
    const after = await prisma.$queryRaw<Array<{ revoked_at: Date | null }>>`
      select * from app.auth_find_session(${hash})`;
    expect(after[0]?.revoked_at).not.toBeNull();
  });

  it('finds nothing for an unknown token', async () => {
    const rows = await prisma.$queryRaw`
      select * from app.auth_find_session(${hashSessionToken('not-a-real-token')})`;
    expect(rows).toHaveLength(0);
  });

  it('a session row is not readable through ordinary queries without context', async () => {
    expect(await prisma.session.findMany()).toHaveLength(0);
  });
});

describe('containment of the privileged role', () => {
  it('visage_directory cannot reach case data', async () => {
    // It bypasses RLS, so its table grants are the only thing bounding it.
    // Nothing here may touch a case, document, message, or audit row.
    // Read from pg_class.relacl, not information_schema.table_privileges:
    // that view only exposes grants involving the *current* user, so as
    // visage_app it comes back empty and the assertion would pass vacuously.
    const rows = await prisma.$queryRaw<Array<{ relname: string }>>`
      select distinct c.relname
      from pg_class c, aclexplode(c.relacl) a
      where a.grantee = 'visage_directory'::regrole
        and c.relnamespace = 'public'::regnamespace
        and c.relkind = 'r'
    `;
    expect(rows.map((r) => r.relname).sort()).toEqual(['Firm', 'Session', 'User']);
  });

  it('visage_directory cannot log in', async () => {
    const rows = await prisma.$queryRaw<Array<{ rolcanlogin: boolean; rolbypassrls: boolean }>>`
      select rolcanlogin, rolbypassrls from pg_roles where rolname = 'visage_directory'`;
    expect(rows[0]?.rolcanlogin).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(true);
  });

  it('the auth functions are not executable by PUBLIC', async () => {
    const fns = [
      'app.auth_find_user(uuid, text)',
      'app.auth_find_session(text)',
      'app.auth_create_session(uuid, uuid, text, timestamptz, text, text)',
      'app.auth_revoke_session(text)',
      'app.resolve_firm(text)',
    ];
    for (const fn of fns) {
      const rows = await prisma.$queryRaw<Array<{ pub: boolean; app: boolean }>>`
        select has_function_privilege('public', ${fn}, 'EXECUTE') as pub,
               has_function_privilege('visage_app', ${fn}, 'EXECUTE') as app`;
      expect(rows[0]?.pub, `${fn} is executable by PUBLIC`).toBe(false);
      expect(rows[0]?.app, `${fn} is not executable by visage_app`).toBe(true);
    }
  });
});
