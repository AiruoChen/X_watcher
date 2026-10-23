import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
export function temporaryStorage(): string { return mkdtempSync(join(realpathSync(tmpdir()), 'x-watcher-')); }
export function cleanupStorage(path: string): void {
  const absolute = resolve(path), temp = realpathSync(tmpdir());
  if (absolute !== path || dirname(absolute) !== temp || !basename(absolute).startsWith('x-watcher-') || realpathSync(absolute) !== absolute)
    throw new Error('Refusing cleanup outside the allocated test directory.');
  rmSync(absolute, { recursive: true, force: true });
}
