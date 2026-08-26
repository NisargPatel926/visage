// Loads .env for tests without pulling in a dependency. Vitest does not read it
// automatically, and a missing DATABASE_URL here would silently fall back to
// whatever is in the ambient environment — which is exactly how an isolation
// suite ends up passing against the wrong role.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (!m || !m[1]) continue;
  const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
  process.env[m[1]] ??= value;
}
