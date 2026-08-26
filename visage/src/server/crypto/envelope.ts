import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { kms } from './kms';

export interface SealedBlob {
  ciphertext: Buffer;
  dekWrapped: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Encrypt bytes under a fresh per-object data key, then wrap that key with the
 * firm's KMS key. The four returned parts map directly onto the columns every
 * blob-bearing model carries (storageKey aside).
 *
 * `aad` binds the ciphertext to its context — pass something stable and
 * identifying, such as the document id. Decryption with different aad fails,
 * so a ciphertext cannot be silently moved to another row.
 */
export async function seal(plaintext: Buffer, firmKeyId: string, aad?: string): Promise<SealedBlob> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const dekWrapped = await kms().wrapKey(firmKeyId, dek);
  dek.fill(0); // don't leave key material sitting in the heap

  return { ciphertext, dekWrapped, iv, authTag };
}

export async function unseal(blob: SealedBlob, firmKeyId: string, aad?: string): Promise<Buffer> {
  const dek = await kms().unwrapKey(firmKeyId, blob.dekWrapped);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, blob.iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(blob.authTag);
    return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}
