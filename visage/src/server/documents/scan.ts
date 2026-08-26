import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ScanResult {
  readonly clean: boolean;
  readonly reason?: string;
  readonly scanner: string;
}

export interface Scanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}

/** EICAR: the industry-standard harmless test string every scanner must flag. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Structural checks, not antivirus.
 *
 * This exists so the pipeline is exercised end to end in development and CI
 * without a ClamAV daemon. It catches the things that actually matter for a
 * document portal — active content inside a PDF, type confusion between the
 * declared and real format — but it does not detect malware and must not be
 * mistaken for something that does. Production sets SCANNER=clamav.
 */
export class HeuristicScanner implements Scanner {
  readonly name = 'heuristic';

  async scan(bytes: Buffer): Promise<ScanResult> {
    const head = bytes.subarray(0, 4096).toString('latin1');
    if (head.includes(EICAR) || bytes.toString('latin1').includes(EICAR)) {
      return { clean: false, reason: 'EICAR test signature', scanner: this.name };
    }

    if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
      const body = bytes.toString('latin1');
      // Active content in a document a lawyer will open. /OpenAction and
      // /Launch are the ones that execute without interaction.
      for (const marker of ['/JavaScript', '/JS', '/Launch', '/OpenAction', '/EmbeddedFile']) {
        if (body.includes(marker)) {
          return { clean: false, reason: `PDF contains ${marker}`, scanner: this.name };
        }
      }
    }
    return { clean: true, scanner: this.name };
  }
}

/** Production scanner: clamscan over a temp file. */
export class ClamAvScanner implements Scanner {
  readonly name = 'clamav';

  async scan(bytes: Buffer): Promise<ScanResult> {
    const { writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');

    const path = join(tmpdir(), `visage-scan-${randomUUID()}`);
    await writeFile(path, bytes);
    try {
      await run('clamscan', ['--no-summary', '--stdout', path]);
      return { clean: true, scanner: this.name };
    } catch (err) {
      // clamscan exits 1 when it finds something, 2 on error. Only 1 means
      // infected; anything else must fail closed rather than pass silently.
      const e = err as { code?: number; stdout?: string };
      if (e.code === 1) {
        return { clean: false, reason: (e.stdout ?? 'infected').trim(), scanner: this.name };
      }
      throw new Error(`clamscan failed: ${String(e.stdout ?? err)}`);
    } finally {
      await rm(path, { force: true });
    }
  }
}

let instance: Scanner | undefined;

export function scanner(): Scanner {
  if (instance) return instance;
  instance = process.env.SCANNER === 'clamav' ? new ClamAvScanner() : new HeuristicScanner();
  return instance;
}

export function __setScannerForTests(s: Scanner | undefined): void {
  instance = s;
}
