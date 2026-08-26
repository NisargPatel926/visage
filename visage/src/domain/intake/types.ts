export type AnswerValue = string | number | boolean | string[] | null;
export type Answers = Readonly<Record<string, AnswerValue>>;

export const SECTIONS = [
  { id: 'basics', title: 'About you', blurb: 'Your name and where you were born.' },
  { id: 'immigration', title: 'Immigration history', blurb: 'How you entered and your status today.' },
  { id: 'addresses', title: 'Where you have lived', blurb: 'Your addresses for the last five years.' },
  { id: 'employment', title: 'Work history', blurb: 'Your employers for the last five years.' },
  { id: 'family', title: 'Family', blurb: 'Marriage, children, and parents.' },
  { id: 'biographic', title: 'Biographic information', blurb: 'Details USCIS records on every applicant.' },
  { id: 'eligibility', title: 'Eligibility questions', blurb: 'Required yes/no questions. Answer honestly — your attorney reviews every one.' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

export type QuestionKind =
  | 'text' | 'longtext' | 'date' | 'number'
  | 'boolean' | 'select' | 'multiselect';

export interface Option {
  readonly value: string;
  readonly label: string;
}

export interface Question {
  readonly id: string;
  readonly section: SectionId;
  readonly prompt: string;
  /** Explains what the question is for. Never advises what to answer. */
  readonly help?: string;
  readonly kind: QuestionKind;
  readonly options?: readonly Option[];
  readonly required?: boolean;
  /** Branching. Absent means always shown. */
  readonly when?: (answers: Answers) => boolean;
  /** Where this lands in the canonical profile, when it maps to one fact. */
  readonly profilePath?: string;
  /** Which item on which form this answers — provenance in the other direction. */
  readonly formRef?: string;
  readonly validate?: (value: AnswerValue) => string | null;
}

export interface ValidationIssue {
  readonly questionId: string;
  readonly message: string;
}

export interface Progress {
  readonly answered: number;
  readonly total: number;
  readonly percent: number;
  readonly bySection: ReadonlyArray<{
    readonly section: SectionId;
    readonly title: string;
    readonly answered: number;
    readonly total: number;
    readonly complete: boolean;
  }>;
}
