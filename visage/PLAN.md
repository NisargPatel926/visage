# Visage — Implementation Plan

**A secure client portal and attorney console for preparing U.S. green card applications.**

Status: **plan for review** — no application code written yet.
Date: 2026-08-26

---

## 1. What we're building

A law firm gives its client a login. The client answers a background questionnaire, and from those
answers the system generates a personalized checklist of documents to collect. The client uploads
passports, paystubs, I-94s, prior USCIS notices, licenses. The system reads those documents and
pulls out the structured facts inside them. Those facts flow into a canonical profile of the
applicant, and the profile fills the actual USCIS PDF forms.

The attorney sees every case in an admin console: what's been submitted, what the extraction found,
what it's unsure about, and the filled forms rendered as editable PDFs they can correct and sign off
on. Attorney and client talk in a secure per-case thread and can pin comments to a specific spot on
a specific page of a specific document — "this paystub is cut off, re-scan it."

When the attorney approves, both sides get one assembled, print-ready PDF package: cover letter,
table of contents, filled forms, supporting exhibits, in filing order.

### The one architectural decision everything else follows from

**Documents do not fill forms. Documents fill a *profile*. The profile fills forms.**

```
Questionnaire ─┐
               ├──▶  Applicant Profile  ──▶  Form Mapping  ──▶  Filled PDF  ──▶  Package
Documents ─────┘     (canonical, versioned,   (declarative,      (pdf-lib)
                      provenance-tracked)      per form)
```

The naive version of this product maps passport → I-485 field 1.a directly. That works for one form
and collapses on the second, because a date of birth appears on the I-485, the I-130, the I-765,
and the G-325, in three different date formats and two different name-splitting conventions.

With a canonical profile in the middle: one extraction pipeline, one questionnaire, one place where
a human corrects a fact, and N declarative mapping files. Adding the I-765 later becomes a mapping
file and a test fixture, not a new pipeline. **This is why v1 is a thin slice and still worth
building carefully.**

---

## 2. Scope

### v1 — in scope

| Area | Deliverable |
|---|---|
| Tenancy | Multi-tenant SaaS: many firms, each with attorneys/paralegals and clients |
| Auth | Email+password with mandatory TOTP MFA for firm staff, invite-only client accounts |
| Intake | Branching questionnaire → generated document checklist |
| Documents | Encrypted upload, malware scan, classification, field extraction with provenance |
| Forms | **Form I-485** end to end, generated from the profile, with overflow continuation sheets |
| Console | Case queue, extraction review, editable-PDF review, attorney sign-off |
| Collaboration | Per-case chat + page-anchored document annotations + revision requests |
| Output | Assembled, paginated, print-ready PDF package |
| Audit | Append-only audit log of every access to client data |

### v1 — explicitly NOT in scope

- **Other forms.** No I-130, I-864, I-765, I-131, I-693. The engine is built so these are mapping
  files, but none ship in v1.
- **E-filing.** No USCIS online account integration. Output is a printable package. USCIS has no
  general-purpose filing API; this is a preparation tool, full stop.
- **Payments/billing.** No Stripe, no subscription management.
- **Legal advice.** The software never tells a user which category to file under. It records what
  they say and flags it for the attorney. See §9.
- **Medical exam contents.** Form I-693 arrives from the civil surgeon in a **sealed envelope**. We
  track it as a checklist line item with a status. We never ask the client to open it, upload it, or
  scan it. Doing so invalidates the exam.
- Mobile apps, e-signature, calendaring, case-deadline tracking, USCIS case-status polling.

### Non-negotiable constraint

**Nothing is filed or finalized without an attorney explicitly approving it.** Extraction populates
drafts. Drafts require sign-off. This is both the malpractice posture and the answer to the
unauthorized-practice-of-law question (§9).

---

## 3. User journeys

### 3.1 Client

1. **Invite.** Attorney creates a case and invites `client@email`. Single-use, expiring, hashed
   token. Client sets a password, is prompted (not forced) to enable MFA.
2. **Questionnaire.** ~40–60 branching questions: biographic, immigration history, addresses for
   the last 5 years, employment for the last 5 years, marital history, children, parents, arrests
   and inadmissibility screening. Saves on every answer; resumable across sessions and devices.
3. **Checklist appears.** Derived from the answers. "Married → marriage certificate." "Entered on
   F-1 → most recent I-20 + I-94." Each line shows why it's required and what a good scan looks like.
4. **Upload.** Drag a photo or PDF onto a checklist line. Immediate feedback: "This looks like a
   passport bio page — good." or "This page is cut off at the bottom, please retake."
5. **Confirm what we read.** For each extracted field the client sees the value next to a crop of
   the source document region and a **Confirm / Fix** control. This is the single highest-leverage
   screen in the product: it converts an unreliable model output into a user-attested fact, and it
   takes the client seconds because they're confirming, not typing.
6. **Chat.** Ask the attorney a question; answer the attorney's requests for revision.
7. **Review + download.** Once the attorney signs off, download the package, print, sign the wet
   signatures, mail.

### 3.2 Attorney / paralegal

1. **Case queue.** Sorted by what needs a human: extraction conflicts, low-confidence fields,
   unanswered client messages, checklists that just completed.
2. **Case view.** Four tabs — Checklist · Documents · Forms · Chat.
3. **Extraction review.** A worklist of only the fields the system is unsure about, or where two
   documents disagree (passport says one DOB, I-94 says another). Attorney picks the winner; the
   choice is recorded with a reason and is sticky.
4. **Form review.** The I-485 rendered as its real PDF with editable fields overlaid in place.
   Every field shows its provenance on hover. Attorney edits inline; edits become recorded
   overrides on the profile, not scribbles on a PDF (see §7).
5. **Request revisions.** Draw a box on page 2 of the paystub, type a comment. The client gets a
   checklist item and a chat message pointing at that exact box.
6. **Sign off.** Approve each form, then approve the package. Locks the case and generates the
   final assembly.

---

## 4. Architecture

### 4.1 Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router) + TypeScript | Client portal, admin console, and API in one deployable |
| DB | PostgreSQL 16 + **Row-Level Security** | Isolation enforced by the database, not by remembering a `where` clause |
| ORM | Prisma | Migrations + types; RLS applied via raw SQL migrations |
| Auth | Auth.js (NextAuth) + TOTP | Sessions in DB, not stateless JWTs, so revocation is real |
| Storage | S3-compatible (R2 or S3) | Objects are AES-256-GCM ciphertext; the bucket never holds plaintext |
| Keys | KMS (AWS KMS; dev shim locally) | Per-firm CMK wraps per-document data keys |
| Queue | pg-boss (Postgres-backed) | Scanning, rasterizing, extraction, assembly. No extra infra in v1 |
| PDF write | `pdf-lib` | Fills AcroForm fields. Requires the qpdf pass below — see §7.1 |
| PDF prep | `qpdf` | One-time decrypt of the encrypted USCIS asset at vendor time |
| PDF read | `pdfjs-dist` | Renders pages for the overlay editor; dumps fields; reads values back in tests |
| AV scan | ClamAV in a worker container | Every upload, before it is ever served back |
| Extraction | Anthropic API, `claude-opus-5` | Native PDF + image input, structured outputs |
| Realtime | SSE over a Postgres `LISTEN/NOTIFY` bridge | Chat + job status without adding a websocket service |
| Tests | Vitest + Playwright | Unit/mapping/golden-file + end-to-end journeys |

**Why one Next.js app rather than a separate Python service:** the heavy document work is
(a) rasterization, (b) an HTTP call to Anthropic, (c) AcroForm field writes. All three have
first-class TypeScript paths. A second language would buy us OCR libraries we've deliberately
chosen not to use (§6). One codebase, one deploy, one type system across the wire.

### 4.2 Data model

```prisma
model Firm {
  id        String   @id @default(uuid())
  name      String
  slug      String   @unique
  kmsKeyId  String              // per-firm CMK; destroying it crypto-shreds the firm
  createdAt DateTime @default(now())
}

model User {
  id           String   @id @default(uuid())
  firmId       String?             // null for client users — they belong via CaseMember
  email        String   @unique
  passwordHash String
  role         Role                // OWNER | ATTORNEY | PARALEGAL | CLIENT
  mfaSecret    String?             // encrypted; required non-null for non-CLIENT roles
  status       UserStatus
}

model Case {
  id             String @id @default(uuid())
  firmId         String
  caseNumber     String
  category       String            // 'FAMILY_AOS' — recorded, not advised
  status         CaseStatus        // INTAKE | COLLECTING | IN_REVIEW | APPROVED | PACKAGED
  leadAttorneyId String
}

model CaseMember {                 // the isolation join: who may see this case
  caseId String
  userId String
  role   CaseRole                  // PRIMARY_APPLICANT | DERIVATIVE | SPONSOR | STAFF
  @@id([caseId, userId])
}

model Requirement {                // one checklist line
  id               String @id @default(uuid())
  caseId           String
  key              String          // 'PASSPORT_BIO', 'MARRIAGE_CERT'
  title            String
  rationale        String          // shown to the client: why this is needed
  required         Boolean
  status           ReqStatus       // NOT_STARTED | UPLOADED | IN_REVIEW | ACCEPTED | REVISION_REQUESTED
  acceptedDocTypes String[]
  @@unique([caseId, key])
}

model Document {
  id            String @id @default(uuid())
  caseId        String
  requirementId String?
  uploaderId    String
  docType       String             // classifier output, attorney-correctable
  filename      String
  mimeType      String
  byteSize      Int
  sha256        String             // dedupe + tamper-evidence
  storageKey    String             // ciphertext object
  dekWrapped    Bytes              // KMS-wrapped AES-256 data key
  scanStatus    ScanStatus         // PENDING | CLEAN | INFECTED
  status        DocStatus          // PENDING | ACCEPTED | REVISION_REQUESTED | REJECTED
  version       Int    @default(1)
  supersedesId  String?            // re-uploads chain; nothing is ever hard-deleted
}

model Extraction {                 // one model run over one document
  id           String @id @default(uuid())
  documentId   String
  model        String              // 'claude-opus-5'
  schemaVersion String             // bump to trigger re-extraction
  rawOutput    Json
  status       ExtractionStatus
}

model ExtractedField {
  id            String  @id @default(uuid())
  extractionId  String
  path          String              // 'applicant.dateOfBirth' — canonical profile path
  value         String
  confidence    Float
  pageNumber    Int
  verbatim      String              // exact text the model claims to have read
  bbox          Json?
}

model ProfileField {               // THE canonical fact. One row per path per case.
  caseId      String
  path        String
  value       String
  source      FieldSource          // INTAKE | EXTRACTED | CLIENT_CONFIRMED | ATTORNEY_OVERRIDE
  sourceRefId String?              // -> ExtractedField.id when EXTRACTED
  confidence  Float?
  verifiedBy  String?
  verifiedAt  DateTime?
  @@id([caseId, path])
}

model ProfileFieldHistory {        // append-only; never updated, never deleted
  id        String   @id @default(uuid())
  caseId    String
  path      String
  oldValue  String?
  newValue  String
  source    FieldSource
  actorId   String?
  reason    String?
  at        DateTime @default(now())
}

model FormInstance {
  id          String @id @default(uuid())
  caseId      String
  formCode    String              // 'I-485'
  formEdition String              // '04/01/24' — pinned; edition drift breaks mappings
  status      FormStatus          // DRAFT | ATTORNEY_REVIEW | APPROVED
  pdfKey      String?
  approvedBy  String?
  approvedAt  DateTime?
}

model Thread   { id String @id; caseId String; kind ThreadKind; documentId String?; subject String; resolved Boolean }
model Message  { id String @id; threadId String; authorId String; body String; createdAt DateTime }
model Annotation { id String @id; documentId String; threadId String; pageNumber Int; rect Json; resolved Boolean }

model Package  { id String @id; caseId String; storageKey String; manifest Json; generatedAt DateTime }

model AuditEvent {                 // append-only, no UPDATE/DELETE grant to the app role
  id         String   @id @default(uuid())
  firmId     String
  actorId    String?
  caseId     String?
  action     String                // 'document.download', 'profile.override', 'package.generate'
  targetType String
  targetId   String
  ip         String?
  userAgent  String?
  meta       Json?
  at         DateTime @default(now())
}
```

**Note the shape of `ProfileField`:** a fact has exactly one current value and a source that says how
we got it. An attorney override outranks a client confirmation, which outranks a raw extraction,
which outranks a questionnaire answer. Every transition lands in `ProfileFieldHistory`. When a
client asks "why does my form say this?", the answer is one query.

---

## 5. Security & isolation

This system holds passports, A-numbers, SSNs, immigration status, arrest history, and
attorney-client privileged communication, for people whose immigration status may depend on it. The
security model is the product.

### 5.1 Isolation — three layers, and the database is the one that counts

**Layer 1 — Postgres Row-Level Security.** Every tenant table carries `firmId` and has RLS
`FORCE`d. The application connects as a role with **no** `BYPASSRLS` and no table ownership;
migrations run as a separate owner role. Each request opens a transaction and sets:

```sql
SET LOCAL app.user_id = '...';
SET LOCAL app.firm_id = '...';
SET LOCAL app.role    = 'ATTORNEY';
```

Policies then read `current_setting('app.firm_id')`. Staff see their firm's cases; a client sees
only cases where a `CaseMember` row matches their user id:

```sql
CREATE POLICY case_isolation ON "Case" USING (
  "firmId" = current_setting('app.firm_id')::uuid
  AND (
    current_setting('app.role') <> 'CLIENT'
    OR EXISTS (SELECT 1 FROM "CaseMember" m
               WHERE m."caseId" = "Case".id
                 AND m."userId" = current_setting('app.user_id')::uuid)
  )
);
```

`SET LOCAL` is transaction-scoped, so a leaked connection returned to the pool carries nothing.

The point: **a forgotten `where firmId = ...` in application code becomes an empty result set, not a
data breach.** Application-layer scoping alone is one missing clause away from cross-tenant
disclosure, and that clause gets forgotten in the twentieth query, not the first.

**Layer 2 — a repository boundary.** All DB access goes through functions that take an
`AuthContext`. A lint rule forbids importing the Prisma client outside `src/server/db/`.

**Layer 3 — tests that try to break it.** Every RLS policy has a test that authenticates as firm B
and asserts firm A's row is invisible — by id, by list, by search, by every API route. These run in
CI and are the gate on merging.

### 5.2 Encryption

- **At rest, per document:** a fresh AES-256-GCM data key per document, encrypting the bytes before
  they reach object storage. The data key is wrapped by the firm's KMS CMK and stored in
  `Document.dekWrapped`. A leaked bucket yields ciphertext. Destroying a firm's CMK renders all
  their documents unrecoverable — which is the clean answer to "delete my firm's data."
- **At rest, per field:** SSN, A-number, and passport number are encrypted at the application layer
  under a per-firm key. Where equality search is needed, a blind index (HMAC-SHA256 under a separate
  pepper) sits alongside the ciphertext.
- **In transit:** TLS 1.3, HSTS preload.
- **Backups:** encrypted, and restore is tested on a schedule — an untested backup is not a backup.

### 5.3 The upload path

Direct-to-bucket presigned uploads are the standard pattern and are wrong here, because they put
unscanned attacker-controlled bytes in the same bucket we serve from. Instead:

1. Client PUTs to a **quarantine bucket** via a presigned, content-length-capped URL.
2. A worker pulls it and: verifies the declared MIME against magic bytes; ClamAV-scans it;
   **re-encodes** images and rasterizes PDF pages to PNG, which strips embedded JavaScript,
   embedded files, and EXIF (passport photos routinely carry GPS coordinates of someone's home);
   computes sha256; encrypts; writes to the main bucket; deletes the quarantine object.
3. Downloads never hand out a bucket URL. They go through an API route that authorizes, audits,
   decrypts, and streams, behind a short-lived single-use token.

### 5.4 Everything else

- MFA **required** for staff, offered to clients. WebAuthn is the natural v2 upgrade.
- Sessions stored server-side, idle timeout 30 min for staff, revocable on demand.
- Rate limiting on auth, upload, and download. Login responses are identical for unknown-email and
  wrong-password.
- Invitations: hashed single-use tokens, 72-hour expiry.
- **Structured logging with a redaction allowlist** — fields are opted *in* to logs, never out. A
  denylist misses the field someone added last Tuesday.
- Content Security Policy with no `unsafe-inline`; PDFs rendered by `pdf.js` in a sandboxed context,
  never by handing the browser a raw file.
- CI runs dependency audit, secret scanning, and the isolation test suite.
- **Audit log**: append-only, covering every read and write of client data. It's a compliance
  artifact, a malpractice defense, and the first thing you want during an incident.

### 5.5 Compliance posture

Not HIPAA (we deliberately never touch medical exam contents — §2). The target is SOC 2 Type II
readiness: encryption, audit logging, access control, retention, incident response, and vendor
management are all built in from Phase 0 rather than retrofitted. Data residency is US-only in v1.
Retention: configurable per firm, with a documented deletion path that includes crypto-shredding.

---

## 6. Document understanding

### 6.1 No traditional OCR

We do not run Tesseract/Textract and then parse text. We send page images (and PDFs directly —
the Anthropic API accepts PDF document blocks natively) to `claude-opus-5` with a strict schema, and
get typed fields back in one step. A phone photo of a Ghanaian birth certificate at an angle under
kitchen lighting is exactly the case where OCR-then-regex falls apart and a vision model holds up.

### 6.2 Two passes

**Pass 1 — classify.** What is this? `PASSPORT_BIO | I94 | EAD | PAYSTUB | BIRTH_CERT |
MARRIAGE_CERT | I797_NOTICE | DRIVERS_LICENSE | TAX_RETURN | VISA_STAMP | UNKNOWN`, plus page count
and a legibility judgment. Legibility failures bounce back to the client immediately, while they
still have the document in their hand. That single behavior removes most of the round-trips that
make this kind of product miserable to use.

**Pass 2 — extract**, using a per-document-type Zod schema. Every field carries its own evidence:

```typescript
const Field = <T extends z.ZodTypeAny>(inner: T) => z.object({
  value: inner,
  confidence: z.number().min(0).max(1),
  page: z.number().int(),
  verbatim: z.string().describe("The exact text as printed on the document"),
});

const PassportBioSchema = z.object({
  surname:        Field(z.string()),
  givenNames:     Field(z.string()),
  passportNumber: Field(z.string()),
  nationality:    Field(z.string()),
  dateOfBirth:    Field(z.string().describe("ISO 8601 YYYY-MM-DD")),
  sex:            Field(z.enum(["M", "F", "X"])),
  issueDate:      Field(z.string()),
  expirationDate: Field(z.string()),
  mrz:            Field(z.string()).nullable()
                    .describe("Both lines of the machine-readable zone, if legible"),
});

const res = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  messages: [{ role: "user", content: [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
    { type: "text", text: EXTRACTION_PROMPT },
  ]}],
  output_config: { format: zodOutputFormat(PassportBioSchema) },
});
// res.parsed_output is null if parsing failed — guard, don't assert
```

The `verbatim` field does real work: it lets us string-match the claimed reading against the page
and catch a confident hallucination that a confidence score alone would wave through.

### 6.3 Deterministic cross-checks

Model output is never trusted on its own where a cheaper check exists:

- **Passport MRZ** has ICAO 9303 check digits over the document number, DOB, and expiry. Parse it
  and verify the checksums. If the MRZ validates, those fields are known-good regardless of what the
  vision pass said about the printed text — and if the two disagree, that's a flag worth a human.
- **A-numbers** are 7–9 digits; **SSNs** have documented invalid ranges; **I-94 numbers** are 11
  characters.
- **Date sanity**: DOB in the past, expiry after issue, entry dates after DOB.
- **Cross-document agreement**: the same `path` extracted from two documents must match. A conflict
  becomes an attorney review item rather than a silent last-write-wins.

### 6.4 Confidence routing

| Condition | Route |
|---|---|
| Deterministic check passes | Auto-accept into the profile |
| Confidence ≥ 0.9, no conflict | Client confirms (one tap) |
| Confidence < 0.9 or any conflict | Attorney review queue |
| Classification `UNKNOWN` or illegible | Straight back to the client, with the reason |

**Nothing extracted ever reaches a form without at least one human having seen it.**

### 6.5 Cost

At `claude-opus-5` ($5/$25 per MTok), a typical case of ~15 documents at a few thousand input
tokens each lands in the low single-digit dollars per case — irrelevant against the fee for a green
card filing, so v1 optimizes for accuracy and does not downgrade the model. Re-extraction is
triggered by bumping `Extraction.schemaVersion`, so improving a schema doesn't require a migration.

---

## 7. Forms

**This section is grounded in the actual I-485 you supplied, not in assumptions.** Everything below
was verified by loading the real file. The findings changed the design in three places.

### 7.0 What the real form turned out to be

| Property | Verified value |
|---|---|
| Edition | **01/20/25** (read from the page barcodes; OMB expiry 10/31/2027) |
| Pages | 24 |
| Field widgets | 820 total; **736 data fields** after excluding barcodes and containers |
| Types | 334 text · 416 checkbox · 10 dropdown |
| Structure | Pure AcroForm — **not** a dynamic XFA form |
| Encryption | **AES (AESv2), empty user password**, permissions restricted |

Field widgets per part — this is the real shape of the work:

| Part | Title | Fields |
|---|---|---|
| 1 | Information About You | 111 |
| 2 | Application Type or Filing Category | 88 |
| 3 | Exemption for Intending Immigrant's Affidavit of Support | 14 |
| 4 | Additional Information About You | 40 |
| 5 | Information About Your Parents | 22 |
| 6 | Information About Your Marital History | 46 |
| 7 | Information About Your Children | 48 |
| 8 | Biographic Information | 140 |
| 9 | General Eligibility and Inadmissibility Grounds | **155** |
| 10–13 | Signatures, interpreter, preparer, interview | 22 |
| 14 | Additional Information (overflow) | 4 |
| — | Unprefixed / shared | 46 |

Part 9 alone is 155 fields of yes/no inadmissibility grounds, and Part 8 another 140. **Together
they are 40% of the form and almost none of it comes from documents** — it comes from the
questionnaire. That reweights the build: the intake engine is more of the I-485 than the extraction
pipeline is, which is the opposite of the intuition this product starts with.

### 7.1 Three findings that changed the design

**Finding 1 — the PDF is encrypted, and `pdf-lib` cannot read it.**

Loading the official file with `pdf-lib` fails with a cascade of `Invalid object ref` warnings and
then dies:

```
Error: Expected instance of PDFDict, but got instance of undefined
    at PDFCatalog.Pages ...
```

`ignoreEncryption: true` does not help — it suppresses the throw but leaves every object
undecryptable, so lookups return undefined. The maintained fork `@cantoo/pdf-lib` fails identically.
This is not a bug we can work around in application code.

*Resolution:* a one-time `qpdf --decrypt` pass at vendor time (`tools/prepare-form.sh`). After it,
`pdf-lib` loads the file cleanly and fills all 760 fields it exposes. **This runs once per form
edition when we vendor the asset, never per request** — so it costs nothing at runtime, but it is a
hard build-time dependency that would have surfaced as a Phase 4 emergency.

**Finding 2 — Part 14, the overflow field, is a rich-text field that breaks `pdf-lib` on save.**

Writing to `P14_Line5_AdditionalInfo[0]` succeeds, but saving throws:

```
Error: Reading rich text fields is not supported:
       Attempted to read rich text field: form1[0].#subform[24].P14_Line5_AdditionalInfo[0]
```

`pdf-lib` regenerates every field's appearance stream on save and cannot parse rich text to do it.
This is precisely the field the overflow strategy depends on, so it would have broken exactly the
case §7.3 calls the norm rather than the edge.

*Resolution:* save with `updateFieldAppearances: false` and set `NeedAppearances = true` on the
AcroForm dictionary, delegating appearance generation to the viewer:

```typescript
form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
const bytes = await doc.save({ updateFieldAppearances: false });
```

*Carried risk:* `NeedAppearances` is honored by Acrobat and most desktop viewers, but some
viewers — and some printers — render nothing for fields without a baked appearance stream. Since
the whole product ends in a printed package, **Phase 4 must verify the printed output visually, not
just assert on field values.** For the flattened package variant we will likely need to draw
appearances ourselves for the fields that need them. This is now a tracked task, not a surprise.

**Finding 3 — the page barcodes are static, not data-bearing.**

Each page carries a `PDF417BarCode2[0]` field. Decoded, they read:

```
I-485|01/20/25|1 … I-485|01/20/25|24
```

Form code, edition, page number. **They do not encode applicant data**, so filling the form does not
invalidate them and we never need to regenerate a barcode. This removes a risk the plan previously
carried. It also gives us a free integrity check: the barcode is an authoritative in-file statement
of the edition, so the generator asserts it matches the mapping's pinned edition and refuses to fill
a form it wasn't written for.

One caveat: `pdf-lib` logs `Removing XFA form data` on save. The form is static, so the AcroForm
layer is authoritative and this is expected — but it is part of what the Phase 4 visual check
confirms.

### 7.2 Field names must be dumped, never guessed

The real names are not systematic:

```
form1[0].#subform[0].Pt1Line1_FamilyName[0]     ← "Pt" prefix
form1[0].#subform[7].P4Line7_State[0]           ← "P" prefix, same form
form1[0].#subform[9].P6Line8_State[0]
```

Checkbox export values are opaque and unguessable — `"Y"`, `"N"`, `"11A"`, `"1fA"`, `"3a0"`,
`"3a1"`. Dropdowns are inconsistent about their empty sentinel: `Pt1Line10_State` uses `" "` (a
space) while `Pt1Line18_PriorState` uses `""`. Get that wrong and you write a space into a state
field on a federal form.

So `tools/dump-form-fields.mjs` emits `assets/forms/i-485/2025-01-20/fields.json` — every field's
name, type, page, rectangle, export values, dropdown options, and max length. **The dump is
committed, and mappings are written against it.** It is also the input to the console's overlay
editor, which positions its inputs using the same rectangles.

### 7.3 The mapping layer

One declarative file per form. Nothing else in the codebase knows a USCIS field name:

```typescript
export const I485_MAPPING: FormMapping = {
  formCode: "I-485",
  edition: "01/20/25",          // asserted against the in-file barcode at generation time
  fields: [
    { pdf: "form1[0].#subform[0].Pt1Line1_FamilyName[0]",   path: "applicant.name.family", transform: upper },
    { pdf: "form1[0].#subform[0].Pt1Line1_GivenName[0]",    path: "applicant.name.given",  transform: upper },
    { pdf: "form1[0].#subform[0].Pt1Line3_DOB[0]",          path: "applicant.dateOfBirth", transform: usDate },
    { pdf: "form1[0].#subform[1].Pt1Line10_PassportNum[0]", path: "applicant.passport.number" },
    // Export value comes from fields.json, never from memory.
    { pdf: "form1[0].#subform[1].Pt2Line11_CB[0]", path: "case.category", when: eq("FAMILY_AOS"), check: "11A" },
  ],
  repeating: [
    { path: "applicant.addressHistory", maxRows: 3, overflow: "PART_14", rowFields: [/* ... */] },
    { path: "applicant.employmentHistory", maxRows: 3, overflow: "PART_14", rowFields: [/* ... */] },
  ],
};
```

**Overflow is the norm, not an edge case.** The form gives three rows for five years of address
history and three for employment; real applicants exceed both routinely. Every repeating section
declares `overflow: "PART_14"`, and the generator emits properly formatted continuation entries —
Part 14 requires page number, part number, and item number per entry, which is exactly the
bookkeeping a human preparer fumbles and a generator gets right every time.

### 7.4 Golden-file testing

Round-tripping is **verified working**: fill → save → read values back out with `pdfjs`. A filled
fixture reads back as

```
text      Pt1Line1_FamilyName[0]      = "GARCIA"
text      Pt1Line3_DOB[0]             = "03/14/1990"
checkbox  Pt2Line11_CB[0]             = "11A"
combobox  Pt7Line3_HeightFeet[0]      = "5"
text      P14_Line5_AdditionalInfo[0] = "Part 3, Item 5: additional address history..."
```

So the test shape is: fixture profile → generate → extract field values from the produced PDF →
snapshot-compare. Fixtures cover a plain case, a maximal case (every optional section, overflow in
all repeating groups), and the edge cases that break naive mappings — single-name applicants (very
common, and the classic breaker of `firstName`/`lastName` assumptions), non-Latin characters,
missing middle name, hyphenated surnames.

Because appearance streams are delegated to the viewer (Finding 2), **field-value assertions are
necessary but not sufficient.** Phase 4 adds a rendered-page image snapshot for at least one
fixture, so a regression that empties the visible page while leaving field values intact cannot pass.

### 7.5 Form editions expire

USCIS rejects superseded editions. The vendored edition is pinned in the path
(`assets/forms/i-485/2025-01-20/`) and in the mapping, the generator asserts the pinned edition
against the barcode read out of the file itself, and a startup check warns as the OMB expiry
(10/31/2027) approaches. An edition bump is a new directory, a new dump, a new mapping, and a new
golden fixture — never an in-place edit.

### 7.6 The editable PDF in the console

The attorney sees the real rendered PDF (`pdfjs`), with HTML inputs positioned over each field's
actual rectangle — taken from the same `fields.json` the mapping uses. It looks and behaves like
editing the PDF.

**An edit writes to `ProfileField` as an `ATTORNEY_OVERRIDE`, not to the PDF.** The PDF is
regenerated from the profile. This matters because:

- Correcting a DOB on the I-485 fixes it on every future form, instead of once.
- Regeneration stays safe — nothing hand-edited gets clobbered, because the override *is* the
  source of truth now.
- Every change is attributable and reversible via `ProfileFieldHistory`.
- Provenance survives: hovering a field still shows "from passport, page 1 — corrected by
  J. Rivera on Aug 12."

A "download fillable PDF" escape hatch exists for anything the overlay cannot express.

## 8. The rest of v1

### 8.1 Checklist engine

Pure functions: `(intakeAnswers, profile) => Requirement[]`, re-run whenever either changes.
Rules are data, testable in isolation, and each carries the client-facing rationale.

```typescript
{ key: "MARRIAGE_CERT",
  when: (a) => a.maritalStatus === "MARRIED",
  title: "Marriage certificate",
  rationale: "USCIS requires proof of your current marriage.",
  acceptedDocTypes: ["MARRIAGE_CERT"], required: true }
```

Requirements are additive and never silently dropped: if an answer changes and a requirement no
longer applies, it's marked withdrawn rather than deleted, so an already-uploaded document doesn't
vanish from the client's view.

### 8.2 Chat and markup

- `Thread` per case, plus one per document annotation.
- SSE for delivery; messages persist in Postgres under the same RLS policies as everything else.
- An annotation is a page number plus a normalized rect (fractions of page size, so it survives
  zoom and re-render) plus a thread.
- **Revision request** is a first-class action, not a message convention: it flips the
  `Requirement` to `REVISION_REQUESTED`, notifies the client, and appears on their checklist with
  the attorney's comment and the highlighted region attached.
- Privileged content: encrypted at rest, included in audit, exportable, covered by retention.

### 8.3 Package assembly

On approval: flatten approved forms → order exhibits per USCIS convention → generate cover letter
and a table of contents with real page numbers → insert labeled separator sheets → merge to one PDF
→ encrypt and store → both parties download. `Package.manifest` records exactly what went in, so a
package is reproducible and auditable after the fact.

---

## 9. Legal & product posture

**Unauthorized practice of law is a real constraint, not a disclaimer.** Software that tells a user
which immigration benefit to apply for is practicing law. So:

- The questionnaire **records** what the user says. It never recommends a filing category.
- Nothing reaches USCIS-ready state without a licensed attorney approving it.
- Extraction flags and conflicts are presented to the attorney as *questions*, never resolved as
  *advice*.
- The client-facing UI explains what a document is for, never what the applicant should do.

This is worth internalizing at design time because it shapes copy, notification wording, and where
approval gates sit — retrofitting it later means rewriting every user-facing string in the product.

---

## 10. Delivery plan

Each phase ends with something demonstrable and tested. Phase 0 is load-bearing: RLS and the audit
log cannot be retrofitted onto a schema that grew without them.

| # | Phase | Deliverable | Done when |
|---|---|---|---|
| 0 | **Foundations** | Next.js + Prisma + Postgres, Docker dev env, CI, auth with MFA, firm/user/case models, **RLS policies + isolation test suite**, audit log, KMS envelope-encryption module | A test authenticated as firm B cannot reach firm A's data through any route |
| 1 | **Intake & checklist** | Questionnaire engine, rules engine, client dashboard, staff case queue | A client completes intake and sees a correct, personalized checklist |
| 2 | **Document pipeline** | Quarantine upload, AV scan, rasterize, encrypt, store, versioned re-upload, document viewer | A phone photo uploads, scans clean, and renders in both portals |
| 3 | **Extraction** | Classifier, per-type schemas, deterministic validators, MRZ checksums, confidence routing, client confirm screen, attorney conflict queue | A real passport + I-94 populate the profile with visible provenance |
| 4 | **I-485** | Mapping over the committed field dump, generator, Part 14 overflow, golden-file tests, **rendered-image check** | A fixture profile produces a correct I-485 that is right on screen *and* in print |
| 5 | **Console & sign-off** | Overlay PDF editor, override recording, provenance hover, per-form and per-case approval | An attorney corrects a field, regenerates, and approves |
| 6 | **Collaboration** | Case chat, page-anchored annotations, revision requests wired to checklist | Attorney marks up a paystub; client sees the request on their checklist |
| 7 | **Package** | Ordering, cover letter, TOC, separators, merge, download | Both parties download one print-ready PDF |
| 8 | **Hardening** | Pen-test checklist, rate limits, backup/restore drill, observability, retention jobs, runbooks | Restore drill passes; isolation suite green; no criticals outstanding |

Phases 1 and 2 can proceed in parallel with 3–4 once Phase 0 lands, since the extraction and form
work depend on the schema rather than on the UI.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| **Cross-tenant data leak** | RLS as primary control, not app-layer filtering; adversarial isolation tests gate every merge |
| **Confident wrong extraction** | `verbatim` evidence + deterministic checksums + mandatory human confirmation; no field reaches a form unseen |
| ~~USCIS PDF internals differ from assumptions~~ | **Resolved.** Real form loaded and filled; findings in §7.1. Field dump committed at `assets/forms/i-485/2025-01-20/fields.json` |
| **Fields render blank in print** (appearance streams delegated via `NeedAppearances`) | Phase 4 adds a rendered-image snapshot test, not just field-value assertions; draw appearances manually for the flattened package if needed |
| **Form edition expires mid-build** | Edition 01/20/25 pinned in path + mapping and asserted against the in-file barcode; OMB expiry 10/31/2027 |
| **Overflow sections silently truncate** | Overflow is declared in the mapping and covered by a maximal-case golden fixture |
| **UPL exposure** | Attorney approval gate is architectural; questionnaire records rather than recommends |
| **Model output schema drift** | `strict` schemas + `schemaVersion` on every extraction, so re-runs are cheap and traceable |
| **Bucket misconfiguration** | Objects are ciphertext; a public bucket leaks nothing usable |

---

## 12. Open questions

None of these block Phase 0. Listed roughly in the order they need answering.

1. **Derivative family members.** A spouse and children on the same case each need their own I-485.
   Is each derivative a separate `Case` linked to a primary, or one `Case` with multiple applicant
   profiles? *Recommendation:* separate cases with a `relatedCaseId` link — the forms are genuinely
   per-person, and sharing a profile across people invites cross-contamination bugs. **Needs your
   call before Phase 1**, since it shapes the intake flow.
2. **Client identity verification.** Is an email invite from the attorney sufficient, or do you want
   ID verification at signup? Affects the auth build in Phase 0.
3. **Firm branding.** Do firms need their own logo/domain on the client portal? White-labeling is
   much cheaper designed in than added.
4. **Paralegal permissions.** Should paralegals be able to approve forms, or only prepare them?
   *Recommendation:* prepare only; approval is attorney-restricted.
5. **Retention.** How long after filing do we keep documents? Statutory and malpractice
   considerations both apply, and the answer drives the retention jobs in Phase 8.
6. **Hosting.** AWS, or Cloudflare (R2 + Workers)? Affects the KMS integration specifically; the
   rest is portable.
7. **Existing firm systems.** Does the target firm use Clio, MyCase, or similar? Not v1 scope, but
   knowing now prevents a data model that can't be integrated later.

---

## 13. Repository

Intended home: **`NisargPatel926/visage`**, private.

The GitHub App backing this session does not have repository-creation permission
(`403 Resource not accessible by integration`), so this plan currently lives under `visage/` in
`git_practice` on branch `claude/visage-legal-portal-plan-0g74r1`. The directory is a self-contained
project root — once the repo exists, moving it is a copy and an initial commit, with no path
rewrites needed.

### Already in the tree

```
visage/
  PLAN.md                                     this document
  tools/dump-form-fields.mjs                  AcroForm field dumper (pdfjs)
  tools/prepare-form.sh                       qpdf decrypt pass (§7.1, Finding 1)
  assets/forms/i-485/2025-01-20/
    i-485.pdf                                 official form, edition 01/20/25
    i-485-instructions.pdf                    official instructions
    fields.json                               820 widgets: names, types, pages, rects, export values
```

The form PDFs are U.S. government works and contain no applicant data.
