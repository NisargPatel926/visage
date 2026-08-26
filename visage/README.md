# Visage

Secure client portal and attorney console for preparing U.S. green card applications.

Clients upload their documents; the system extracts the facts inside them, builds a canonical
applicant profile, and fills the official USCIS forms. Attorneys review, correct, and sign off in a
separate console. Both sides end with one print-ready filing package.

**Status: Phases 0-2 and 4 complete.** Tenant isolation, encryption and audit
foundations; intake questionnaire and checklist engine; the encrypted document
pipeline; and a filled, printable Form I-485 generated from the applicant's
answers. 157 tests passing.

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
src/domain/intake/                   question bank, branching, validation, progress
src/domain/checklist/                requirement rules (pure functions over answers)
src/server/repositories/             intake, checklist sync, case queue
src/server/storage/                  object storage: quarantine and main buckets
src/server/documents/                scan, sanitise, encrypt, store, read
src/domain/forms/                    profile derivation and the I-485 field mapping
src/server/forms/generate.ts         pdf-lib filler, edition assertion, Part 14 overflow
src/app/                             login, client portal, questionnaire, staff console
tests/isolation/                     the Phase 0 acceptance gate
tests/intake/ tests/checklist/       Phase 1 engines and the end-to-end journey
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
npm run db:setup              # roles, schema, RLS — idempotent, verifies itself
npm run db:seed               # one firm, one attorney, one client, one case
npm run demo                  # a realistic applicant: intake, checklist, a document
npm test                      # 157 tests
npm run dev                   # http://localhost:3000
```

Sign in with firm code `alpha`, as `client@alpha.test` or `attorney@alpha.test`,
password `visage-dev-password`. The seed script refuses to run when
`NODE_ENV=production`.

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

### Authentication is pre-tenant

Login is a genuine exception, and it is worth understanding before changing it.
A user must be found before we know their tenant, and a session read before we
know who is asking — RLS correctly refuses both, so an ordinary Prisma query in
the auth path returns zero rows and login can never succeed.

The answer is a small, enumerable set of `SECURITY DEFINER` functions
(`app.resolve_firm`, `app.auth_find_user`, `app.auth_find_session`,
`app.auth_create_session`, `app.auth_touch_session`, `app.auth_revoke_session`),
owned by `visage_directory` and executable only by `visage_app`. Each is an
exact-match lookup returning at most one row. That role holds grants on exactly
three tables — `Firm`, `User`, `Session` — and a test asserts it can reach
nothing else. Everything after login goes through `withTenant` like any other
query.

## Intake and the checklist

The questionnaire is a declarative bank of questions with branching predicates;
the checklist is a set of pure rules over the answers. Both are data, so each
rule is testable on its own:

```ts
deriveRequirements({ 'family.maritalStatus': 'MARRIED' })  // -> MARRIAGE_CERTIFICATE
deriveRequirements({ 'eligibility.arrested': true })       // -> COURT_DISPOSITIONS
```

Three behaviours worth knowing:

- **Answers to hidden questions are kept but not counted.** If someone says
  married, names a spouse, then switches to single, the spouse name is retained
  (so flipping back does not lose their typing) but excluded from everything
  downstream, so no marriage certificate is requested.
- **Requirements are withdrawn, never deleted.** A changed answer must not
  destroy an uploaded document or the attorney comments on it. An item the
  attorney already accepted is never withdrawn at all.
- **Not everything is uploadable.** Form I-693 arrives sealed from the civil
  surgeon; opening it to scan voids the exam, so that item is tracked with no
  upload control and says so.

The 63 Part 9 eligibility questions are extracted verbatim from the official
form (`tools/extract-questions.mjs`) rather than retyped — the applicant signs
under penalty of perjury, so the wording is load-bearing.

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

## The document pipeline

```
upload -> quarantine bucket -> scan -> sanitise -> encrypt -> main bucket -> row
```

The order is the point. Presigned direct-to-bucket uploads are the usual pattern
and are wrong here: they put unscanned attacker-controlled bytes in the bucket we
serve from. Nothing is ever served out of quarantine, and the quarantine object
is deleted whether ingestion succeeds or fails.

- **PDFs are rewritten by qpdf**, which drops JavaScript, embedded files, and
  launch actions. Rewriting rather than rasterising keeps the text layer, which
  the Phase 3 extraction will need.
- **Images are re-encoded by sharp**, which drops EXIF. Passport photos routinely
  carry the GPS coordinates of someone's home.
- **Type is decided by magic bytes**, never the declared MIME. Anything
  unrecognised is rejected rather than stored with a guessed content type.
- **Re-uploads supersede, never overwrite**, so replacing a document does not take
  the attorney's annotations with it.
- **Downloads never hand out a bucket URL.** Every read goes through a route that
  authorises via RLS, audits, decrypts, and streams.

The bundled scanner is structural, not antivirus: it catches active content and
type confusion, and it flags EICAR so the pipeline is exercised in CI. Set
`SCANNER=clamav` in production.

A rejected upload still writes an audit row, and it is written in its own
transaction — the rejection rolls the main transaction back, and a record of a
blocked upload must not roll back with it.

## Form I-485

```bash
npm run demo   # then open the case in the console and click "Open filled I-485"
```

The mapping (`src/domain/forms/i485.ts`) is written against the committed field
dump, never from memory. Three things that only the real form tells you:

- **The A-Number repeats in the header of all 24 pages.** Filling only the first
  leaves the rest looking blank. The names cannot be derived either — the
  subform indices skip 19, so `#subform[i].AlienNumber[i]` is right for the first
  nineteen pages and wrong for the last five. The field list comes from the dump.
- **Part 14 has exactly four continuation slots**, each needing a page, part, and
  item number. More continuations than slots is reported, never silently
  truncated — the demo applicant needs five and the generator says so.
- **The generator refuses to fill a form whose embedded barcode edition does not
  match the mapping.** USCIS rejects superseded editions, so a beautifully filled
  wrong-edition form is worse than an error.

Golden-file tests fill a fixture, save, and read the values back out of the
produced PDF. There is also a test asserting every field name in the mapping
exists on the real form.