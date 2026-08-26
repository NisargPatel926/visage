import { describe, expect, it } from 'vitest';
import { I485_MAPPING } from '../../src/domain/forms/i485';
import { overflowFromAnswers, profileFromAnswers } from '../../src/domain/forms/profile';
import { alienNumber, upper, usDate } from '../../src/domain/forms/types';
import { generateForm } from '../../src/server/forms/generate';
import type { Answers } from '../../src/domain/intake/types';
import fieldDump from '../../assets/forms/i-485/2025-01-20/fields.json' with { type: 'json' };

/** Read values back out of a produced PDF — the golden-file mechanism. */
async function readBack(bytes: Buffer): Promise<Record<string, string>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const objects = await doc.getFieldObjects();
  const out: Record<string, string> = {};
  for (const name of Object.keys(objects ?? {})) {
    for (const f of objects![name]!) {
      const v = (f as { value?: unknown }).value;
      if (typeof v === 'string' && v !== '') out[name] = v;
    }
  }
  return out;
}

const BASE: Answers = {
  'basics.familyName': 'Garcia',
  'basics.givenName': 'Maria',
  'basics.middleName': 'Elena',
  'basics.dateOfBirth': '1990-03-14',
  'basics.countryOfBirth': 'Mexico',
  'basics.countryOfCitizenship': 'Mexico',
  'immigration.hasANumber': true,
  'immigration.aNumber': 'A123456789',
  'immigration.passportNumber': 'X1234567',
  'immigration.dateOfArrival': '2019-08-20',
  'biographic.heightFeet': 5,
  'biographic.heightInches': 6,
};

describe('transforms', () => {
  it('converts ISO dates to the MM/DD/YYYY every USCIS form uses', () => {
    expect(usDate('1990-03-14')).toBe('03/14/1990');
    expect(usDate('not a date')).toBe('not a date');
  });

  it('strips the A prefix and separators from an A-Number', () => {
    expect(alienNumber('A123456789')).toBe('123456789');
    expect(alienNumber('A 123-456-789')).toBe('123456789');
  });

  it('upper-cases names', () => expect(upper('Garcia')).toBe('GARCIA'));
});

describe('mapping integrity', () => {
  const known = new Set(fieldDump.filter((f) => f.type).map((f) => f.name));

  it('references only fields that exist on the real form', () => {
    // The check that would have caught every hand-typed field name.
    const referenced = [
      ...I485_MAPPING.text.map((m) => m.pdf),
      ...I485_MAPPING.dropdowns.map((m) => m.pdf),
      ...I485_MAPPING.checkboxes.map((m) => m.pdf),
      ...I485_MAPPING.overflow.identity.map((m) => m.pdf),
      ...I485_MAPPING.overflow.slots.flatMap((s) => [s.text, s.page, s.part, s.item]),
    ];
    const missing = referenced.filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('targets the edition that is actually vendored', () => {
    expect(I485_MAPPING.edition).toBe('01/20/25');
  });
});

describe('profile derivation', () => {
  it('maps answers onto canonical paths', () => {
    const p = profileFromAnswers(BASE);
    expect(p['applicant.name.family']).toBe('Garcia');
    expect(p['applicant.dateOfBirth']).toBe('1990-03-14'); // ISO in the profile
    expect(p['applicant.height.feet']).toBe('5');
  });

  it('drops answers from abandoned branches', () => {
    // Said married, named a spouse, switched to single: the A-Number question
    // is hidden when hasANumber is false, so its answer must not survive.
    const p = profileFromAnswers({ ...BASE, 'immigration.hasANumber': false });
    expect(p['applicant.alienNumber']).toBeUndefined();
  });

  it('collects long answers as Part 14 continuations with their item numbers', () => {
    const entries = overflowFromAnswers({
      ...BASE,
      'eligibility.arrested': true,
      'eligibility.arrestDetail': 'Cited for trespass in 2015; charge dismissed.',
    });
    const arrest = entries.find((e) => e.partNumber === '9');
    expect(arrest?.itemNumber).toBe('1');
    expect(arrest?.text).toMatch(/dismissed/);
  });
});

describe('generating the I-485', () => {
  it('fills the form and the values read back correctly', async () => {
    const result = await generateForm(I485_MAPPING, profileFromAnswers(BASE));
    const values = await readBack(result.bytes);

    const leaf = (suffix: string) =>
      Object.entries(values).find(([k]) => k.endsWith(suffix))?.[1];

    expect(leaf('Pt1Line1_FamilyName[0]')).toBe('GARCIA');
    expect(leaf('Pt1Line1_GivenName[0]')).toBe('MARIA');
    expect(leaf('Pt1Line3_DOB[0]')).toBe('03/14/1990');
    expect(leaf('Pt1Line10_PassportNum[0]')).toBe('X1234567');
    expect(leaf('Pt1Line4_AlienNumber[0]')).toBe('123456789');
    expect(leaf('Pt7Line3_HeightFeet[0]')).toBe('5');
    expect(result.filled).toBeGreaterThan(20);
  }, 30_000);

  it('fills the A-Number header on every one of the 24 pages', async () => {
    // Filling only the first leaves 23 pages looking blank to a reviewer.
    const result = await generateForm(I485_MAPPING, profileFromAnswers(BASE));
    const values = await readBack(result.bytes);
    const headers = Object.entries(values)
      .filter(([k]) => /\.AlienNumber\[\d+\]$/.test(k))
      .map(([, v]) => v);

    expect(headers).toHaveLength(24);
    expect(new Set(headers)).toEqual(new Set(['123456789']));
  }, 30_000);

  it('writes continuations into the Part 14 slots with page, part, and item', async () => {
    const answers: Answers = {
      ...BASE,
      'eligibility.arrested': true,
      'eligibility.arrestDetail': 'Cited for trespass in 2015; charge dismissed.',
      'basics.otherNames': true,
      'basics.otherNamesDetail': 'Maria Elena Ruiz (maiden name)',
    };
    const result = await generateForm(
      I485_MAPPING, profileFromAnswers(answers), overflowFromAnswers(answers),
    );
    const values = await readBack(result.bytes);
    const all = Object.values(values).join(' | ');

    expect(result.overflowUsed).toBe(2);
    expect(result.overflowDropped).toBe(0);
    expect(all).toMatch(/maiden name/);
    expect(all).toMatch(/dismissed/);
  }, 30_000);

  it('repeats the applicant name on the continuation sheet', async () => {
    const result = await generateForm(I485_MAPPING, profileFromAnswers(BASE));
    const values = await readBack(result.bytes);
    expect(Object.entries(values).find(([k]) => k.endsWith('Pt1Line1_FamilyName[1]'))?.[1])
      .toBe('GARCIA');
  }, 30_000);

  it('reports rather than silently truncating more continuations than slots', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      partNumber: '9', itemNumber: String(i + 1), pageNumber: '13', text: `Entry ${i + 1}`,
    }));
    const result = await generateForm(I485_MAPPING, profileFromAnswers(BASE), many);
    expect(result.overflowUsed).toBe(4);
    expect(result.overflowDropped).toBe(3);
  }, 30_000);

  it('leaves unanswered fields blank rather than inventing values', async () => {
    const result = await generateForm(I485_MAPPING, profileFromAnswers({
      'basics.familyName': 'Garcia',
    }));
    const values = await readBack(result.bytes);
    expect(Object.entries(values).find(([k]) => k.endsWith('Pt1Line3_DOB[0]'))).toBeUndefined();
  }, 30_000);

  it('never references a field the real form does not have', async () => {
    const result = await generateForm(I485_MAPPING, profileFromAnswers(BASE));
    expect(result.skipped).toEqual([]);
  }, 30_000);

  it('refuses to fill a form whose embedded edition differs from the mapping', async () => {
    // USCIS rejects superseded editions, so a beautifully filled wrong-edition
    // form is worse than an error.
    await expect(
      generateForm({ ...I485_MAPPING, edition: '01/01/99' }, profileFromAnswers(BASE)),
    ).rejects.toThrow(/edition/);
  }, 30_000);
});
