import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PDFBool, PDFDocument, PDFName } from 'pdf-lib';
import type { FormMapping, OverflowEntry, Profile } from '../../domain/forms/types';

const run = promisify(execFile);

export interface GenerateResult {
  readonly bytes: Buffer;
  readonly filled: number;
  readonly skipped: string[];
  readonly overflowUsed: number;
  readonly overflowDropped: number;
}

/**
 * USCIS ships its forms AES-encrypted with an empty user password, and pdf-lib
 * cannot decrypt them — every object lookup returns undefined and loading dies
 * with "Expected instance of PDFDict". qpdf strips the encryption; the result
 * is byte-identical in content.
 *
 * Cached next to the asset because it is deterministic and the same for every
 * case; doing it per request would fork qpdf on every generation.
 */
async function decryptedForm(mapping: FormMapping): Promise<Buffer> {
  const src = join(process.cwd(), mapping.assetDir, 'i-485.pdf');
  const cached = join(process.cwd(), '.cache', `${mapping.formCode}-${mapping.edition.replace(/\//g, '')}.pdf`);

  try {
    await access(cached);
    return await readFile(cached);
  } catch {
    await mkdir(join(process.cwd(), '.cache'), { recursive: true });
    await run('qpdf', ['--decrypt', '--object-streams=disable', src, cached]);
    return readFile(cached);
  }
}

/** The barcodes read "I-485|01/20/25|<page>" — an in-file statement of edition. */
function editionFromBarcode(doc: PDFDocument): string | null {
  const form = doc.getForm();
  for (const field of form.getFields()) {
    if (!field.getName().includes('PDF417BarCode')) continue;
    try {
      const value = form.getTextField(field.getName()).getText();
      const parts = value?.split('|');
      if (parts && parts.length >= 2 && parts[1]) return parts[1];
    } catch { /* not a text field */ }
  }
  return null;
}

/**
 * Fill a form from a profile.
 *
 * Refuses to fill a form whose embedded edition does not match the mapping.
 * USCIS rejects superseded editions outright, so producing a beautifully filled
 * wrong-edition form is worse than failing.
 */
export async function generateForm(
  mapping: FormMapping,
  profile: Profile,
  overflow: readonly OverflowEntry[] = [],
): Promise<GenerateResult> {
  const doc = await PDFDocument.load(await decryptedForm(mapping), { updateMetadata: false });
  const form = doc.getForm();

  const embedded = editionFromBarcode(doc);
  if (embedded && embedded !== mapping.edition) {
    throw new Error(
      `form asset is edition ${embedded} but the mapping targets ${mapping.edition}`,
    );
  }

  const skipped: string[] = [];
  let filled = 0;

  const setText = (name: string, value: string) => {
    try {
      form.getTextField(name).setText(value);
      filled += 1;
    } catch {
      skipped.push(name);
    }
  };

  for (const m of [...mapping.text, ...mapping.overflow.identity]) {
    const v = profile[m.path];
    if (v == null || v === '') continue;
    setText(m.pdf, m.transform ? m.transform(v) : v);
  }

  for (const d of mapping.dropdowns) {
    const v = profile[d.path];
    if (v == null || v === '') continue;
    try {
      form.getDropdown(d.pdf).select(d.transform ? d.transform(v) : v);
      filled += 1;
    } catch {
      skipped.push(d.pdf);
    }
  }

  for (const c of mapping.checkboxes) {
    if (profile[c.path] !== c.equals) continue;
    try {
      form.getCheckBox(c.pdf).check();
      filled += 1;
    } catch {
      skipped.push(c.pdf);
    }
  }

  // The A-Number header repeats on every page; filling only the first leaves
  // the rest looking blank to a reviewing officer.
  if (mapping.pageHeader) {
    const raw = profile[mapping.pageHeader.path];
    if (raw) {
      const value = mapping.pageHeader.transform ? mapping.pageHeader.transform(raw) : raw;
      for (const name of mapping.pageHeader.fields) setText(name, value);
    }
  }

  const slots = mapping.overflow.slots;
  const used = Math.min(overflow.length, slots.length);
  for (let i = 0; i < used; i++) {
    const e = overflow[i]!;
    const slot = slots[i]!;
    setText(slot.page, e.pageNumber);
    setText(slot.part, e.partNumber);
    setText(slot.item, e.itemNumber);
    setText(slot.text, e.text);
  }

  // Part 14, the overflow field, is a rich-text field. pdf-lib regenerates
  // every appearance stream on save and cannot parse rich text, so appearance
  // generation is delegated to the viewer via NeedAppearances.
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  const bytes = Buffer.from(await doc.save({ updateFieldAppearances: false }));

  return {
    bytes,
    filled,
    skipped,
    overflowUsed: used,
    // More continuations than slots needs additional sheets, which this does
    // not yet produce. Reported rather than silently truncated.
    overflowDropped: Math.max(0, overflow.length - slots.length),
  };
}

export async function writeForm(path: string, bytes: Buffer): Promise<void> {
  await writeFile(path, bytes);
}
