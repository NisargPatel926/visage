import { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../src/server/db/tenant.js';

/**
 * Seeding connects as superuser, not as `visage_owner`.
 *
 * Every table is FORCE ROW LEVEL SECURITY, so the owner is subject to policies
 * too — it could not insert a fixture without first pretending to be a tenant,
 * which would make the fixtures depend on the very mechanism under test.
 */
export const admin = new PrismaClient({
  datasources: { db: { url: process.env.TEST_ADMIN_DATABASE_URL } },
});

export interface Seed {
  firmA: { id: string; attorney: AuthContext; client1: AuthContext; client2: AuthContext;
           case1: string; case2: string; doc1: string; doc2: string; thread1: string };
  firmB: { id: string; attorney: AuthContext; client1: AuthContext;
           case1: string; doc1: string };
}

const PW = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$fakehashfortestsonly';

export async function reseed(): Promise<Seed> {
  // Order matters only for readability; Cascade handles the graph.
  await admin.$executeRawUnsafe(`
    truncate table "AuditEvent","Package","Annotation","Message","Thread",
      "FormInstance","ProfileFieldHistory","ProfileField","ExtractedField",
      "Extraction","DocumentPage","Document","Requirement","Intake",
      "CaseMember","Case","Invitation","Session","User","Firm" cascade
  `);

  const mk = async (name: string, slug: string) =>
    admin.firm.create({ data: { name, slug, kmsKeyId: `local:${slug}` } });

  const fa = await mk('Alpha Immigration Law', 'alpha');
  const fb = await mk('Beta Legal Group', 'beta');

  const user = async (firmId: string, email: string, role: 'ATTORNEY' | 'CLIENT') =>
    admin.user.create({
      data: { firmId, email, role, passwordHash: PW, status: 'ACTIVE' },
    });

  const aAtt = await user(fa.id, 'attorney@alpha.test', 'ATTORNEY');
  const aC1 = await user(fa.id, 'client1@alpha.test', 'CLIENT');
  const aC2 = await user(fa.id, 'client2@alpha.test', 'CLIENT');
  const bAtt = await user(fb.id, 'attorney@beta.test', 'ATTORNEY');
  const bC1 = await user(fb.id, 'client1@beta.test', 'CLIENT');

  const mkCase = async (firmId: string, n: string, lead: string, member: string) => {
    const c = await admin.case.create({
      data: { firmId, caseNumber: n, category: 'FAMILY_AOS', leadAttorneyId: lead },
    });
    await admin.caseMember.create({
      data: { caseId: c.id, firmId, userId: member, role: 'PRIMARY_APPLICANT' },
    });
    return c.id;
  };

  const aCase1 = await mkCase(fa.id, 'A-001', aAtt.id, aC1.id);
  const aCase2 = await mkCase(fa.id, 'A-002', aAtt.id, aC2.id);
  const bCase1 = await mkCase(fb.id, 'B-001', bAtt.id, bC1.id);

  const mkDoc = async (firmId: string, caseId: string, uploader: string, name: string) =>
    (await admin.document.create({
      data: {
        firmId, caseId, uploaderId: uploader, docType: 'PASSPORT_BIO', filename: name,
        mimeType: 'application/pdf', byteSize: 1024, sha256: 'a'.repeat(64),
        storageKey: `s3://${caseId}/${name}`,
        dekWrapped: Buffer.from('wrapped'), iv: Buffer.from('iv'), authTag: Buffer.from('tag'),
      },
    })).id;

  const aDoc1 = await mkDoc(fa.id, aCase1, aC1.id, 'passport-a1.pdf');
  const aDoc2 = await mkDoc(fa.id, aCase2, aC2.id, 'passport-a2.pdf');
  const bDoc1 = await mkDoc(fb.id, bCase1, bC1.id, 'passport-b1.pdf');

  const aThread1 = (await admin.thread.create({
    data: { firmId: fa.id, caseId: aCase1, kind: 'CASE', subject: 'Missing paystub' },
  })).id;
  await admin.message.create({
    data: { firmId: fa.id, threadId: aThread1, authorId: aAtt.id, body: 'Privileged: please re-scan.' },
  });

  await admin.auditEvent.create({
    data: { firmId: fa.id, actorId: aAtt.id, caseId: aCase1, action: 'case.viewed',
            targetType: 'Case', targetId: aCase1 },
  });

  const ctx = (userId: string, firmId: string, role: AuthContext['role']): AuthContext =>
    ({ userId, firmId, role });

  return {
    firmA: {
      id: fa.id,
      attorney: ctx(aAtt.id, fa.id, 'ATTORNEY'),
      client1: ctx(aC1.id, fa.id, 'CLIENT'),
      client2: ctx(aC2.id, fa.id, 'CLIENT'),
      case1: aCase1, case2: aCase2, doc1: aDoc1, doc2: aDoc2, thread1: aThread1,
    },
    firmB: {
      id: fb.id,
      attorney: ctx(bAtt.id, fb.id, 'ATTORNEY'),
      client1: ctx(bC1.id, fb.id, 'CLIENT'),
      case1: bCase1, doc1: bDoc1,
    },
  };
}
