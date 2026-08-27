# git_practice

This repository started as a Git learning sandbox and now also hosts a full
project. Those are two unrelated things sharing one URL, which is worth knowing
before you go looking for something.

| Directory | What it is |
|---|---|
| [`visage/`](./visage) | **The project.** A secure client portal and attorney console for preparing U.S. green card applications. |
| [`docs/`](./docs) | A static walkthrough of Visage, published via GitHub Pages. Screenshots, not source. |
| `ReadME.txt` | The original one-line file from the Git tutorial this repo began as. Kept for history; safe to delete. |

---

## Visage

Lawyers give their clients a login. The client answers a branching
questionnaire, and from those answers the system builds a personalised checklist
of documents to collect. They upload passports, paystubs, and prior USCIS
notices through an encrypted pipeline. Those facts flow into one canonical
profile, and the profile fills the official USCIS forms. The attorney reviews
everything in a separate console and signs off; nothing reaches a filable state
without them.

**Start here:**

- **[`visage/README.md`](./visage/README.md)** — how to run it, the isolation
  model, the document pipeline, and the form mapping.
- **[`visage/PLAN.md`](./visage/PLAN.md)** — the full implementation plan:
  scope, architecture, security design, phased delivery, risks, and open
  questions.

**Status:** Phases 0, 1, 2 and 4 are built and tested — tenant isolation,
encryption and audit foundations; the intake questionnaire and checklist engine;
the document pipeline; and a filled, printable Form I-485. 157 tests passing.
Phase 3 (document extraction) and Phases 5–7 (attorney sign-off, secure chat,
package assembly) are not built.

### Layout

```
visage/
  PLAN.md                    the implementation plan
  README.md                  setup, architecture, and the form findings

  prisma/
    schema.prisma            data model
    sql/roles.sql            the three database roles
    sql/rls.sql              row-level security policies — the isolation control

  src/
    domain/                  pure logic, no database and no clock
      intake/                question bank, branching, validation, progress
      checklist/             requirement rules over the answers
      forms/                 profile derivation and the I-485 field mapping
    server/                  everything that touches state
      db/tenant.ts           withTenant(): the boundary every query passes through
      crypto/                envelope encryption, field encryption, blind index
      auth/                  argon2 passwords, TOTP, sessions
      documents/             scan, sanitise, encrypt, store, read
      storage/               object storage: quarantine and main buckets
      forms/generate.ts      pdf-lib filler, edition assertion, Part 14 overflow
      repositories/          intake, checklist sync, case queue
      audit/log.ts           append-only audit log
    app/                     Next.js routes: login, client portal, staff console

  assets/forms/i-485/2025-01-20/
                             the official form, its instructions, and a dump of
                             all 820 AcroForm fields

  tools/                     one-off utilities for reading USCIS PDFs
  scripts/                   database bootstrap and demo data
  tests/                     isolation, crypto, intake, checklist, documents, forms
```

The `domain/` and `server/` split is the one worth respecting: `domain/` holds
pure functions that can be tested one at a time, and `server/` holds everything
that touches the database, the filesystem, or a key.

### Running it

```bash
cd visage
docker compose up -d          # Postgres 16
cp .env.example .env && npm install
npm run db:setup              # roles, schema, RLS — verifies itself
npm run db:seed && npm run demo
npm run dev                   # http://localhost:3000
```

Sign in with firm code `alpha`, as `client@alpha.test` or
`attorney@alpha.test`, password `visage-dev-password`.

---

## GitHub Pages

`docs/` holds a static walkthrough — screenshots of the running application, the
document pipeline, and the findings from mapping the real I-485. To publish it,
point **Settings → Pages** at the `master` branch and the `/docs` folder.

It is a walkthrough, not the application. Pages serves static files only, and
Visage needs a Node server, Postgres, and a KMS key.
