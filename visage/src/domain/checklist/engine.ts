import { effectiveAnswers } from '../intake/engine';
import { QUESTION_BANK } from '../intake/questions';
import type { Answers } from '../intake/types';
import { CHECKLIST_RULES, type ChecklistRule } from './rules';

export interface DerivedRequirement {
  readonly key: string;
  readonly title: string;
  readonly rationale: string;
  readonly acceptedDocTypes: string[];
  readonly required: boolean;
  readonly uploadable: boolean;
}

const toDerived = (r: ChecklistRule): DerivedRequirement => ({
  key: r.key,
  title: r.title,
  rationale: r.rationale,
  acceptedDocTypes: [...r.acceptedDocTypes],
  required: r.required,
  uploadable: r.uploadable,
});

/**
 * Which checklist items apply, given what the applicant has told us.
 *
 * Pure: same answers in, same requirements out, no database and no clock. That
 * is what makes the rules testable one at a time, and it is why this returns
 * the full set rather than a diff — reconciling against what is stored is the
 * repository's job (see syncRequirements).
 *
 * Answers are passed through `effectiveAnswers` first so that a stale answer
 * from an abandoned branch cannot trigger a requirement. Someone who ticked
 * "married", answered the spouse questions, then switched to "single" must not
 * still be asked for a marriage certificate.
 */
export function deriveRequirements(rawAnswers: Answers): DerivedRequirement[] {
  const answers = effectiveAnswers(QUESTION_BANK, rawAnswers);
  return CHECKLIST_RULES.filter((r) => !r.when || r.when(answers)).map(toDerived);
}
