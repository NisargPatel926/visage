import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/server/db/client';
import { resolveFirmBySlug, withTenant } from '../../src/server/db/tenant';
import { reseed, type Seed } from '../fixtures';

/**
 * The Phase 0 acceptance gate.
 *
 * Everything here runs through `visage_app` (NOBYPASSRLS, owns nothing). The
 * suite is adversarial by design: each test asks for data the actor must not
 * have, and asserts it comes back empty or rejected. A test that only checks
 * the happy path proves nothing about isolation.
 */
let s: Seed;
beforeAll(async () => { s = await reseed(); });

describe('firm ↔ firm isolation', () => {
  it("staff see only their own firm's cases", async () => {
    const a = await withTenant(s.firmA.attorney, (tx) => tx.case.findMany());
    const b = await withTenant(s.firmB.attorney, (tx) => tx.case.findMany());

    expect(a.map((c) => c.caseNumber).sort()).toEqual(['A-001', 'A-002']);
    expect(b.map((c) => c.caseNumber)).toEqual(['B-001']);
  });

  it("a direct lookup of another firm's case by id returns null", async () => {
    // The dangerous shape: the id is known (leaked, guessed, or from a URL) and
    // the query does not filter by firm. RLS has to be what stops this.
    const found = await withTenant(s.firmB.attorney, (tx) =>
      tx.case.findUnique({ where: { id: s.firmA.case1 } }),
    );
    expect(found).toBeNull();
  });

  it("another firm's documents are invisible by id and by list", async () => {
    const byId = await withTenant(s.firmB.attorney, (tx) =>
      tx.document.findUnique({ where: { id: s.firmA.doc1 } }),
    );
    const all = await withTenant(s.firmB.attorney, (tx) => tx.document.findMany());

    expect(byId).toBeNull();
    expect(all.map((d) => d.filename)).toEqual(['passport-b1.pdf']);
  });

  it('privileged messages do not cross firms', async () => {
    const msgs = await withTenant(s.firmB.attorney, (tx) => tx.message.findMany());
    expect(msgs).toHaveLength(0);
  });

  it("updating another firm's case affects zero rows", async () => {
    const { count } = await withTenant(s.firmB.attorney, (tx) =>
      tx.case.updateMany({ where: { id: s.firmA.case1 }, data: { status: 'APPROVED' } }),
    );
    expect(count).toBe(0);

    const still = await withTenant(s.firmA.attorney, (tx) =>
      tx.case.findUnique({ where: { id: s.firmA.case1 } }),
    );
    expect(still?.status).toBe('INTAKE');
  });

  it("deleting another firm's document affects zero rows", async () => {
    const { count } = await withTenant(s.firmB.attorney, (tx) =>
      tx.document.deleteMany({ where: { id: s.firmA.doc1 } }),
    );
    expect(count).toBe(0);
    expect(
      await withTenant(s.firmA.attorney, (tx) =>
        tx.document.findUnique({ where: { id: s.firmA.doc1 } }),
      ),
    ).not.toBeNull();
  });

  it('a row cannot be written into another firm (WITH CHECK)', async () => {
    await expect(
      withTenant(s.firmB.attorney, (tx) =>
        tx.case.create({
          data: {
            firmId: s.firmA.id, // the attack: correct shape, wrong tenant
            caseNumber: 'SMUGGLED-001',
            category: 'FAMILY_AOS',
            leadAttorneyId: s.firmB.attorney.userId,
          },
        }),
      ),
    ).rejects.toThrow();

    const leaked = await withTenant(s.firmA.attorney, (tx) =>
      tx.case.findMany({ where: { caseNumber: 'SMUGGLED-001' } }),
    );
    expect(leaked).toHaveLength(0);
  });

  it('a document cannot be attached to a case in another firm', async () => {
    // Belt and braces: the composite FK (caseId, firmId) -> Case(id, firmId)
    // rejects this even before RLS gets a say.
    await expect(
      withTenant(s.firmB.attorney, (tx) =>
        tx.document.create({
          data: {
            firmId: s.firmB.id,
            caseId: s.firmA.case1,
            uploaderId: s.firmB.attorney.userId,
            docType: 'PASSPORT_BIO',
            filename: 'smuggled.pdf',
            mimeType: 'application/pdf',
            byteSize: 1,
            sha256: 'b'.repeat(64),
            storageKey: 's3://x',
            dekWrapped: Buffer.from('w'),
            iv: Buffer.from('i'),
            authTag: Buffer.from('t'),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('client ↔ client isolation within one firm', () => {
  it('a client sees only cases they belong to', async () => {
    const cases = await withTenant(s.firmA.client1, (tx) => tx.case.findMany());
    expect(cases.map((c) => c.caseNumber)).toEqual(['A-001']);
  });

  it("a client cannot read a firm-mate's case by id", async () => {
    // Same firm, so the firmId check passes; only CaseMember stops this.
    const found = await withTenant(s.firmA.client1, (tx) =>
      tx.case.findUnique({ where: { id: s.firmA.case2 } }),
    );
    expect(found).toBeNull();
  });

  it("a client cannot read a firm-mate's documents", async () => {
    const byId = await withTenant(s.firmA.client1, (tx) =>
      tx.document.findUnique({ where: { id: s.firmA.doc2 } }),
    );
    const mine = await withTenant(s.firmA.client1, (tx) => tx.document.findMany());

    expect(byId).toBeNull();
    expect(mine.map((d) => d.filename)).toEqual(['passport-a1.pdf']);
  });

  it('a client sees only their own user row, not the firm roster', async () => {
    const users = await withTenant(s.firmA.client1, (tx) => tx.user.findMany());
    expect(users.map((u) => u.email)).toEqual(['client1@alpha.test']);
  });

  it('staff, by contrast, see the whole firm roster', async () => {
    const users = await withTenant(s.firmA.attorney, (tx) => tx.user.findMany());
    expect(users).toHaveLength(3);
  });

  it('a client cannot enumerate invitations', async () => {
    const invites = await withTenant(s.firmA.client1, (tx) => tx.invitation.findMany());
    expect(invites).toHaveLength(0);
  });

  it('a client cannot read the audit log', async () => {
    const events = await withTenant(s.firmA.client1, (tx) => tx.auditEvent.findMany());
    expect(events).toHaveLength(0);
  });

  it('a client cannot add themselves to another case', async () => {
    await expect(
      withTenant(s.firmA.client1, (tx) =>
        tx.caseMember.create({
          data: {
            caseId: s.firmA.case2,
            firmId: s.firmA.id,
            userId: s.firmA.client1.userId,
            role: 'PRIMARY_APPLICANT',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('fail-closed behaviour', () => {
  it('a query with no tenant context returns nothing', async () => {
    // Not an error — an empty set. This is the property that turns a forgotten
    // WHERE clause into a bug you notice rather than a breach you don't.
    const cases = await prisma.case.findMany();
    const docs = await prisma.document.findMany();
    const users = await prisma.user.findMany();

    expect(cases).toHaveLength(0);
    expect(docs).toHaveLength(0);
    expect(users).toHaveLength(0);
  });

  it('tenant context does not survive the transaction', async () => {
    await withTenant(s.firmA.attorney, async (tx) => {
      expect(await tx.case.findMany()).toHaveLength(2);
    });
    // Same pooled connection, next query: the SET LOCAL is gone.
    expect(await prisma.case.findMany()).toHaveLength(0);
  });

  it('the app role cannot bypass RLS', async () => {
    const [row] = await prisma.$queryRaw<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>`
      select rolbypassrls, rolsuper from pg_roles where rolname = current_user
    `;
    expect(row?.rolbypassrls).toBe(false);
    expect(row?.rolsuper).toBe(false);
  });

  it('every tenant table has RLS enabled AND forced', async () => {
    // FORCE is the half that is easy to omit and impossible to notice: without
    // it, the owner silently bypasses every policy.
    const rows = await prisma.$queryRaw<Array<{ relname: string; enabled: boolean; forced: boolean }>>`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      where c.relnamespace = 'public'::regnamespace
        and c.relkind = 'r'
        and c.relname <> '_prisma_migrations'
    `;
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => !r.enabled || !r.forced);
    expect(bad.map((r) => r.relname)).toEqual([]);
  });
});

describe('append-only audit log', () => {
  it('the app role holds no UPDATE or DELETE grant on AuditEvent', async () => {
    const [row] = await prisma.$queryRaw<Array<{ upd: boolean; del: boolean }>>`
      select has_table_privilege(current_user, '"AuditEvent"', 'UPDATE') as upd,
             has_table_privilege(current_user, '"AuditEvent"', 'DELETE') as del
    `;
    expect(row?.upd).toBe(false);
    expect(row?.del).toBe(false);
  });

  it('history rows are equally immutable', async () => {
    const [row] = await prisma.$queryRaw<Array<{ upd: boolean; del: boolean }>>`
      select has_table_privilege(current_user, '"ProfileFieldHistory"', 'UPDATE') as upd,
             has_table_privilege(current_user, '"ProfileFieldHistory"', 'DELETE') as del
    `;
    expect(row?.upd).toBe(false);
    expect(row?.del).toBe(false);
  });

  it('an attempted rewrite of an audit row is rejected', async () => {
    await expect(
      withTenant(s.firmA.attorney, (tx) =>
        tx.auditEvent.updateMany({ where: {}, data: { action: 'tampered' } }),
      ),
    ).rejects.toThrow();
  });

  it('staff can read their own firm audit log, and only that', async () => {
    const a = await withTenant(s.firmA.attorney, (tx) => tx.auditEvent.findMany());
    const b = await withTenant(s.firmB.attorney, (tx) => tx.auditEvent.findMany());
    expect(a.length).toBeGreaterThan(0);
    expect(b).toHaveLength(0);
  });
});

describe('login bootstrap', () => {
  it('resolves a firm by slug with no tenant context', async () => {
    // The one query that must work before a tenant identity exists.
    const firm = await resolveFirmBySlug('alpha');
    expect(firm?.id).toBe(s.firmA.id);
  });

  it('returns null for an unknown slug', async () => {
    expect(await resolveFirmBySlug('does-not-exist')).toBeNull();
  });

  it('exposes only non-sensitive columns — never kmsKeyId', async () => {
    const firm = await resolveFirmBySlug('alpha');
    expect(Object.keys(firm ?? {}).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('does not become a way to read Firm rows generally', async () => {
    // The Firm table itself stays closed without tenant context.
    expect(await prisma.firm.findMany()).toHaveLength(0);
  });
});

describe('audit log: append by anyone, read by staff', () => {
  it('a client can append to the audit log', async () => {
    // Client actions — uploads, answers — are exactly what must be recorded.
    // A staff-only write policy would silently drop them.
    const { audit } = await import('../../src/server/audit/log');
    await expect(
      withTenant(s.firmA.client1, (tx) =>
        audit(tx, s.firmA.client1, {
          action: 'document.uploaded', targetType: 'Document',
          targetId: s.firmA.doc1, caseId: s.firmA.case1,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('but cannot read it back', async () => {
    const { audit } = await import('../../src/server/audit/log');
    await withTenant(s.firmA.client1, (tx) =>
      audit(tx, s.firmA.client1, {
        action: 'document.uploaded', targetType: 'Document', targetId: s.firmA.doc1,
      }),
    );
    const seen = await withTenant(s.firmA.client1, (tx) => tx.auditEvent.findMany());
    expect(seen).toHaveLength(0);
  });

  it('and staff can see what the client wrote', async () => {
    // A distinct action, because this file seeds once (beforeAll) and the
    // tests above already wrote 'document.uploaded' rows.
    const { audit } = await import('../../src/server/audit/log');
    await withTenant(s.firmA.client1, (tx) =>
      audit(tx, s.firmA.client1, {
        action: 'document.downloaded', targetType: 'Document', targetId: s.firmA.doc1,
      }),
    );
    const seen = await withTenant(s.firmA.attorney, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'document.downloaded' } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.actorId).toBe(s.firmA.client1.userId);
  });
});
