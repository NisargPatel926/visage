#!/usr/bin/env node
/**
 * Pull the official question wording out of a USCIS form.
 *
 *   node tools/extract-questions.mjs <form.pdf> <out.json>
 *
 * Why bother: Part 9 of the I-485 is 155 fields of inadmissibility questions
 * whose exact phrasing is legally load-bearing ("Have you EVER..."). Retyping
 * them invites drift between what we ask a client and what they are signing.
 *
 * Caveat worth knowing before trusting the output: PDF text extraction returns
 * draw order, not reading order. Item numbers sometimes precede their question
 * and sometimes trail it, and the Yes/No labels for a whole page arrive in one
 * clump. So this recovers *sentences reliably* and *numbering unreliably* — it
 * is an inventory to map against fields.json by hand, not a finished question
 * bank.
 */
import fs from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: extract-questions.mjs <form.pdf> <out.json>');
  process.exit(1);
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(input)) }).promise;

const questions = [];
let currentPart = null;

for (let p = 1; p <= doc.numPages; p++) {
  const tc = await (await doc.getPage(p)).getTextContent();
  const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');

  // Section headers are set larger than body text. Matching on the string
  // alone picks up cross-references ("use the space provided in Part 14"),
  // which mis-attributed every question on pages 1-2 to Part 14.
  let best = null;
  for (const item of tc.items) {
    const m = /^Part (\d+)\./.exec((item.str ?? '').trim());
    if (!m) continue;
    const size = Math.abs(item.transform?.[3] ?? item.height ?? 0);
    if (!best || size > best.size) best = { number: Number(m[1]), size };
  }
  if (best && best.size >= 9) {
    const title = text.match(new RegExp(`Part ${best.number}\\.\\s+([A-Z][^?]{4,60}?)(?:\\s+\\(continued\\)|\\s+\\d+\\.|\\s{2})`));
    currentPart = { number: best.number, title: title?.[1]?.trim() ?? null };
  }

  // Interrogatives only. Anything ending in '?' is a question we must ask;
  // instructions and headings never do.
  for (const m of text.matchAll(/((?:Have|Has|Are|Is|Do|Did|Were|Was|Will|Would|If)\b[^?]{15,400}\?)/g)) {
    const q = m[1].replace(/\s+/g, ' ').trim();
    // Item numbers bleed in from neighbouring draw calls; strip a leading one.
    const cleaned = q.replace(/^\d+\.\s*/, '');
    // Field labels sometimes run into a following question in draw order.
    // A real question is one sentence; these fragments carry form-label tells.
    if (/\(if applicable\)|Family Name \(Last Name\)|Given Name \(First Name\)/.test(cleaned)) continue;
    if (cleaned.length > 320) continue;
    if (questions.some((x) => x.text === cleaned)) continue;
    questions.push({ page: p, part: currentPart?.number ?? null, partTitle: currentPart?.title ?? null, text: cleaned });
  }
}

fs.writeFileSync(output, JSON.stringify(questions, null, 2));

const byPart = questions.reduce((acc, q) => { acc[q.part ?? '?'] = (acc[q.part ?? '?'] ?? 0) + 1; return acc; }, {});
console.log(`${input}: ${questions.length} questions`);
console.log('by part:', JSON.stringify(byPart));
console.log(`wrote ${output}`);
