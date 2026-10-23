import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectDatabase } from './integrity.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { backupDatabase } from './backup.js';
export function openDatabase(path: string, create = false): DatabaseSync {
  const memory = path === ':memory:', filename = memory ? path : resolve(path);
  let initialize = memory;
  if (!memory && !existsSync(filename)) {
    if (!create) throw new Error('Database does not exist; explicit creation is required.');
    mkdirSync(dirname(filename), { recursive: true });
    closeSync(openSync(filename, 'wx', 0o600)); initialize = true;
  } else if (!memory) {
    if (!lstatSync(filename).isFile() || statSync(filename).size < 100) throw new Error('Invalid existing database; refusing initialization.');
    const header = Buffer.alloc(16), fd = openSync(filename, 'r');
    try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
    if (!header.equals(Buffer.from('SQLite format 3\0'))) throw new Error('Invalid SQLite header.');
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (!initialize) {
      const version = inspectDatabase(db);
      if (version < SCHEMA_VERSION && !memory) backupDatabase(db, `${filename}.pre-v${SCHEMA_VERSION}.${randomUUID()}.sqlite`);
    }
    migrate(db, initialize);
    inspectDatabase(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    return db;
  } catch (error) { db.close(); throw error; }
}
