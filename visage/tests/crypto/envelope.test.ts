import { beforeAll, describe, expect, it } from 'vitest';
import { seal, unseal } from '../../src/server/crypto/envelope.js';
import { LocalKmsProvider, __setKmsProviderForTests } from '../../src/server/crypto/kms.js';
import { blindIndex, blindIndexMatches, decryptField, encryptField } from '../../src/server/crypto/fields.js';

const FIRM_A = 'local:firm-a';
const FIRM_B = 'local:firm-b';

beforeAll(() => {
  __setKmsProviderForTests(new LocalKmsProvider(process.env.KMS_LOCAL_MASTER_KEY ?? ''));
});

describe('envelope encryption', () => {
  it('round-trips a document', async () => {
    const plain = Buffer.from('passport bio page bytes');
    const sealed = await seal(plain, FIRM_A, 'doc-1');
    expect(await unseal(sealed, FIRM_A, 'doc-1')).toEqual(plain);
  });

  it('never stores the plaintext or a bare data key', async () => {
    const plain = Buffer.from('A-Number 123456789');
    const sealed = await seal(plain, FIRM_A, 'doc-1');

    expect(sealed.ciphertext.toString('utf8')).not.toContain('123456789');
    // The wrapped key must not be the data key: unwrapping has to be required.
    expect(sealed.dekWrapped.length).toBeGreaterThan(32);
  });

  it('uses a fresh data key per document', async () => {
    const a = await seal(Buffer.from('same bytes'), FIRM_A, 'doc-1');
    const b = await seal(Buffer.from('same bytes'), FIRM_A, 'doc-2');

    // Identical plaintext under the same firm key must not produce identical
    // ciphertext, or the store leaks which documents match each other.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.dekWrapped.equals(b.dekWrapped)).toBe(false);
  });

  it("one firm's key cannot open another firm's document", async () => {
    const sealed = await seal(Buffer.from('firm A private'), FIRM_A, 'doc-1');
    await expect(unseal(sealed, FIRM_B, 'doc-1')).rejects.toThrow();
  });

  it('ciphertext cannot be moved to another row', async () => {
    // aad binds the blob to its document id, so a swapped storageKey fails
    // loudly instead of decrypting under the wrong record.
    const sealed = await seal(Buffer.from('belongs to doc-1'), FIRM_A, 'doc-1');
    await expect(unseal(sealed, FIRM_A, 'doc-2')).rejects.toThrow();
  });

  it('detects tampering with the ciphertext', async () => {
    const sealed = await seal(Buffer.from('original contents'), FIRM_A, 'doc-1');
    sealed.ciphertext.writeUInt8(sealed.ciphertext.readUInt8(0) ^ 0xff, 0);
    await expect(unseal(sealed, FIRM_A, 'doc-1')).rejects.toThrow();
  });

  it('detects tampering with the auth tag', async () => {
    const sealed = await seal(Buffer.from('original contents'), FIRM_A, 'doc-1');
    sealed.authTag.writeUInt8(sealed.authTag.readUInt8(0) ^ 0xff, 0);
    await expect(unseal(sealed, FIRM_A, 'doc-1')).rejects.toThrow();
  });
});

describe('field encryption', () => {
  it('round-trips an SSN', () => {
    const enc = encryptField('123-45-6789', FIRM_A);
    expect(enc).not.toContain('123');
    expect(decryptField(enc, FIRM_A)).toBe('123-45-6789');
  });

  it('is non-deterministic, so equal values are not visibly equal', () => {
    expect(encryptField('123-45-6789', FIRM_A)).not.toBe(encryptField('123-45-6789', FIRM_A));
  });

  it("cannot be decrypted with another firm's key", () => {
    const enc = encryptField('123-45-6789', FIRM_A);
    expect(() => decryptField(enc, FIRM_B)).toThrow();
  });
});

describe('blind index', () => {
  it('matches equal values so encrypted fields stay searchable', () => {
    const a = blindIndex('X1234567', FIRM_A);
    const b = blindIndex(' x1234567 ', FIRM_A); // normalized before hashing
    expect(blindIndexMatches(a, b)).toBe(true);
  });

  it('does not match different values', () => {
    expect(blindIndexMatches(blindIndex('X1234567', FIRM_A), blindIndex('X7654321', FIRM_A)))
      .toBe(false);
  });

  it('is scoped per firm, so indexes are not comparable across tenants', () => {
    expect(blindIndex('X1234567', FIRM_A)).not.toBe(blindIndex('X1234567', FIRM_B));
  });

  it('does not reveal the value', () => {
    expect(blindIndex('X1234567', FIRM_A)).not.toContain('X1234567');
  });
});
