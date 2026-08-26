import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Sanitized {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly pageCount: number | null;
  readonly notes: string[];
}

const MAGIC: ReadonlyArray<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** What the bytes actually are, regardless of what the upload claimed. */
export function detectMime(bytes: Buffer): string | null {
  return MAGIC.find((m) => m.test(bytes))?.mime ?? null;
}

/**
 * Make an uploaded file safe to store and to hand back to a browser.
 *
 * The threat is not exotic: a client uploads a PDF carrying JavaScript, and an
 * attorney opens it in the console. So PDFs are rewritten by qpdf, which drops
 * active content, and images are re-encoded by sharp, which drops EXIF —
 * passport photos routinely carry the GPS coordinates of someone's home, and
 * that would otherwise sit in the case file forever.
 *
 * Anything we cannot identify is rejected. Storing an unknown format means
 * serving it back later with a content type we guessed.
 */
export async function sanitize(bytes: Buffer, declaredMime: string): Promise<Sanitized> {
  const actual = detectMime(bytes);
  if (!actual) throw new Error('unrecognised file type');

  const notes: string[] = [];
  if (declaredMime && declaredMime !== actual) {
    // Not fatal — browsers mislabel HEIC and octet-stream constantly — but the
    // detected type always wins.
    notes.push(`declared ${declaredMime}, detected ${actual}`);
  }

  if (actual === 'application/pdf') return sanitizePdf(bytes, notes);

  // Re-encode to a predictable format. rotate() applies the EXIF orientation
  // before that data is discarded, so a phone photo is not silently sideways.
  const sharp = (await import('sharp')).default;
  const out = await sharp(bytes, { failOn: 'error' })
    .rotate()
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  notes.push('re-encoded, metadata stripped');
  return { bytes: out, mimeType: 'image/jpeg', pageCount: 1, notes };
}

async function sanitizePdf(bytes: Buffer, notes: string[]): Promise<Sanitized> {
  const src = join(tmpdir(), `visage-in-${randomUUID()}.pdf`);
  const dst = join(tmpdir(), `visage-out-${randomUUID()}.pdf`);
  await writeFile(src, bytes);
  try {
    // --decrypt also normalises USCIS-style encrypted PDFs; object-streams
    // disabled keeps the output inspectable.
    await run('qpdf', ['--decrypt', '--object-streams=disable',
                       '--remove-restrictions', src, dst]);
    const out = await readFile(dst);
    notes.push('rewritten by qpdf; active content removed');

    const pages = out.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? null;
    return { bytes: out, mimeType: 'application/pdf', pageCount: pages, notes };
  } catch (err) {
    // qpdf exit 3 is "warnings but output written" — acceptable for the
    // malformed scans people produce. Anything else is a real failure.
    const e = err as { code?: number };
    if (e.code === 3) {
      const out = await readFile(dst).catch(() => null);
      if (out) {
        notes.push('rewritten by qpdf with warnings');
        return { bytes: out, mimeType: 'application/pdf', pageCount: null, notes };
      }
    }
    throw new Error('could not process this PDF');
  } finally {
    await rm(src, { force: true });
    await rm(dst, { force: true });
  }
}
