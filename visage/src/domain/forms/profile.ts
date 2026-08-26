import { effectiveAnswers } from '../intake/engine';
import { QUESTION_BANK } from '../intake/questions';
import type { Answers } from '../intake/types';
import type { OverflowEntry, Profile } from './types';

/**
 * Turn questionnaire answers into the canonical profile.
 *
 * This is the hinge the whole design turns on: documents and questions both
 * feed one profile, and forms are filled from the profile alone. Nothing here
 * knows a PDF field name, and nothing in the mapping knows a question id.
 *
 * Stale answers from abandoned branches are dropped first, so a spouse named
 * before switching to "single" can never reach a form.
 */
export function profileFromAnswers(raw: Answers): Profile {
  const answers = effectiveAnswers(QUESTION_BANK, raw);
  const out: Record<string, string | null> = {};

  for (const q of QUESTION_BANK) {
    if (!q.profilePath) continue;
    const v = answers[q.id];
    if (v === undefined || v === null || v === '') continue;
    out[q.profilePath] = Array.isArray(v) ? v.join(', ') : String(v);
  }

  // Height is asked as two numbers because that is how the form asks it.
  const feet = answers['biographic.heightFeet'];
  const inches = answers['biographic.heightInches'];
  if (feet != null) out['applicant.height.feet'] = String(feet);
  if (inches != null) out['applicant.height.inches'] = String(inches);

  // The form asks for city and country of birth separately; intake asks for
  // country only, so city stays empty rather than being invented.
  if (out['applicant.countryOfBirth'] && !out['applicant.cityOfBirth']) {
    out['applicant.cityOfBirth'] = null;
  }

  return out;
}

/**
 * Long answers that cannot fit their field, continued on the Part 14 sheet.
 *
 * USCIS requires each continuation to name the page, part, and item it belongs
 * to. Getting that bookkeeping right by hand is exactly what preparers fumble.
 */
export function overflowFromAnswers(raw: Answers): OverflowEntry[] {
  const answers = effectiveAnswers(QUESTION_BANK, raw);
  const entries: OverflowEntry[] = [];

  const add = (partNumber: string, itemNumber: string, pageNumber: string, text: unknown) => {
    const s = typeof text === 'string' ? text.trim() : '';
    if (s) entries.push({ partNumber, itemNumber, pageNumber, text: s });
  };

  add('1', '2', '1', answers['basics.otherNamesDetail']);
  add('1', '18', '2', answers['addresses.priorAddresses']);
  add('4', '1', '8', answers['employment.history']);
  add('7', '1', '12', answers['family.childrenDetail']);
  add('9', '1', '13', answers['eligibility.arrestDetail']);

  return entries;
}
