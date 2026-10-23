import type { DatabaseSync } from 'node:sqlite';
/** Only trusted, synchronous database operations belong in this callback. */
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  if (action.constructor.name === 'AsyncFunction') throw new Error('Async database transaction is forbidden.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    if (result && typeof result === 'object' && 'then' in result) throw new Error('Thenable transaction result is forbidden.');
    db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
