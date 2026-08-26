import { createHash } from 'node:crypto';
import officialQuestions from '../../../assets/forms/i-485/2025-01-20/questions.json' with { type: 'json' };
import type { Answers, Question } from './types';

const yes = (id: string) => (a: Answers) => a[id] === true;
const eq = (id: string, v: string) => (a: Answers) => a[id] === v;

const isDate = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
    ? null
    : 'Enter a date as YYYY-MM-DD.';

const notFuture = (v: unknown): string | null => {
  const base = isDate(v);
  if (base) return base;
  return Date.parse(v as string) > Date.now() ? 'This date cannot be in the future.' : null;
};

/**
 * Curated questions.
 *
 * These are written out rather than generated because each one either drives a
 * checklist rule, branches the questionnaire, or maps to a specific profile
 * path. The bulk yes/no eligibility questions are generated below from the
 * official wording instead.
 */
const CURATED: Question[] = [
  // ------------------------------------------------------------- basics ---
  { id: 'basics.familyName', section: 'basics', kind: 'text', required: true,
    prompt: 'Family name (last name)', profilePath: 'applicant.name.family',
    formRef: 'I-485 Part 1, Item 1.a' },
  { id: 'basics.givenName', section: 'basics', kind: 'text', required: true,
    prompt: 'Given name (first name)', profilePath: 'applicant.name.given',
    formRef: 'I-485 Part 1, Item 1.b' },
  { id: 'basics.middleName', section: 'basics', kind: 'text',
    prompt: 'Middle name', help: 'Leave blank if you do not have one.',
    profilePath: 'applicant.name.middle', formRef: 'I-485 Part 1, Item 1.c' },
  { id: 'basics.otherNames', section: 'basics', kind: 'boolean', required: true,
    prompt: 'Have you ever used any other names?',
    help: 'Includes a maiden name, a name from a previous marriage, or an alias.',
    formRef: 'I-485 Part 1, Item 2' },
  { id: 'basics.otherNamesDetail', section: 'basics', kind: 'longtext', required: true,
    prompt: 'List every other name you have used', when: yes('basics.otherNames') },
  { id: 'basics.dateOfBirth', section: 'basics', kind: 'date', required: true,
    prompt: 'Date of birth', profilePath: 'applicant.dateOfBirth',
    formRef: 'I-485 Part 1, Item 3', validate: notFuture },
  { id: 'basics.countryOfBirth', section: 'basics', kind: 'text', required: true,
    prompt: 'Country of birth', profilePath: 'applicant.countryOfBirth',
    formRef: 'I-485 Part 1, Item 7' },
  { id: 'basics.countryOfCitizenship', section: 'basics', kind: 'text', required: true,
    prompt: 'Country of citizenship or nationality',
    profilePath: 'applicant.countryOfCitizenship', formRef: 'I-485 Part 1, Item 8' },

  // -------------------------------------------------------- immigration ---
  { id: 'immigration.hasANumber', section: 'immigration', kind: 'boolean', required: true,
    prompt: 'Do you have an Alien Registration Number (A-Number)?',
    help: 'A seven to nine digit number on USCIS correspondence, written as A-000000000.',
    formRef: 'I-485 Part 1, Item 4' },
  { id: 'immigration.aNumber', section: 'immigration', kind: 'text', required: true,
    prompt: 'Your A-Number', when: yes('immigration.hasANumber'),
    profilePath: 'applicant.alienNumber',
    validate: (v) => (/^A?\d{7,9}$/.test(String(v).replace(/[\s-]/g, '')) ? null
      : 'An A-Number is 7 to 9 digits.') },
  { id: 'immigration.passportNumber', section: 'immigration', kind: 'text', required: true,
    prompt: 'Passport number', profilePath: 'applicant.passport.number',
    formRef: 'I-485 Part 1, Item 10' },
  { id: 'immigration.dateOfArrival', section: 'immigration', kind: 'date', required: true,
    prompt: 'Date of your last arrival in the United States',
    profilePath: 'applicant.lastArrival.date', formRef: 'I-485 Part 1, Item 10',
    validate: notFuture },
  { id: 'immigration.statusAtEntry', section: 'immigration', kind: 'select', required: true,
    prompt: 'What status did you enter on?',
    help: 'The visa class on your entry stamp or I-94.',
    profilePath: 'applicant.lastArrival.status',
    options: [
      { value: 'F1', label: 'F-1 student' },
      { value: 'H1B', label: 'H-1B worker' },
      { value: 'J1', label: 'J-1 exchange visitor' },
      { value: 'B1B2', label: 'B-1/B-2 visitor' },
      { value: 'K1', label: 'K-1 fiancé(e)' },
      { value: 'PAROLE', label: 'Humanitarian parole' },
      { value: 'NO_INSPECTION', label: 'Entered without inspection' },
      { value: 'OTHER', label: 'Something else' },
    ] },
  { id: 'immigration.currentStatus', section: 'immigration', kind: 'text', required: true,
    prompt: 'What is your current immigration status?',
    profilePath: 'applicant.currentStatus' },
  { id: 'immigration.hasEad', section: 'immigration', kind: 'boolean', required: true,
    prompt: 'Do you currently have an Employment Authorization Document (EAD)?' },

  // ----------------------------------------------------------- addresses ---
  { id: 'addresses.currentAddress', section: 'addresses', kind: 'longtext', required: true,
    prompt: 'Your current physical address',
    help: 'Street, city, state, ZIP. USCIS asks for five years of history.',
    profilePath: 'applicant.addressHistory.0' },
  { id: 'addresses.movedInLastFiveYears', section: 'addresses', kind: 'boolean', required: true,
    prompt: 'Have you lived at any other address in the last five years?' },
  { id: 'addresses.priorAddresses', section: 'addresses', kind: 'longtext', required: true,
    prompt: 'List your previous addresses, with the dates you lived at each',
    help: 'The form has room for three. If you have more, we will continue them on the additional information page.',
    when: yes('addresses.movedInLastFiveYears') },

  // ---------------------------------------------------------- employment ---
  { id: 'employment.status', section: 'employment', kind: 'select', required: true,
    prompt: 'What is your current employment situation?',
    options: [
      { value: 'EMPLOYED', label: 'Employed' },
      { value: 'SELF_EMPLOYED', label: 'Self-employed' },
      { value: 'STUDENT', label: 'Student' },
      { value: 'UNEMPLOYED', label: 'Not currently working' },
      { value: 'RETIRED', label: 'Retired' },
    ] },
  { id: 'employment.employerName', section: 'employment', kind: 'text', required: true,
    prompt: 'Current employer name',
    when: (a) => a['employment.status'] === 'EMPLOYED' || a['employment.status'] === 'SELF_EMPLOYED' },
  { id: 'employment.history', section: 'employment', kind: 'longtext', required: true,
    prompt: 'Your employment for the last five years',
    help: 'Employer, job title, and dates. Include any gaps.' },

  // -------------------------------------------------------------- family ---
  { id: 'family.maritalStatus', section: 'family', kind: 'select', required: true,
    prompt: 'What is your current marital status?',
    profilePath: 'applicant.maritalStatus', formRef: 'I-485 Part 6',
    options: [
      { value: 'SINGLE', label: 'Single, never married' },
      { value: 'MARRIED', label: 'Married' },
      { value: 'DIVORCED', label: 'Divorced' },
      { value: 'WIDOWED', label: 'Widowed' },
      { value: 'SEPARATED', label: 'Legally separated' },
    ] },
  { id: 'family.spouseName', section: 'family', kind: 'text', required: true,
    prompt: "Your spouse's full legal name", when: eq('family.maritalStatus', 'MARRIED') },
  { id: 'family.marriageDate', section: 'family', kind: 'date', required: true,
    prompt: 'Date of marriage', when: eq('family.maritalStatus', 'MARRIED'),
    validate: notFuture },
  { id: 'family.priorMarriage', section: 'family', kind: 'boolean', required: true,
    prompt: 'Have you been married before?',
    when: (a) => a['family.maritalStatus'] !== 'SINGLE' && a['family.maritalStatus'] !== null
      && a['family.maritalStatus'] !== undefined },
  { id: 'family.hasChildren', section: 'family', kind: 'boolean', required: true,
    prompt: 'Do you have any children?',
    help: 'Include all children of any age, whether or not they live with you.',
    formRef: 'I-485 Part 7' },
  { id: 'family.childrenDetail', section: 'family', kind: 'longtext', required: true,
    prompt: 'List each child with their date and country of birth',
    when: yes('family.hasChildren') },
  { id: 'family.motherName', section: 'family', kind: 'text', required: true,
    prompt: "Your mother's full name", formRef: 'I-485 Part 5' },
  { id: 'family.fatherName', section: 'family', kind: 'text', required: true,
    prompt: "Your father's full name", formRef: 'I-485 Part 5' },

  // ---------------------------------------------------------- biographic ---
  { id: 'biographic.ethnicity', section: 'biographic', kind: 'select', required: true,
    prompt: 'Ethnicity', formRef: 'I-485 Part 8, Item 1',
    options: [
      { value: 'HISPANIC', label: 'Hispanic or Latino' },
      { value: 'NOT_HISPANIC', label: 'Not Hispanic or Latino' },
    ] },
  { id: 'biographic.race', section: 'biographic', kind: 'multiselect', required: true,
    prompt: 'Race (select all that apply)', formRef: 'I-485 Part 8, Item 2',
    options: [
      { value: 'WHITE', label: 'White' },
      { value: 'ASIAN', label: 'Asian' },
      { value: 'BLACK', label: 'Black or African American' },
      { value: 'AMERICAN_INDIAN', label: 'American Indian or Alaska Native' },
      { value: 'PACIFIC_ISLANDER', label: 'Native Hawaiian or Other Pacific Islander' },
    ] },
  { id: 'biographic.heightFeet', section: 'biographic', kind: 'number', required: true,
    prompt: 'Height (feet)', formRef: 'I-485 Part 8, Item 3',
    validate: (v) => (Number(v) >= 2 && Number(v) <= 8 ? null : 'Enter a height between 2 and 8 feet.') },
  { id: 'biographic.heightInches', section: 'biographic', kind: 'number', required: true,
    prompt: 'Height (inches)', formRef: 'I-485 Part 8, Item 3',
    validate: (v) => (Number(v) >= 0 && Number(v) <= 11 ? null : 'Enter 0 to 11 inches.') },
  { id: 'biographic.weight', section: 'biographic', kind: 'number', required: true,
    prompt: 'Weight (pounds)', formRef: 'I-485 Part 8, Item 4' },

  // --------------------------------------------------- eligibility (key) ---
  // These four are written out because each drives a checklist rule.
  { id: 'eligibility.arrested', section: 'eligibility', kind: 'boolean', required: true,
    prompt: 'Have you EVER been arrested, cited, charged, or detained by any law enforcement officer?',
    help: 'Include every incident, even if the charge was dropped or the record was expunged.',
    formRef: 'I-485 Part 9' },
  { id: 'eligibility.arrestDetail', section: 'eligibility', kind: 'longtext', required: true,
    prompt: 'Describe each incident: what happened, when, where, and the outcome',
    when: yes('eligibility.arrested') },
  { id: 'eligibility.workedWithoutAuth', section: 'eligibility', kind: 'boolean', required: true,
    prompt: 'Have you EVER worked in the United States without authorization?',
    formRef: 'I-485 Part 9, Item 11' },
  { id: 'eligibility.removalProceedings', section: 'eligibility', kind: 'boolean', required: true,
    prompt: 'Are you presently or have you EVER been in removal, exclusion, rescission, or deportation proceedings?',
    formRef: 'I-485 Part 9, Item 14' },
  { id: 'eligibility.jVisitorTwoYear', section: 'eligibility', kind: 'boolean', required: true,
    prompt: 'Were you a J nonimmigrant exchange visitor subject to the two-year foreign residence requirement?',
    when: eq('immigration.statusAtEntry', 'J1'), formRef: 'I-485 Part 9, Item 19' },
];

/** Content-addressed id: if USCIS rewords a question, it becomes a new one. */
const stableId = (text: string): string =>
  `eligibility.p9.${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;

const CURATED_TEXT = new Set(CURATED.map((q) => q.prompt));

/**
 * The remaining Part 9 questions, taken verbatim from the form.
 *
 * Their phrasing is legally load-bearing and the applicant is signing under
 * penalty of perjury, so the wording comes from the asset rather than being
 * retyped here. Generated ones are plain yes/no; anything needing follow-up
 * detail gets promoted into CURATED above.
 */
export const GENERATED_ELIGIBILITY: Question[] = (officialQuestions as Array<{
  part: number | null; text: string;
}>)
  .filter((q) => q.part === 9 && !CURATED_TEXT.has(q.text) && q.text.length <= 260)
  .map((q) => ({
    id: stableId(q.text),
    section: 'eligibility' as const,
    kind: 'boolean' as const,
    prompt: q.text,
    required: true,
    formRef: 'I-485 Part 9',
  }));

export const QUESTION_BANK: readonly Question[] = [...CURATED, ...GENERATED_ELIGIBILITY];

export const byId = new Map(QUESTION_BANK.map((q) => [q.id, q]));
