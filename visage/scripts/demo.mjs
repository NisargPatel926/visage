#!/usr/bin/env node
/**
 * Populate the dev case with a realistic applicant so the UI has something to
 * show: a completed questionnaire, an uploaded document, and enough profile to
 * generate a filled I-485.
 *
 *   node scripts/demo.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const l of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l);
  if (m?.[1]) process.env[m[1]] ??= (m[2] ?? '').replace(/^["']|["']$/g, '');
}
if (process.env.NODE_ENV === 'production') {
  console.error('refusing to write demo data in production');
  process.exit(1);
}

const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const { withTenant } = await import('../src/server/db/tenant.ts');
const { saveAnswers } = await import('../src/server/repositories/intake.ts');
const { ingestDocument } = await import('../src/server/documents/ingest.ts');
const { visibleQuestions, isAnswered } = await import('../src/domain/intake/engine.ts');
const { QUESTION_BANK } = await import('../src/domain/intake/questions.ts');

const firms = await db.$queryRaw`select * from app.resolve_firm('alpha')`;
const users = await db.$queryRaw`
  select * from app.auth_find_user(${firms[0].id}::uuid, 'client@alpha.test')`;
const u = users[0];
if (!u) {
  // The test suite truncates every table, so a test run clears dev data.
  console.error('No demo user found. Run `npm run db:seed` first.');
  process.exit(1);
}
const ctx = { userId: u.id, firmId: u.firm_id, role: u.role };

const kase = await withTenant(ctx, (tx) => tx.case.findFirst());
if (!kase) {
  console.error('No case found for the demo client. Run `npm run db:seed` first.');
  process.exit(1);
}

// A specific applicant, so the checklist and the form both have something real.
const facts = {
  'basics.familyName': 'Garcia', 'basics.givenName': 'Maria', 'basics.middleName': 'Elena',
  'basics.dateOfBirth': '1990-03-14', 'basics.countryOfBirth': 'Mexico',
  'basics.countryOfCitizenship': 'Mexico',
  'basics.otherNames': true, 'basics.otherNamesDetail': 'Maria Elena Ruiz (maiden name)',
  'immigration.hasANumber': true, 'immigration.aNumber': 'A123456789',
  'immigration.passportNumber': 'X1234567', 'immigration.dateOfArrival': '2019-08-20',
  'immigration.statusAtEntry': 'F1', 'immigration.currentStatus': 'F-1 student',
  'immigration.hasEad': false,
  'family.maritalStatus': 'MARRIED', 'family.spouseName': 'Jordan Rivera',
  'family.marriageDate': '2021-06-12', 'family.priorMarriage': false,
  'family.hasChildren': true,
  'family.childrenDetail': 'Sofia Garcia Rivera, born 2022-04-03, United States',
  'family.motherName': 'Ana Ruiz', 'family.fatherName': 'Luis Garcia',
  'employment.status': 'EMPLOYED', 'employment.employerName': 'Northwind Analytics',
  'employment.history': 'Northwind Analytics, Data Analyst, 2021-present. Campus library, 2019-2021.',
  'addresses.currentAddress': '412 Cedar St, Apt 3, Austin, TX 78701',
  'addresses.movedInLastFiveYears': true,
  'addresses.priorAddresses': '88 Elm Ave, Austin TX (2019-2021); Calle Reforma 14, Puebla, Mexico (until 2019)',
  'biographic.ethnicity': 'HISPANIC', 'biographic.race': ['WHITE'],
  'biographic.heightFeet': 5, 'biographic.heightInches': 6, 'biographic.weight': 140,
  'eligibility.arrested': true,
  'eligibility.arrestDetail': 'Cited for trespass in Austin, TX in March 2015 after a protest; charge dismissed. Certified disposition attached.',
  'eligibility.workedWithoutAuth': false, 'eligibility.removalProceedings': false,
};

await withTenant(ctx, (tx) => saveAnswers(tx, ctx, kase.id, facts));

// Fill whatever the branching still leaves open, so intake reads as complete.
let answers = { ...facts };
for (let pass = 0; pass < 6; pass++) {
  const patch = {};
  for (const q of visibleQuestions(QUESTION_BANK, answers)) {
    if (isAnswered(answers[q.id])) continue;
    patch[q.id] = q.kind === 'boolean' ? false
      : q.kind === 'number' ? 0
      : q.kind === 'date' ? '2020-01-01'
      : q.kind === 'multiselect' ? [q.options[0].value]
      : q.kind === 'select' ? q.options[0].value
      : 'Provided';
  }
  if (!Object.keys(patch).length) break;
  answers = { ...answers, ...patch, ...facts };
  await withTenant(ctx, (tx) => saveAnswers(tx, ctx, kase.id, { ...patch, ...facts }));
}

// One real upload, through the full pipeline.
const { PDFDocument, StandardFonts } = await import('pdf-lib');
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([420, 260]);
page.drawText('PASSPORT', { x: 30, y: 210, size: 22, font });
page.drawText('Surname: GARCIA', { x: 30, y: 170, size: 12, font });
page.drawText('Given names: MARIA ELENA', { x: 30, y: 150, size: 12, font });
page.drawText('Passport No: X1234567', { x: 30, y: 130, size: 12, font });
page.drawText('Date of birth: 14 MAR 1990', { x: 30, y: 110, size: 12, font });
page.drawText('Nationality: MEXICAN', { x: 30, y: 90, size: 12, font });
const bytes = Buffer.from(await pdf.save());

const req = await withTenant(ctx, (tx) =>
  tx.requirement.findFirst({ where: { caseId: kase.id, key: 'PASSPORT_BIO' } }));

const existing = await withTenant(ctx, (tx) =>
  tx.document.findFirst({ where: { caseId: kase.id } }));
if (!existing) {
  await withTenant(ctx, (tx) =>
    ingestDocument(tx, ctx, {
      caseId: kase.id, requirementId: req?.id, filename: 'passport-bio-page.pdf',
      declaredMime: 'application/pdf', bytes,
    }));
}

// Two more cases so the console queue shows its triage order rather than a
// single row: one part-way through intake, one with work waiting on review.
const admin = new PrismaClient({
  datasources: { db: { url: process.env.TEST_ADMIN_DATABASE_URL } },
});
const attorneys = await db.$queryRaw`
  select * from app.auth_find_user(${firms[0].id}::uuid, 'attorney@alpha.test')`;
const staffCtx = { userId: attorneys[0].id, firmId: attorneys[0].firm_id, role: attorneys[0].role };

for (const [number, partial, awaiting] of [['A-1002', true, false], ['A-1003', false, true]]) {
  const exists = await admin.case.findFirst({ where: { firmId: firms[0].id, caseNumber: number } });
  if (exists) continue;
  const extra = await admin.case.create({
    data: {
      firmId: firms[0].id, caseNumber: number, category: 'FAMILY_AOS',
      leadAttorneyId: attorneys[0].id, status: partial ? 'INTAKE' : 'COLLECTING',
    },
  });
  const email = `applicant-${number.toLowerCase()}@alpha.test`;
  const applicant = await admin.user.upsert({
    where: { firmId_email: { firmId: firms[0].id, email } },
    update: {},
    create: { firmId: firms[0].id, email, role: 'CLIENT', passwordHash: u.password_hash, status: 'ACTIVE' },
  });
  await admin.caseMember.create({
    data: { caseId: extra.id, firmId: firms[0].id, userId: applicant.id, role: 'PRIMARY_APPLICANT' },
  });
  const applicantCtx = { userId: applicant.id, firmId: firms[0].id, role: 'CLIENT' };
  await withTenant(applicantCtx, (tx) => saveAnswers(tx, applicantCtx, extra.id, partial
    ? { 'basics.familyName': 'Okafor', 'basics.givenName': 'Chidi',
        'family.maritalStatus': 'SINGLE', 'immigration.statusAtEntry': 'H1B' }
    : { 'basics.familyName': 'Nakamura', 'basics.givenName': 'Yuki',
        'family.maritalStatus': 'MARRIED', 'immigration.statusAtEntry': 'J1',
        'eligibility.jVisitorTwoYear': true, 'employment.status': 'EMPLOYED' }));
  if (awaiting) {
    await withTenant(staffCtx, (tx) => tx.requirement.updateMany({
      where: { caseId: extra.id, key: { in: ['PASSPORT_BIO', 'MARRIAGE_CERTIFICATE'] } },
      data: { status: 'UPLOADED' },
    }));
  }
}
await admin.$disconnect();

const checklist = await withTenant(ctx, (tx) =>
  tx.requirement.findMany({ where: { caseId: kase.id, status: { not: 'WITHDRAWN' } } }));

console.log(`Demo case ready: ${kase.caseNumber}`);
console.log(`  checklist items : ${checklist.length}`);
console.log(`  documents       : 1`);
console.log(`  case id         : ${kase.id}`);
await db.$disconnect();
