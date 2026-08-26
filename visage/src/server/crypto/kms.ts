import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Key management.
 *
 * Documents are never encrypted directly under a long-lived key. Each document
 * gets a fresh data key (DEK); the DEK is wrapped by a per-firm key that lives
 * in the KMS and never leaves it in production. Two consequences:
 *
 *   - A leaked storage bucket yields ciphertext and wrapped keys, both useless.
 *   - Destroying a firm's key crypto-shreds every document that firm owns,
 *     which is what makes "delete our data" a operation we can actually honour.
 */
export interface KmsProvider {
  /** Provision a key for a new firm. Returns the key id stored on Firm.kmsKeyId. */
  createFirmKey(firmId: string): Promise<string>;
  wrapKey(firmKeyId: string, dek: Buffer): Promise<Buffer>;
  unwrapKey(firmKeyId: string, wrapped: Buffer): Promise<Buffer>;
}

const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Development provider. Derives each firm key from one master secret via HKDF.
 *
 * This is not a KMS: the master key sits in an environment variable, so it
 * cannot offer the audit trail or the hardware custody the real thing does, and
 * "destroy the key" is not meaningfully irreversible. It refuses to start in
 * production for exactly that reason.
 */
export class LocalKmsProvider implements KmsProvider {
  readonly #master: Buffer;

  constructor(masterKey: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LocalKmsProvider must not be used in production; set KMS_PROVIDER=aws');
    }
    if (masterKey.length < 32) {
      throw new Error('KMS_LOCAL_MASTER_KEY must be at least 32 bytes');
    }
    this.#master = Buffer.from(masterKey, 'utf8');
  }

  async createFirmKey(firmId: string): Promise<string> {
    // The id is the derivation salt; the key material is never stored.
    return `local:${firmId}`;
  }

  #firmKey(firmKeyId: string): Buffer {
    return Buffer.from(
      hkdfSync('sha256', this.#master, Buffer.from(firmKeyId, 'utf8'), Buffer.from('visage-firm-key'), 32),
    );
  }

  async wrapKey(firmKeyId: string, dek: Buffer): Promise<Buffer> {
    const kek = this.#firmKey(firmKeyId);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    const wrapped = Buffer.concat([iv, cipher.getAuthTag(), body]);
    kek.fill(0);
    return wrapped;
  }

  async unwrapKey(firmKeyId: string, wrapped: Buffer): Promise<Buffer> {
    if (wrapped.length <= IV_LEN + TAG_LEN) throw new Error('wrapped key is malformed');
    const kek = this.#firmKey(firmKeyId);
    const iv = wrapped.subarray(0, IV_LEN);
    const tag = wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const body = wrapped.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    const dek = Buffer.concat([decipher.update(body), decipher.final()]);
    kek.fill(0);
    return dek;
  }
}

let provider: KmsProvider | undefined;

export function kms(): KmsProvider {
  if (provider) return provider;
  const kind = process.env.KMS_PROVIDER ?? 'local';
  if (kind === 'local') {
    provider = new LocalKmsProvider(process.env.KMS_LOCAL_MASTER_KEY ?? '');
    return provider;
  }
  // AWS KMS lands in Phase 8 alongside the hosting decision; failing loudly
  // beats silently falling back to the development provider.
  throw new Error(`KMS_PROVIDER="${kind}" is not implemented yet`);
}

export function __setKmsProviderForTests(p: KmsProvider | undefined): void {
  provider = p;
}
