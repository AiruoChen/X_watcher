import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeState } from '../../../domain/ports.js';
import type { ScheduledTask } from '../../../domain/model.js';
import { isInstant } from '../../../domain/time.js';
import { requireRevision } from '../../../domain/policies/state.js';
import { RuntimeClaims } from './claims.js';
import { transaction } from './transaction.js';

export class SqliteRuntimeState implements RuntimeState {
  constructor(private readonly db: DatabaseSync, private readonly claims: RuntimeClaims) {}
  private write<T>(action: () => T): T {
    return transaction(this.db, () => {
      const lease = this.claims.current();
      if (!lease) throw new Error('Runtime ownership is required.');
      this.claims.assertOwned(lease.revision); this.claims.assertWriteAuthority(this.claims.now());
      return action();
    });
  }
  private get(id: string): ScheduledTask | null {
    const row = this.db.prepare('SELECT payload FROM runtime_tasks WHERE id=?').get(id);
    return row ? JSON.parse(String(row['payload'])) as ScheduledTask : null;
  }
  private save(task: ScheduledTask): void {
    if (!isInstant(task.dueAt)) throw new Error('Invalid task deadline.');
    this.db.prepare('INSERT INTO runtime_tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,due_ms=excluded.due_ms,payload=excluded.payload')
      .run(task.id, task.revision, task.state, Date.parse(task.dueAt), JSON.stringify(task));
  }
  ensure(task: ScheduledTask): void {
    this.write(() => {
      const old = this.get(task.id);
      if (old) {
        if (old.stage !== task.stage || old.targetId !== task.targetId) throw new Error('Runtime task identity collision.');
        if (old.configRevision !== task.configRevision) this.save({ ...old, configRevision: task.configRevision, revision: old.revision + 1 });
      } else {
        if (task.revision !== 0 || task.state !== 'idle' || task.failures !== 0) throw new Error('Invalid initial runtime task.');
        this.save(task);
      }
    });
  }
  tasks(): readonly ScheduledTask[] {
    return this.db.prepare('SELECT payload FROM runtime_tasks ORDER BY id').all().map(row => JSON.parse(String(row['payload'])) as ScheduledTask);
  }
  claim(id: string, expectedRevision: number, now: string): ScheduledTask | null {
    return this.write(() => {
      const old = this.get(id);
      // Scheduler decides due-ness using its monotonic clock; this transaction fences duplicate claims.
      if (!old || old.revision !== expectedRevision || old.state !== 'idle') return null;
      const task: ScheduledTask = { ...old, revision: old.revision + 1, state: 'running', startedAt: now };
      this.save(task); return task;
    });
  }
  finish(id: string, expectedRevision: number, dueAt: string, failed: boolean, exhausted: boolean, now: string,
    failure?: { readonly code: string; readonly retryAt: string | null }): void {
    this.write(() => {
      const old = this.get(id);
      if (!old || old.state !== 'running') throw new Error('Task is not running.');
      requireRevision(old.revision, expectedRevision);
      if (failure?.retryAt && !isInstant(failure.retryAt)) throw new Error('Invalid retry deadline.');
      this.save({ ...old, revision: old.revision + 1, state: exhausted ? 'needs_attention' : 'idle', dueAt,
        failures: failed ? old.failures + 1 : 0, finishedAt: now, failureCode: failure?.code ?? null,
        retryNotBeforeAt: failure?.retryAt ?? null });
    });
  }
  recover(now: string): number {
    return this.write(() => {
      let count = 0;
      for (const old of this.tasks()) if (old.state === 'running') {
        this.save({ ...old, revision: old.revision + 1, state: 'idle', dueAt: now, finishedAt: now }); count++;
      }
      if (count) this.claims.audit('recover_runtime_tasks', this.claims.current()!.revision);
      return count;
    });
  }
}
