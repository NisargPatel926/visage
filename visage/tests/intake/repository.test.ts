import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { completeIntake, getIntake, saveAnswers } from '../../src/server/repositories/intake';
import { getChecklist } from '../../src/server/repositories/checklist';
import { caseQueue } from '../../src/server/repositories/cases';
import { isAnswered, visibleQuestions } from '../../src/domain/intake/engine';
import { QUESTION_BANK } from '../../src/domain/intake/questions';
import type { Answers, AnswerValue } from '../../src/domain/intake/types';
import { reseed, type Seed } from '../fixtures';

let s: Seed;
beforeEach(async () => { s = await reseed(); });

const save = (ctx: Seed['firmA']['client1'], caseId: string, patch: Record<string, AnswerValue>) =>
  withTenant(ctx, (tx) => saveAnswers(tx, ctx, caseId, patch));

const checklistKeys = async (ctx: Seed['firmA']['client1'], caseId: string) =>
  (await withTenant(ctx, (tx) => getChecklist(tx, caseId))).map((r) => r.key);

describe('saving answers', () => {
  it('persists and is resumable across sessions', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'basics.familyName': 'Garcia' });
    await save(s.firmA.client1, s.firmA.case1, { 'basics.givenName': 'Maria' });

    const state = await withTenant(s.firmA.client1, (tx) => getIntake(tx, s.firmA.case1));
    expect(state.answers['basics.familyName']).toBe('Garcia');
    expect(state.answers['basics.givenName']).toBe('Maria');
  });

  it('rejects an unknown question id', async () => {
    // The answers blob feeds the form mapping later; arbitrary keys turn it
    // into a junk drawer nobody can map.
    await expect(save(s.firmA.client1, s.firmA.case1, { 'not.a.question': 'x' }))
      .rejects.toThrow(/unknown question id/);
  });

  it('reports progress and outstanding issues as it goes', async () => {
    const state = await save(s.firmA.client1, s.firmA.case1, { 'basics.familyName': 'Garcia' });
    expect(state.progress.answered).toBe(1);
    expect(state.progress.percent).toBeGreaterThan(0);
    expect(state.issues.length).toBeGreaterThan(0);
  });
});

describe('the checklist responds to answers', () => {
  it('appears as soon as intake starts', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'basics.familyName': 'Garcia' });
    const keys = await checklistKeys(s.firmA.client1, s.firmA.case1);
    expect(keys).toEqual(expect.arrayContaining(['PASSPORT_BIO', 'BIRTH_CERTIFICATE']));
  });

  it('adds an item the moment the triggering answer is given', async () => {
    expect(await checklistKeys(s.firmA.client1, s.firmA.case1)).not.toContain('COURT_DISPOSITIONS');
    await save(s.firmA.client1, s.firmA.case1, { 'eligibility.arrested': true });
    expect(await checklistKeys(s.firmA.client1, s.firmA.case1)).toContain('COURT_DISPOSITIONS');
  });

  it('withdraws rather than deletes when an answer changes', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'MARRIED' });
    expect(await checklistKeys(s.firmA.client1, s.firmA.case1)).toContain('MARRIAGE_CERTIFICATE');

    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'SINGLE' });
    expect(await checklistKeys(s.firmA.client1, s.firmA.case1)).not.toContain('MARRIAGE_CERTIFICATE');

    // The row survives, so an already-uploaded document and any attorney
    // comments on it are not destroyed by a changed answer.
    const all = await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.findMany({ where: { caseId: s.firmA.case1, key: 'MARRIAGE_CERTIFICATE' } }));
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('WITHDRAWN');
  });

  it('reinstates a withdrawn item if the answer flips back', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'MARRIED' });
    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'SINGLE' });
    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'MARRIED' });

    const rows = await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.findMany({ where: { caseId: s.firmA.case1, key: 'MARRIAGE_CERTIFICATE' } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('NOT_STARTED');
  });

  it("never withdraws an item the attorney already accepted", async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'MARRIED' });
    await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.updateMany({
        where: { caseId: s.firmA.case1, key: 'MARRIAGE_CERTIFICATE' },
        data: { status: 'ACCEPTED' },
      }));

    await save(s.firmA.client1, s.firmA.case1, { 'family.maritalStatus': 'SINGLE' });

    const rows = await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.findMany({ where: { caseId: s.firmA.case1, key: 'MARRIAGE_CERTIFICATE' } }));
    expect(rows[0]?.status).toBe('ACCEPTED');
  });

  it('records checklist changes in the audit log', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'eligibility.arrested': true });
    const events = await withTenant(s.firmA.attorney, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'checklist.synced' } }));
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('completing intake', () => {
  it('refuses while required answers are missing', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'basics.familyName': 'Garcia' });
    await expect(
      withTenant(s.firmA.client1, (tx) => completeIntake(tx, s.firmA.client1, s.firmA.case1)),
    ).rejects.toThrow(/not complete/);
  });
});

describe('acceptance: a client completes intake and sees a correct checklist', () => {
  it('end to end', async () => {
    const ctx = s.firmA.client1;
    const caseId = s.firmA.case1;

    // A specific applicant: married, one child, entered on F-1, employed,
    // previously arrested. Each of those facts should move the checklist.
    const profile: Record<string, AnswerValue> = {
      'family.maritalStatus': 'MARRIED',
      'family.hasChildren': true,
      'immigration.statusAtEntry': 'F1',
      'employment.status': 'EMPLOYED',
      'eligibility.arrested': true,
    };
    await save(ctx, caseId, profile);

    // Fill everything else the branching reveals, iterating because answering
    // one question can reveal another.
    const answers: Record<string, AnswerValue> = { ...profile };
    for (let pass = 0; pass < 6; pass++) {
      const patch: Record<string, AnswerValue> = {};
      for (const q of visibleQuestions(QUESTION_BANK, answers as Answers)) {
        if (isAnswered(answers[q.id])) continue;
        patch[q.id] =
          q.kind === 'boolean' ? false
          : q.kind === 'number' ? (q.id === 'biographic.heightFeet' ? 5 : q.id === 'biographic.heightInches' ? 6 : 150)
          : q.kind === 'date' ? '1990-03-14'
          : q.kind === 'multiselect' ? [q.options![0]!.value]
          : q.kind === 'select' ? q.options!.find((o) => o.value === profile[q.id]) ? String(profile[q.id]) : q.options![0]!.value
          : q.id === 'immigration.aNumber' ? 'A123456789'
          : 'Provided';
      }
      if (Object.keys(patch).length === 0) break;
      Object.assign(answers, patch);
      // Keep the fixed facts pinned; generic filling must not overwrite them.
      Object.assign(answers, profile);
      await save(ctx, caseId, { ...patch, ...profile });
    }

    const state = await withTenant(ctx, (tx) => getIntake(tx, caseId));
    expect(state.issues, `unresolved: ${JSON.stringify(state.issues.slice(0, 3))}`).toEqual([]);
    expect(state.progress.percent).toBe(100);

    await withTenant(ctx, (tx) => completeIntake(tx, ctx, caseId));

    const done = await withTenant(ctx, (tx) => getIntake(tx, caseId));
    expect(done.completedAt).not.toBeNull();

    const kase = await withTenant(ctx, (tx) => tx.case.findUnique({ where: { id: caseId } }));
    expect(kase?.status).toBe('COLLECTING');

    // The checklist is personalised to exactly the facts given.
    const keys = await checklistKeys(ctx, caseId);
    expect(keys).toEqual(expect.arrayContaining([
      'PASSPORT_BIO', 'BIRTH_CERTIFICATE', 'PHOTOS', 'MEDICAL_EXAM', 'I94',
      'I20',                          // entered on F-1
      'MARRIAGE_CERTIFICATE',         // married
      'CHILDREN_BIRTH_CERTIFICATES',  // has children
      'TAX_RETURNS', 'PAYSTUBS',      // employed
      'COURT_DISPOSITIONS',           // arrested
    ]));
    // And excludes what does not apply.
    expect(keys).not.toContain('I797_NOTICES');   // not H-1B
    expect(keys).not.toContain('J1_WAIVER');      // not J-1
  });
});

describe('tenant isolation still holds', () => {
  it("another firm cannot read this case's intake or checklist", async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'basics.familyName': 'Garcia' });

    const intake = await withTenant(s.firmB.attorney, (tx) =>
      tx.intake.findUnique({ where: { caseId: s.firmA.case1 } }));
    const reqs = await withTenant(s.firmB.attorney, (tx) => tx.requirement.findMany());

    expect(intake).toBeNull();
    expect(reqs).toHaveLength(0);
  });

  it("a firm-mate cannot read another client's checklist", async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'eligibility.arrested': true });
    const reqs = await withTenant(s.firmA.client2, (tx) =>
      tx.requirement.findMany({ where: { caseId: s.firmA.case1 } }));
    expect(reqs).toHaveLength(0);
  });
});

describe('staff case queue', () => {
  it('surfaces cases needing review first', async () => {
    await save(s.firmA.client1, s.firmA.case1, { 'basics.familyName': 'Garcia' });
    await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.updateMany({
        where: { caseId: s.firmA.case1, key: 'PASSPORT_BIO' }, data: { status: 'UPLOADED' },
      }));

    const queue = await withTenant(s.firmA.attorney, (tx) => caseQueue(tx));
    expect(queue[0]?.id).toBe(s.firmA.case1);
    expect(queue[0]?.needsAttention).toBe(true);
    expect(queue[0]?.awaitingReview).toBe(1);
  });

  it("shows only the signed-in firm's cases", async () => {
    const queue = await withTenant(s.firmB.attorney, (tx) => caseQueue(tx));
    expect(queue.map((q) => q.caseNumber)).toEqual(['B-001']);
  });
});
