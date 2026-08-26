# Visage

Secure client portal and attorney console for preparing U.S. green card applications.

Clients upload their documents; the system extracts the facts inside them, builds a canonical
applicant profile, and fills the official USCIS forms. Attorneys review, correct, and sign off in a
separate console. Both sides end with one print-ready filing package.

**Status: Phase 0 complete.** Foundations are built and tested — tenant isolation,
envelope encryption, auth primitives, and the append-only audit log. No UI yet.

## Start here

**[`PLAN.md`](./PLAN.md)** — the full implementation plan: scope, architecture, data model,
security and tenant-isolation design, document-extraction pipeline, form-filling engine, phased
delivery, risks, and open questions.

## What's in the tree

```
PLAN.md                              the plan
prisma/schema.prisma                 data model
prisma/sql/roles.sql                 visage_owner / visage_app / visage_directory
prisma/sql/rls.sql                   row-level security policies  <- the isolation control
scripts/setup-db.mjs                 idempotent bootstrap: roles -> schema -> RLS -> verify
src/server/db/tenant.ts              withTenant(): the boundary every query passes through
src/server/crypto/                   envelope encryption, field encryption, blind index
src/server/auth/                     argon2 passwords, TOTP, session tokens
src/server/audit/log.ts              append-only audit log
tests/isolation/                     the Phase 0 acceptance gate
tools/dump-form-fields.mjs           dump a USCIS PDF's AcroForm fields to JSON
tools/prepare-form.sh                qpdf decrypt pass, required before pdf-lib can fill
assets/forms/i-485/2025-01-20/       official I-485 (edition 01/20/25) + instructions + field dump
```

## Getting started

```bash
docker compose up -d          # Postgres 16
cp .env.example .env
npm install
npm run db:generate
node scripts/setup-db.mjs     # roles, schema, RLS — idempotent, verifies itself
npm test                      # 51 tests
```

`setup-db.mjs` exits non-zero if any tenant table lacks RLS, FORCE, or a policy.
That check exists because `prisma db push` does not know policies exist and will
happily drop them — the app would keep working and quietly stop isolating.

## The isolation model

Three roles, and the application never gets the powerful one:

| Role | Purpose | Can bypass RLS |
|---|---|---|
| `visage_owner` | owns tables, runs migrations | no |
| `visage_app` | the application | **no** |
| `visage_directory` | owns one function: firm lookup at login | yes, but cannot log in |

Every tenant table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. `FORCE` is the
half that is easy to omit and impossible to notice: without it the table owner
bypasses every policy, and an isolation suite run as the owner passes vacuously.

Request context is transaction-scoped, so a pooled connection carries nothing
between requests:

```ts
await withTenant({ userId, firmId, role }, async (tx) => {
  return tx.case.findMany();   // policies scope this; no WHERE clause needed
});
```

A query issued with no tenant context returns **zero rows**, not every row. That
is the property that turns a forgotten `WHERE` clause into a visible bug rather
than a cross-tenant disclosure.

Case-scoped rows also carry a composite foreign key `(caseId, firmId)` →
`Case(id, firmId)`, so a document physically cannot reference a case in another
firm even if RLS were misconfigured.

**Honest limit:** RLS defends against a missing `WHERE` clause, not against SQL
injection that can issue its own `set_config`. That is what parameterized
queries and the repository boundary are for.

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
