import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Object storage.
 *
 * Two buckets, and the separation is load-bearing: uploads land in `quarantine`
 * as raw attacker-controlled bytes and only reach `main` after they have been
 * scanned, sanitised, and encrypted. Nothing ever serves from quarantine.
 */
export type Bucket = 'quarantine' | 'main';

export interface Storage {
  put(bucket: Bucket, key: string, body: Buffer): Promise<void>;
  get(bucket: Bucket, key: string): Promise<Buffer>;
  delete(bucket: Bucket, key: string): Promise<void>;
}

/**
 * Filesystem driver for development. The production driver is S3-compatible
 * (R2 or S3); the interface is deliberately three methods so swapping it is
 * mechanical.
 */
export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  #path(bucket: Bucket, key: string): string {
    // Keys are derived from uuids, never from user input — but a traversal here
    // would write outside the store, so it is checked rather than assumed.
    const full = resolve(join(this.root, bucket, key));
    const base = resolve(join(this.root, bucket));
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error('storage key escapes its bucket');
    }
    return full;
  }

  async put(bucket: Bucket, key: string, body: Buffer): Promise<void> {
    const p = this.#path(bucket, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async get(bucket: Bucket, key: string): Promise<Buffer> {
    return readFile(this.#path(bucket, key));
  }

  async delete(bucket: Bucket, key: string): Promise<void> {
    await rm(this.#path(bucket, key), { force: true });
  }
}

let instance: Storage | undefined;

export function storage(): Storage {
  if (instance) return instance;
  const driver = process.env.STORAGE_DRIVER ?? 'local';
  if (driver === 'local') {
    instance = new LocalStorage(process.env.STORAGE_LOCAL_ROOT ?? '.storage');
    return instance;
  }
  throw new Error(`STORAGE_DRIVER="${driver}" is not implemented yet`);
}

export function __setStorageForTests(s: Storage | undefined): void {
  instance = s;
}
