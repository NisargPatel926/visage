import type { Answers } from '../intake/types';

export interface ChecklistRule {
  readonly key: string;
  readonly title: string;
  /**
   * Shown to the applicant. Says what the document is for and why USCIS wants
   * it — never what the applicant should do about their situation. Telling
   * someone what to file is practising law; this software does not.
   */
  readonly rationale: string;
  readonly acceptedDocTypes: readonly string[];
  readonly required: boolean;
  /**
   * Some items are tracked but never collected through the portal. The medical
   * exam is the one that matters: Form I-693 arrives from the civil surgeon in
   * a sealed envelope, and opening it to scan it voids the exam.
   */
  readonly uploadable: boolean;
  readonly when?: (a: Answers) => boolean;
}

const always = undefined;
const yes = (id: string) => (a: Answers) => a[id] === true;

export const CHECKLIST_RULES: readonly ChecklistRule[] = [
  // ------------------------------------------------------------- always ---
  {
    key: 'PASSPORT_BIO',
    title: 'Passport biographic page',
    rationale: 'Confirms your identity, date of birth, and nationality.',
    acceptedDocTypes: ['PASSPORT_BIO'],
    required: true, uploadable: true, when: always,
  },
  {
    key: 'BIRTH_CERTIFICATE',
    title: 'Birth certificate',
    rationale: 'Establishes your date and place of birth and your parents’ names. If it is not in English, a certified translation is needed too.',
    acceptedDocTypes: ['BIRTH_CERT'],
    required: true, uploadable: true, when: always,
  },
  {
    key: 'PHOTOS',
    title: 'Two passport-style photographs',
    rationale: 'USCIS requires two identical colour photographs taken within the last 30 days.',
    acceptedDocTypes: ['PHOTO'],
    required: true, uploadable: true, when: always,
  },
  {
    key: 'MEDICAL_EXAM',
    title: 'Medical examination (Form I-693)',
    rationale: 'A USCIS-designated civil surgeon completes this and gives you a SEALED envelope. Do not open it, and do not scan it — an opened envelope voids the exam. Bring it to your attorney unopened, or file it sealed.',
    acceptedDocTypes: [],
    required: true, uploadable: false, when: always,
  },

  // ------------------------------------------------------------- status ---
  {
    key: 'I94',
    title: 'Form I-94 arrival/departure record',
    rationale: 'Shows the date and terms of your most recent admission to the United States.',
    acceptedDocTypes: ['I94'],
    required: true, uploadable: true,
    when: (a) => a['immigration.statusAtEntry'] !== 'NO_INSPECTION',
  },
  {
    key: 'I20',
    title: 'Form I-20',
    rationale: 'Documents your student status and the school that issued it.',
    acceptedDocTypes: ['I20'],
    required: true, uploadable: true,
    when: (a) => a['immigration.statusAtEntry'] === 'F1',
  },
  {
    key: 'I797_NOTICES',
    title: 'Form I-797 approval notices',
    rationale: 'Documents each approval of your petition or change of status.',
    acceptedDocTypes: ['I797_NOTICE'],
    required: true, uploadable: true,
    when: (a) => a['immigration.statusAtEntry'] === 'H1B',
  },
  {
    key: 'J1_WAIVER',
    title: 'J-1 two-year requirement waiver or compliance evidence',
    rationale: 'Evidence that the two-year foreign residence requirement was met or waived.',
    acceptedDocTypes: ['J1_WAIVER'],
    required: true, uploadable: true,
    when: yes('eligibility.jVisitorTwoYear'),
  },
  {
    key: 'EAD_COPY',
    title: 'Employment Authorization Document',
    rationale: 'A copy of your current EAD card, front and back.',
    acceptedDocTypes: ['EAD'],
    required: false, uploadable: true,
    when: yes('immigration.hasEad'),
  },

  // ------------------------------------------------------------- family ---
  {
    key: 'MARRIAGE_CERTIFICATE',
    title: 'Marriage certificate',
    rationale: 'Proof of your current marriage.',
    acceptedDocTypes: ['MARRIAGE_CERT'],
    required: true, uploadable: true,
    when: (a) => a['family.maritalStatus'] === 'MARRIED',
  },
  {
    key: 'PRIOR_MARRIAGE_TERMINATION',
    title: 'Divorce decree or death certificate',
    rationale: 'Proof that every previous marriage legally ended.',
    acceptedDocTypes: ['DIVORCE_DECREE', 'DEATH_CERT'],
    required: true, uploadable: true,
    when: (a) =>
      a['family.priorMarriage'] === true ||
      a['family.maritalStatus'] === 'DIVORCED' ||
      a['family.maritalStatus'] === 'WIDOWED',
  },
  {
    key: 'CHILDREN_BIRTH_CERTIFICATES',
    title: "Children's birth certificates",
    rationale: 'Establishes each child’s relationship to you.',
    acceptedDocTypes: ['BIRTH_CERT'],
    required: true, uploadable: true,
    when: yes('family.hasChildren'),
  },

  // --------------------------------------------------------- employment ---
  {
    key: 'TAX_RETURNS',
    title: 'Most recent federal tax return',
    rationale: 'Supports the financial portion of your application.',
    acceptedDocTypes: ['TAX_RETURN'],
    required: true, uploadable: true,
    when: (a) => a['employment.status'] === 'EMPLOYED' || a['employment.status'] === 'SELF_EMPLOYED',
  },
  {
    key: 'PAYSTUBS',
    title: 'Recent pay statements',
    rationale: 'Your six most recent pay statements, as evidence of current income.',
    acceptedDocTypes: ['PAYSTUB'],
    required: true, uploadable: true,
    when: (a) => a['employment.status'] === 'EMPLOYED',
  },

  // -------------------------------------------------------- eligibility ---
  {
    key: 'COURT_DISPOSITIONS',
    title: 'Certified court disposition for every incident',
    rationale: 'USCIS requires a certified record for each arrest, citation, or charge — including incidents that were dismissed, expunged, or sealed.',
    acceptedDocTypes: ['COURT_RECORD'],
    required: true, uploadable: true,
    when: yes('eligibility.arrested'),
  },
  {
    key: 'REMOVAL_PROCEEDING_RECORDS',
    title: 'Immigration court records',
    rationale: 'Any notice to appear, order, or decision from your proceedings.',
    acceptedDocTypes: ['IMMIGRATION_COURT_RECORD'],
    required: true, uploadable: true,
    when: yes('eligibility.removalProceedings'),
  },
  {
    key: 'UNAUTHORIZED_WORK_EXPLANATION',
    title: 'Written explanation of unauthorized employment',
    rationale: 'A written account of the dates and circumstances, for your attorney to review.',
    acceptedDocTypes: ['STATEMENT'],
    required: true, uploadable: true,
    when: yes('eligibility.workedWithoutAuth'),
  },
];
