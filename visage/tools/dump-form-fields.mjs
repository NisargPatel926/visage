#!/usr/bin/env node
/**
 * Dump every AcroForm field from an official USCIS PDF to JSON.
 *
 * Form mappings are written against this dump, never from memory. USCIS field
 * names are not guessable: the I-485 mixes `Pt1Line1_FamilyName[0]` with
 * `P4Line7_State[0]`, and checkbox export values are opaque strings such as
 * "11A", "1fA", "3a0".
 *
 *   node tools/dump-form-fields.mjs <form.pdf> <out.json>
 *
 * Note: USCIS PDFs are AES-encrypted with an empty user password. pdfjs handles
 * that transparently for reading. Writing requires a qpdf --decrypt pass first
 * (see tools/prepare-form.sh).
 */
import fs from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: dump-form-fields.mjs <form.pdf> <out.json>');
  process.exit(1);
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(input)),
}).promise;

const fieldObjects = await doc.getFieldObjects();
if (!fieldObjects) {
  console.error(`${input}: no AcroForm fields found`);
  process.exit(1);
}

const rows = [];
const byType = {};
for (const name of Object.keys(fieldObjects)) {
  for (const f of fieldObjects[name]) {
    byType[f.type || 'container'] = (byType[f.type || 'container'] || 0) + 1;
    rows.push({
      name,
      leaf: name.split('.').pop(),
      type: f.type,
      page: f.page,
      rect: f.rect?.map((v) => Math.round(v)),
      // Checkbox "on" state. Opaque and form-specific — the mapping needs it verbatim.
      exportValues: f.exportValues,
      // Dropdown options, including the empty sentinel, which is sometimes
      // "" and sometimes " " on the same form.
      items: f.items,
      maxLen: f.maxLen,
      hidden: f.hidden,
      required: f.required,
      readOnly: f.readOnly,
    });
  }
}

fs.writeFileSync(output, JSON.stringify(rows, null, 2));
console.log(`${input}: ${doc.numPages} pages, ${rows.length} widgets`);
console.log(`types: ${JSON.stringify(byType)}`);
console.log(`wrote ${output}`);
