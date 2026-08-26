import { describe, expect, it } from 'vitest';
import {
  effectiveAnswers, isAnswered, isComplete, nextUnanswered, progress, validate, visibleQuestions,
} from '../../src/domain/intake/engine';
import { QUESTION_BANK, byId } from '../../src/domain/intake/questions';
import type { Answers } from '../../src/domain/intake/types';

const ask = (id: string) => byId.get(id)!;

describe('answeredness', () => {
  it('counts false and zero as real answers', () => {
    // The bug this guards: treating falsy as unanswered means every "no" to an
    // eligibility question reads as a blank, and intake never completes.
    expect(isAnswered(false)).toBe(true);
    expect(isAnswered(0)).toBe(true);
  });

  it('does not count blanks', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered('   ')).toBe(false);
    expect(isAnswered([])).toBe(false);
  });
});

describe('branching', () => {
  it('hides follow-ups until the trigger is answered', () => {
    const ids = visibleQuestions(QUESTION_BANK, {}).map((q) => q.id);
    expect(ids).toContain('basics.otherNames');
    expect(ids).not.toContain('basics.otherNamesDetail');
  });

  it('reveals follow-ups when the trigger is yes', () => {
    const ids = visibleQuestions(QUESTION_BANK, { 'basics.otherNames': true }).map((q) => q.id);
    expect(ids).toContain('basics.otherNamesDetail');
  });

  it('shows spouse questions only when married', () => {
    const married = visibleQuestions(QUESTION_BANK, { 'family.maritalStatus': 'MARRIED' });
    const single = visibleQuestions(QUESTION_BANK, { 'family.maritalStatus': 'SINGLE' });
    expect(married.map((q) => q.id)).toContain('family.spouseName');
    expect(single.map((q) => q.id)).not.toContain('family.spouseName');
  });

  it('asks the J-1 question only of J-1 entrants', () => {
    expect(visibleQuestions(QUESTION_BANK, { 'immigration.statusAtEntry': 'J1' }).map((q) => q.id))
      .toContain('eligibility.jVisitorTwoYear');
    expect(visibleQuestions(QUESTION_BANK, { 'immigration.statusAtEntry': 'F1' }).map((q) => q.id))
      .not.toContain('eligibility.jVisitorTwoYear');
  });
});

describe('effectiveAnswers', () => {
  it('drops answers whose question is no longer shown', () => {
    // Someone says married, names a spouse, then changes to single. The spouse
    // name must not survive into the form.
    const answers: Answers = {
      'family.maritalStatus': 'SINGLE',
      'family.spouseName': 'Jordan Rivera',
    };
    expect(effectiveAnswers(QUESTION_BANK, answers)['family.spouseName']).toBeUndefined();
  });

  it('keeps answers that are still shown', () => {
    const answers: Answers = {
      'family.maritalStatus': 'MARRIED',
      'family.spouseName': 'Jordan Rivera',
    };
    expect(effectiveAnswers(QUESTION_BANK, answers)['family.spouseName']).toBe('Jordan Rivera');
  });

  it('does not erase the stored answer, only the effective view', () => {
    // Flipping back must not lose the applicant's typing.
    const stored: Answers = { 'family.maritalStatus': 'SINGLE', 'family.spouseName': 'Jordan' };
    expect(stored['family.spouseName']).toBe('Jordan');
    const restored = { ...stored, 'family.maritalStatus': 'MARRIED' };
    expect(effectiveAnswers(QUESTION_BANK, restored)['family.spouseName']).toBe('Jordan');
  });
});

describe('validation', () => {
  it('flags a missing required answer', () => {
    const issues = validate(QUESTION_BANK, {});
    expect(issues.some((i) => i.questionId === 'basics.familyName')).toBe(true);
  });

  it('does not flag questions that are hidden', () => {
    const issues = validate(QUESTION_BANK, {});
    expect(issues.some((i) => i.questionId === 'basics.otherNamesDetail')).toBe(false);
  });

  it('rejects a malformed A-Number and accepts a valid one', () => {
    const q = ask('immigration.aNumber');
    expect(q.validate?.('12345')).toMatch(/7 to 9 digits/);
    expect(q.validate?.('A123456789')).toBeNull();
    expect(q.validate?.('123-45-678')).toBeNull();
  });

  it('rejects a future date of birth', () => {
    const q = ask('basics.dateOfBirth');
    expect(q.validate?.('2999-01-01')).toMatch(/future/);
    expect(q.validate?.('1990-03-14')).toBeNull();
    expect(q.validate?.('14/03/1990')).toMatch(/YYYY-MM-DD/);
  });

  it('bounds height to something a person could be', () => {
    expect(ask('biographic.heightFeet').validate?.(12)).toMatch(/between 2 and 8/);
    expect(ask('biographic.heightInches').validate?.(15)).toMatch(/0 to 11/);
  });
});

describe('progress', () => {
  it('starts at zero and reports every section', () => {
    const p = progress(QUESTION_BANK, {});
    expect(p.answered).toBe(0);
    expect(p.percent).toBe(0);
    expect(p.bySection).toHaveLength(7);
  });

  it('counts only visible questions, so revealing a follow-up can lower the percentage', () => {
    const before = progress(QUESTION_BANK, { 'basics.otherNames': false });
    const after = progress(QUESTION_BANK, { 'basics.otherNames': true });
    expect(after.total).toBe(before.total + 1);
  });

  it('marks a section complete only when all its visible questions are answered', () => {
    const p = progress(QUESTION_BANK, { 'biographic.ethnicity': 'NOT_HISPANIC' });
    expect(p.bySection.find((s) => s.section === 'biographic')?.complete).toBe(false);
  });
});

describe('resumability', () => {
  it('points at the first unanswered question', () => {
    expect(nextUnanswered(QUESTION_BANK, {})?.id).toBe('basics.familyName');
  });

  it('advances as answers arrive', () => {
    expect(nextUnanswered(QUESTION_BANK, { 'basics.familyName': 'Garcia' })?.id)
      .toBe('basics.givenName');
  });

  it('returns null once everything visible is answered', () => {
    const answers: Record<string, unknown> = {};
    for (const q of visibleQuestions(QUESTION_BANK, {})) answers[q.id] = q.kind === 'boolean' ? false : 'x';
    // Booleans set to false may reveal nothing further; fill iteratively.
    for (let i = 0; i < 5; i++) {
      for (const q of visibleQuestions(QUESTION_BANK, answers as Answers)) {
        if (!isAnswered((answers as Answers)[q.id])) answers[q.id] = q.kind === 'boolean' ? false : 'x';
      }
    }
    expect(nextUnanswered(QUESTION_BANK, answers as Answers)).toBeNull();
  });
});

describe('question bank integrity', () => {
  it('has unique ids', () => {
    const ids = QUESTION_BANK.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every select and multiselect its options', () => {
    for (const q of QUESTION_BANK) {
      if (q.kind === 'select' || q.kind === 'multiselect') {
        expect(q.options?.length, `${q.id} has no options`).toBeGreaterThan(0);
      }
    }
  });

  it('carries the official Part 9 wording verbatim', () => {
    const q = QUESTION_BANK.find((x) => x.prompt.startsWith('Have you EVER been denied a visa'));
    expect(q).toBeDefined();
    expect(q?.prompt).toBe('Have you EVER been denied a visa to the United States?');
  });

  it('never phrases a question as advice', () => {
    // UPL guard: intake records what the applicant says. It must not tell them
    // what to do or which benefit to seek.
    for (const q of QUESTION_BANK) {
      expect(q.prompt.toLowerCase()).not.toMatch(/you should|we recommend|you must file/);
      expect((q.help ?? '').toLowerCase()).not.toMatch(/you should|we recommend/);
    }
  });
});
