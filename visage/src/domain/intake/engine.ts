import { SECTIONS, type Answers, type AnswerValue, type Progress, type Question, type SectionId, type ValidationIssue } from './types';

/** An answer is "given" if it holds a value. `false` counts; empty string does not. */
export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true; // boolean false and 0 are real answers
}

/**
 * Questions the applicant should currently see.
 *
 * Branching is evaluated against live answers, so hiding a question when an
 * earlier answer changes happens for free. The stored answer is deliberately
 * *not* erased — if the applicant flips back, their work is still there.
 * Hidden answers are excluded at read time instead (see `effectiveAnswers`).
 */
export function visibleQuestions(bank: readonly Question[], answers: Answers): Question[] {
  return bank.filter((q) => !q.when || q.when(answers));
}

/**
 * Answers with hidden questions stripped.
 *
 * This is what downstream consumers — the checklist rules and eventually the
 * form mapping — must use. Reading raw answers would let a stale answer from an
 * abandoned branch (a spouse's name after switching to "single") reach a form.
 */
export function effectiveAnswers(bank: readonly Question[], answers: Answers): Answers {
  const visible = new Set(visibleQuestions(bank, answers).map((q) => q.id));
  const out: Record<string, AnswerValue> = {};
  for (const [k, v] of Object.entries(answers)) if (visible.has(k)) out[k] = v;
  return out;
}

export function validate(bank: readonly Question[], answers: Answers): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const q of visibleQuestions(bank, answers)) {
    const value = answers[q.id];
    if (q.required && !isAnswered(value)) {
      issues.push({ questionId: q.id, message: 'This question needs an answer.' });
      continue;
    }
    if (!isAnswered(value)) continue;
    const custom = q.validate?.(value ?? null);
    if (custom) issues.push({ questionId: q.id, message: custom });
  }
  return issues;
}

export function progress(bank: readonly Question[], answers: Answers): Progress {
  const visible = visibleQuestions(bank, answers);
  const bySection = SECTIONS.map((s) => {
    const qs = visible.filter((q) => q.section === s.id);
    const answered = qs.filter((q) => isAnswered(answers[q.id])).length;
    return {
      section: s.id as SectionId,
      title: s.title,
      answered,
      total: qs.length,
      complete: qs.length > 0 && answered === qs.length,
    };
  });
  const answered = bySection.reduce((n, s) => n + s.answered, 0);
  const total = bySection.reduce((n, s) => n + s.total, 0);
  return {
    answered,
    total,
    percent: total === 0 ? 0 : Math.round((answered / total) * 100),
    bySection,
  };
}

export function isComplete(bank: readonly Question[], answers: Answers): boolean {
  return validate(bank, answers).length === 0 && progress(bank, answers).percent === 100;
}

/** First unanswered visible question, for "continue where you left off". */
export function nextUnanswered(bank: readonly Question[], answers: Answers): Question | null {
  return visibleQuestions(bank, answers).find((q) => !isAnswered(answers[q.id])) ?? null;
}
