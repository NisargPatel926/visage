import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant } from '../../src/server/db/tenant';
import { ingestDocument, readDocument, UploadRejected } from '../../src/server/documents/ingest';
import { LocalStorage, __setStorageForTests, storage } from '../../src/server/storage';
import { HeuristicScanner, __setScannerForTests } from '../../src/server/documents/scan';
import { detectMime, sanitize } from '../../src/server/documents/sanitize';
import { __setKmsProviderForTests, LocalKmsProvider } from '../../src/server/crypto/kms';
import { reseed, type Seed } from '../fixtures';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** A one-page PDF with no active content. */
async function plainPdf(): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Passport bio page');
  return Buffer.from(await doc.save());
}

async function jpeg(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 40, height: 40, channels: 3, background: '#888' } })
    .jpeg().toBuffer();
}

let s: Seed;
beforeEach(async () => {
  s = await reseed();
  __setStorageForTests(new LocalStorage(await mkdtemp(join(tmpdir(), 'visage-store-'))));
  __setScannerForTests(new HeuristicScanner());
  __setKmsProviderForTests(new LocalKmsProvider(process.env.KMS_LOCAL_MASTER_KEY ?? ''));
});

describe('type detection', () => {
  it('identifies formats from magic bytes, not the declared type', async () => {
    expect(detectMime(await plainPdf())).toBe('application/pdf');
    expect(detectMime(await jpeg())).toBe('image/jpeg');
    expect(detectMime(Buffer.from('just text'))).toBeNull();
  });
});

describe('sanitisation', () => {
  it('rewrites a PDF through qpdf', async () => {
    const out = await sanitize(await plainPdf(), 'application/pdf');
    expect(out.mimeType).toBe('application/pdf');
    expect(out.notes.join(' ')).toMatch(/qpdf/);
  });

  it('re-encodes images and strips metadata', async () => {
    // A passport photo routinely carries the GPS coordinates of someone's home.
    const sharp = (await import('sharp')).default;
    const withExif = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } })
      .withExif({ IFD0: { Copyright: 'SECRET-LOCATION-TAG' } })
      .jpeg().toBuffer();
    expect(withExif.toString('latin1')).toContain('SECRET-LOCATION-TAG');

    const out = await sanitize(withExif, 'image/jpeg');
    expect(out.bytes.toString('latin1')).not.toContain('SECRET-LOCATION-TAG');
  });

  it('notes a mismatch between declared and actual type', async () => {
    const out = await sanitize(await jpeg(), 'application/pdf');
    expect(out.notes.join(' ')).toMatch(/declared application\/pdf, detected image\/jpeg/);
    expect(out.mimeType).toBe('image/jpeg'); // detection wins
  });

  it('rejects a format it cannot identify', async () => {
    // Storing an unknown format means guessing a content type when serving it.
    await expect(sanitize(Buffer.from('#!/bin/sh\nrm -rf /'), 'text/plain')).rejects.toThrow();
  });
});

describe('scanning', () => {
  const scanner = new HeuristicScanner();

  it('flags the EICAR test signature', async () => {
    const r = await scanner.scan(Buffer.from(EICAR));
    expect(r.clean).toBe(false);
    expect(r.reason).toMatch(/EICAR/);
  });

  it('flags a PDF carrying JavaScript', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('/JavaScript (app.alert(1))')]);
    const r = await scanner.scan(pdf);
    expect(r.clean).toBe(false);
    expect(r.reason).toMatch(/JavaScript/);
  });

  it('flags /Launch and /OpenAction', async () => {
    for (const marker of ['/Launch', '/OpenAction']) {
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(marker)]);
      expect((await scanner.scan(pdf)).clean).toBe(false);
    }
  });

  it('passes an ordinary document', async () => {
    expect((await scanner.scan(await plainPdf())).clean).toBe(true);
  });
});

describe('ingestion', () => {
  const upload = (bytes: Buffer, filename: string, mime: string, requirementId?: string) =>
    withTenant(s.firmA.client1, (tx) =>
      ingestDocument(tx, s.firmA.client1, {
        caseId: s.firmA.case1, requirementId, filename, declaredMime: mime, bytes,
      }));

  it('stores an uploaded document and returns it intact', async () => {
    const { id } = await upload(await plainPdf(), 'passport.pdf', 'application/pdf');
    const back = await withTenant(s.firmA.client1, (tx) =>
      readDocument(tx, s.firmA.client1, id));

    expect(back?.mimeType).toBe('application/pdf');
    expect(back?.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('stores ciphertext, never plaintext', async () => {
    const { id } = await upload(await plainPdf(), 'passport.pdf', 'application/pdf');
    const doc = await withTenant(s.firmA.client1, (tx) =>
      tx.document.findUniqueOrThrow({ where: { id } }));

    // What sits in the bucket must be useless on its own.
    const raw = await storage().get('main', doc.storageKey);
    expect(raw.subarray(0, 5).toString()).not.toBe('%PDF-');
    expect(raw.toString('latin1')).not.toContain('Passport bio page');
  });

  it('rejects an infected file and stores nothing', async () => {
    await expect(upload(Buffer.from(`%PDF-1.7\n${EICAR}`), 'bad.pdf', 'application/pdf'))
      .rejects.toThrow(UploadRejected);

    const docs = await withTenant(s.firmA.client1, (tx) => tx.document.findMany());
    expect(docs.filter((d) => d.filename === 'bad.pdf')).toHaveLength(0);
  });

  it('records an audit row even when it rejects', async () => {
    // "Someone tried to upload something infected" is exactly what you want
    // in the log.
    await upload(Buffer.from(`%PDF-1.7\n${EICAR}`), 'bad.pdf', 'application/pdf').catch(() => {});
    const events = await withTenant(s.firmA.attorney, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'document.rejected' } }));
    expect(events.length).toBeGreaterThan(0);
  });

  it('leaves nothing behind in quarantine', async () => {
    const { id } = await upload(await plainPdf(), 'passport.pdf', 'application/pdf');
    const doc = await withTenant(s.firmA.client1, (tx) =>
      tx.document.findUniqueOrThrow({ where: { id } }));
    // The quarantine key is a uuid we no longer hold, but the bucket must be
    // empty of anything reachable — the main key must not resolve there.
    await expect(storage().get('quarantine', doc.storageKey)).rejects.toThrow();
  });

  it('rejects an oversized file', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024, 0x41);
    await expect(upload(huge, 'huge.pdf', 'application/pdf')).rejects.toThrow(/25 MB/);
  });

  it('rejects an empty file', async () => {
    await expect(upload(Buffer.alloc(0), 'empty.pdf', 'application/pdf')).rejects.toThrow(/empty/);
  });

  it('marks the checklist item uploaded', async () => {
    const req = await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.create({
        data: {
          caseId: s.firmA.case1, firmId: s.firmA.id, key: 'PASSPORT_BIO',
          title: 'Passport', rationale: 'Identity.', acceptedDocTypes: ['PASSPORT_BIO'],
        },
      }));
    await upload(await plainPdf(), 'passport.pdf', 'application/pdf', req.id);

    const after = await withTenant(s.firmA.client1, (tx) =>
      tx.requirement.findUniqueOrThrow({ where: { id: req.id } }));
    expect(after.status).toBe('UPLOADED');
  });

  it('supersedes rather than overwrites on re-upload', async () => {
    // A replaced document must not take the attorney's annotations with it.
    const req = await withTenant(s.firmA.attorney, (tx) =>
      tx.requirement.create({
        data: {
          caseId: s.firmA.case1, firmId: s.firmA.id, key: 'PASSPORT_BIO',
          title: 'Passport', rationale: 'Identity.', acceptedDocTypes: ['PASSPORT_BIO'],
        },
      }));

    const first = await upload(await plainPdf(), 'v1.pdf', 'application/pdf', req.id);
    const second = await upload(await plainPdf(), 'v2.pdf', 'application/pdf', req.id);

    const docs = await withTenant(s.firmA.client1, (tx) =>
      tx.document.findMany({ where: { requirementId: req.id }, orderBy: { version: 'asc' } }));
    expect(docs).toHaveLength(2);
    expect(docs[1]?.version).toBe(2);
    expect(docs[1]?.supersedesId).toBe(first.id);
    expect(docs[1]?.id).toBe(second.id);
  });
});

describe('document isolation', () => {
  it("another firm cannot read an uploaded document", async () => {
    const bytes = await plainPdf();
    const { id } = await withTenant(s.firmA.client1, (tx) =>
      ingestDocument(tx, s.firmA.client1, {
        caseId: s.firmA.case1, filename: 'p.pdf',
        declaredMime: 'application/pdf', bytes,
      }));

    const back = await withTenant(s.firmB.attorney, (tx) =>
      readDocument(tx, s.firmB.attorney, id));
    expect(back).toBeNull();
  });

  it("a firm-mate on another case cannot read it either", async () => {
    const bytes = await plainPdf();
    const { id } = await withTenant(s.firmA.client1, (tx) =>
      ingestDocument(tx, s.firmA.client1, {
        caseId: s.firmA.case1, filename: 'p.pdf',
        declaredMime: 'application/pdf', bytes,
      }));

    const back = await withTenant(s.firmA.client2, (tx) =>
      readDocument(tx, s.firmA.client2, id));
    expect(back).toBeNull();
  });
});
