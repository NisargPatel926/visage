# Visage

Secure client portal and attorney console for preparing U.S. green card applications.

Clients upload their documents; the system extracts the facts inside them, builds a canonical
applicant profile, and fills the official USCIS forms. Attorneys review, correct, and sign off in a
separate console. Both sides end with one print-ready filing package.

**Status: planning. No application code yet.**

## Start here

**[`PLAN.md`](./PLAN.md)** — the full implementation plan: scope, architecture, data model,
security and tenant-isolation design, document-extraction pipeline, form-filling engine, phased
delivery, risks, and open questions.

## What's in the tree

```
PLAN.md                              the plan
tools/dump-form-fields.mjs           dump a USCIS PDF's AcroForm fields to JSON
tools/prepare-form.sh                qpdf decrypt pass, required before pdf-lib can fill
assets/forms/i-485/2025-01-20/       official I-485 (edition 01/20/25) + instructions + field dump
```

## Reproducing the form analysis

The findings in `PLAN.md` §7 came from the real form, not from assumptions:

```bash
npm install pdfjs-dist pdf-lib
apt-get install qpdf

# 820 widgets across 24 pages
node tools/dump-form-fields.mjs assets/forms/i-485/2025-01-20/i-485.pdf /tmp/fields.json

# pdf-lib cannot read the encrypted original; this makes it fillable
tools/prepare-form.sh assets/forms/i-485/2025-01-20/i-485.pdf
```

Three things that shape the build, all verified against the file:

1. The USCIS PDF is **AES-encrypted**, and `pdf-lib` cannot load it without the qpdf pass.
2. **Part 14** — the overflow/continuation field — is **rich text**, which breaks `pdf-lib`'s
   appearance generation on save. Requires `NeedAppearances`.
3. The per-page **PDF417 barcodes are static** (`I-485|01/20/25|<page>`), so filling never
   invalidates them and they double as an in-file edition assertion.

## Repository home

This is intended to live at `NisargPatel926/visage`. It currently sits under `visage/` in
`git_practice` because the GitHub App backing the authoring session lacks repository-creation
permission. The directory is a self-contained project root and moves without path rewrites.
