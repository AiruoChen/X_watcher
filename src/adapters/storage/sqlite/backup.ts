import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspectDatabase } from './integrity.js';
export interface BackupManifest { readonly schemaVersion: number; readonly sha256: string; readonly bytes: number }
export function fileHash(path: string): string {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { let size: number; while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function verify(path: string): number {
  if (!lstatSync(path).isFile()) throw new Error('Backup must be a regular file.');
  const db = new DatabaseSync(path, { readOnly: true });
  try { return inspectDatabase(db); } finally { db.close(); }
}
function publish(path: string, fill: (stage: string) => void): BackupManifest {
  const target = resolve(path);
  if (existsSync(target)) throw new Error('Destination already exists; overwrite is forbidden.');
  mkdirSync(dirname(target), { recursive: true });
  const stage = `${target}.${randomUUID()}.partial`;
  closeSync(openSync(stage, 'wx', 0o600));
  try {
    fill(stage);
    const fd = openSync(stage, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    const schemaVersion = verify(stage), sha256 = fileHash(stage), bytes = statSync(stage).size;
    linkSync(stage, target); // Atomic, same-directory, no-clobber publication.
    return { schemaVersion, sha256, bytes };
  } finally { if (existsSync(stage)) unlinkSync(stage); }
}
export function backupDatabase(db: DatabaseSync, destination: string): BackupManifest {
  return publish(destination, stage => { db.prepare('VACUUM main INTO ?').run(stage); });
}
/** Restore to a NEW path only. The old database and its WAL remain untouched. */
export function restoreBackup(source: string, destination: string, expectedSha256: string): BackupManifest {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || fileHash(source) !== expectedSha256) throw new Error('Backup checksum mismatch.');
  verify(source);
  return publish(destination, stage => {
    copyFileSync(source, stage);
    if (fileHash(stage) !== expectedSha256) throw new Error('Backup changed during restore.');
  });
}
