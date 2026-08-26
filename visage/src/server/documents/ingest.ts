import { createHash, randomUUID } from 'node:crypto';
import { audit, auditDetached, AuditAction } from '../audit/log';
import { seal, unseal } from '../crypto/envelope';
import type { AuthContext, TenantClient } from '../db/tenant';
import { storage } from '../storage';
import { scanner } from './scan';
import { sanitize } from './sanitize';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Prisma's Bytes columns want Uint8Array<ArrayBuffer>; Node's Buffer is
 * Buffer<ArrayBufferLike>, which is wider because it may be backed by a
 * SharedArrayBuffer. Copying into a plain Uint8Array is the narrowing.
 */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(b.byteLength));
  out.set(b);
  return out;
};

export class UploadRejected extends Error {
  constructor(message: string, readonly kind: 'too_large' | 'infected' | 'unreadable') {
    super(message);
    this.name = 'UploadRejected';
  }
}

export interface IngestInput {
  readonly caseId: string;
  readonly requirementId?: string | null;
  readonly filename: string;
  readonly declaredMime: string;
  readonly bytes: Buffer;
}

/**
 * Take an uploaded file from raw bytes to a stored, encrypted document.
 *
 *   quarantine -> scan -> sanitise -> encrypt -> main -> row -> drop quarantine
 *
 * The order is the point. Presigned direct-to-bucket uploads are the usual
 * pattern and are wrong here: they put unscanned attacker-controlled bytes in
 * the bucket we serve from. Nothing is ever served out of quarantine, and the
 * quarantine object is deleted whether ingestion succeeds or fails.
 *
 * A rejected upload still records an audit row. "Someone tried to upload
 * something infected" is exactly the kind of event you want in the log.
 */
export async function ingestDocument(
  tx: TenantClient,
  ctx: AuthContext,
  input: IngestInput,
): Promise<{ id: string; notes: string[] }> {
  if (input.bytes.length === 0) throw new UploadRejected('That file is empty.', 'unreadable');
  if (input.bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejected('That file is larger than 25 MB.', 'too_large');
  }

  const kase = await tx.case.findUniqueOrThrow({
    where: { id: input.caseId },
    select: { firmId: true },
  });
  const firm = await tx.firm.findUniqueOrThrow({
    where: { id: kase.firmId },
    select: { kmsKeyId: true },
  });

  const store = storage();
  const quarantineKey = `${kase.firmId}/${randomUUID()}`;
  await store.put('quarantine', quarantineKey, input.bytes);

  try {
    const verdict = await scanner().scan(input.bytes);
    if (!verdict.clean) {
      // Detached: the throw below rolls this transaction back, and a record of
      // a blocked upload must not roll back with it.
      await auditDetached(ctx, {
        action: 'document.rejected', targetType: 'Document', targetId: quarantineKey,
        caseId: input.caseId,
        meta: { reason: verdict.reason, scanner: verdict.scanner, filename: input.filename },
      });
      throw new UploadRejected(
        'That file did not pass our safety check, so we have not stored it.',
        'infected',
      );
    }

    let clean;
    try {
      clean = await sanitize(input.bytes, input.declaredMime);
    } catch {
      throw new UploadRejected(
        'We could not read that file. Please upload a PDF or a photo.',
        'unreadable',
      );
    }

    const documentId = randomUUID();
    // AAD binds the ciphertext to this row, so a blob cannot be swapped between
    // documents even by someone with write access to the bucket.
    const sealed = await seal(clean.bytes, firm.kmsKeyId, documentId);
    const storageKey = `${kase.firmId}/${documentId}`;
    await store.put('main', storageKey, sealed.ciphertext);

    // Supersede rather than overwrite: a re-upload keeps the earlier version
    // and any attorney annotations attached to it.
    const previous = input.requirementId
      ? await tx.document.findFirst({
          where: { requirementId: input.requirementId, caseId: input.caseId },
          orderBy: { version: 'desc' },
        })
      : null;

    await tx.document.create({
      data: {
        id: documentId,
        firmId: kase.firmId,
        caseId: input.caseId,
        requirementId: input.requirementId ?? null,
        uploaderId: ctx.userId,
        docType: 'UNCLASSIFIED', // Phase 3 fills this in
        filename: input.filename.slice(0, 200),
        mimeType: clean.mimeType,
        byteSize: clean.bytes.length,
        sha256: createHash('sha256').update(clean.bytes).digest('hex'),
        storageKey,
        dekWrapped: bytes(sealed.dekWrapped),
        iv: bytes(sealed.iv),
        authTag: bytes(sealed.authTag),
        scanStatus: 'CLEAN',
        status: 'PENDING',
        version: (previous?.version ?? 0) + 1,
        supersedesId: previous?.id ?? null,
      },
    });

    if (input.requirementId) {
      await tx.requirement.update({
        where: { id: input.requirementId },
        data: { status: 'UPLOADED' },
      });
    }

    await audit(tx, ctx, {
      action: AuditAction.DOCUMENT_UPLOADED, targetType: 'Document', targetId: documentId,
      caseId: input.caseId,
      meta: { filename: input.filename, bytes: clean.bytes.length, notes: clean.notes },
    });

    return { id: documentId, notes: clean.notes };
  } finally {
    await store.delete('quarantine', quarantineKey);
  }
}

/**
 * Fetch and decrypt a document for delivery.
 *
 * Callers must already be inside withTenant, so RLS decides whether this row is
 * visible at all; there is no separate authorisation check here to get wrong.
 */
export async function readDocument(
  tx: TenantClient,
  ctx: AuthContext,
  documentId: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string } | null> {
  const doc = await tx.document.findUnique({ where: { id: documentId } });
  if (!doc) return null;

  const firm = await tx.firm.findUniqueOrThrow({
    where: { id: doc.firmId }, select: { kmsKeyId: true },
  });

  const ciphertext = await storage().get('main', doc.storageKey);
  const bytes = await unseal(
    {
      ciphertext,
      dekWrapped: Buffer.from(doc.dekWrapped),
      iv: Buffer.from(doc.iv),
      authTag: Buffer.from(doc.authTag),
    },
    firm.kmsKeyId,
    doc.id,
  );

  await audit(tx, ctx, {
    action: AuditAction.DOCUMENT_DOWNLOADED, targetType: 'Document', targetId: doc.id,
    caseId: doc.caseId,
  });

  return { bytes, mimeType: doc.mimeType, filename: doc.filename };
}
