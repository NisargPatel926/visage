import { describe, expect, it } from 'vitest';
import { deriveRequirements } from '../../src/domain/checklist/engine';
import { CHECKLIST_RULES } from '../../src/domain/checklist/rules';
import type { Answers } from '../../src/domain/intake/types';

const keys = (a: Answers) => deriveRequirements(a).map((r) => r.key);

describe('baseline', () => {
  it('always asks for identity and civil documents', () => {
    const k = keys({});
    expect(k).toEqual(expect.arrayContaining(['PASSPORT_BIO', 'BIRTH_CERTIFICATE', 'PHOTOS']));
  });

  it('tracks the medical exam but never asks for an upload', () => {
    // I-693 arrives sealed from the civil surgeon. Opening it to scan voids the
    // exam, so the UI must not offer an upload control for this item.
    const medical = deriveRequirements({}).find((r) => r.key === 'MEDICAL_EXAM');
    expect(medical).toBeDefined();
    expect(medical?.uploadable).toBe(false);
    expect(medical?.acceptedDocTypes).toEqual([]);
    expect(medical?.rationale).toMatch(/sealed/i);
  });
});

describe('status-driven items', () => {
  it('asks F-1 entrants for an I-20', () => {
    expect(keys({ 'immigration.statusAtEntry': 'F1' })).toContain('I20');
    expect(keys({ 'immigration.statusAtEntry': 'H1B' })).not.toContain('I20');
  });

  it('asks H-1B entrants for approval notices', () => {
    expect(keys({ 'immigration.statusAtEntry': 'H1B' })).toContain('I797_NOTICES');
  });

  it('skips the I-94 for someone who entered without inspection', () => {
    // There is no I-94 to produce; asking for one is a dead end that makes the
    // checklist impossible to finish.
    expect(keys({ 'immigration.statusAtEntry': 'NO_INSPECTION' })).not.toContain('I94');
    expect(keys({ 'immigration.statusAtEntry': 'F1' })).toContain('I94');
  });

  it('asks for the J-1 waiver only when the two-year rule applies', () => {
    expect(keys({ 'immigration.statusAtEntry': 'J1', 'eligibility.jVisitorTwoYear': true }))
      .toContain('J1_WAIVER');
    expect(keys({ 'immigration.statusAtEntry': 'J1', 'eligibility.jVisitorTwoYear': false }))
      .not.toContain('J1_WAIVER');
  });
});

describe('family-driven items', () => {
  it('asks a married applicant for a marriage certificate', () => {
    expect(keys({ 'family.maritalStatus': 'MARRIED' })).toContain('MARRIAGE_CERTIFICATE');
    expect(keys({ 'family.maritalStatus': 'SINGLE' })).not.toContain('MARRIAGE_CERTIFICATE');
  });

  it('asks for proof that a prior marriage ended', () => {
    expect(keys({ 'family.maritalStatus': 'DIVORCED' })).toContain('PRIOR_MARRIAGE_TERMINATION');
    expect(keys({ 'family.maritalStatus': 'WIDOWED' })).toContain('PRIOR_MARRIAGE_TERMINATION');
    expect(keys({ 'family.maritalStatus': 'MARRIED', 'family.priorMarriage': true }))
      .toContain('PRIOR_MARRIAGE_TERMINATION');
  });

  it("asks for children's birth certificates only when there are children", () => {
    expect(keys({ 'family.hasChildren': true })).toContain('CHILDREN_BIRTH_CERTIFICATES');
    expect(keys({ 'family.hasChildren': false })).not.toContain('CHILDREN_BIRTH_CERTIFICATES');
  });
});

describe('eligibility-driven items', () => {
  it('asks for court records after any arrest', () => {
    const r = deriveRequirements({ 'eligibility.arrested': true })
      .find((x) => x.key === 'COURT_DISPOSITIONS');
    expect(r).toBeDefined();
    // Applicants routinely assume a dismissed or expunged case does not count.
    expect(r?.rationale).toMatch(/dismissed|expunged/i);
  });

  it('asks for immigration court records after removal proceedings', () => {
    expect(keys({ 'eligibility.removalProceedings': true }))
      .toContain('REMOVAL_PROCEEDING_RECORDS');
  });

  it('asks for a written account of unauthorized work', () => {
    expect(keys({ 'eligibility.workedWithoutAuth': true }))
      .toContain('UNAUTHORIZED_WORK_EXPLANATION');
  });
});

describe('stale-branch safety', () => {
  it('ignores an answer whose question is no longer shown', () => {
    // Married, named a spouse, then switched to single. No marriage certificate.
    const k = keys({ 'family.maritalStatus': 'SINGLE', 'family.spouseName': 'Jordan' });
    expect(k).not.toContain('MARRIAGE_CERTIFICATE');
  });

  it('drops the J-1 waiver when the entry status changes away from J-1', () => {
    // jVisitorTwoYear is only asked of J-1 entrants, so switching entry status
    // must retire the requirement it triggered.
    const k = keys({ 'immigration.statusAtEntry': 'F1', 'eligibility.jVisitorTwoYear': true });
    expect(k).not.toContain('J1_WAIVER');
  });
});

describe('rule integrity', () => {
  it('has unique keys', () => {
    const k = CHECKLIST_RULES.map((r) => r.key);
    expect(new Set(k).size).toBe(k.length);
  });

  it('gives every uploadable rule at least one accepted document type', () => {
    for (const r of CHECKLIST_RULES) {
      if (r.uploadable) expect(r.acceptedDocTypes.length, `${r.key}`).toBeGreaterThan(0);
    }
  });

  it('explains every item to the applicant without advising them', () => {
    for (const r of CHECKLIST_RULES) {
      expect(r.rationale.length, `${r.key} has no rationale`).toBeGreaterThan(20);
      expect(r.rationale.toLowerCase()).not.toMatch(/you should file|we recommend|you qualify/);
    }
  });
});
