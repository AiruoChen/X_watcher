import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Clock, RuntimeLeaseControl } from '../../../domain/ports.js';
import type { AuditRecord, RuntimeOwnership } from '../../../domain/model.js';
import { requireRevision } from '../../../domain/policies/state.js';
import { SystemClock } from '../../clock.js';
import { transaction } from './transaction.js';
export interface RuntimeLease extends RuntimeOwnership { readonly pid: number; readonly sessionId?: string }
export interface ClaimsOptions {
  readonly clock?: Clock;
  readonly hostId?: string;
  readonly ownerId?: string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean | null;
}
function alive(pid: number): boolean | null {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}
export class RuntimeClaims implements RuntimeLeaseControl {
  private readonly clock: Clock;
  private readonly hostId: string;
  private readonly ownerId: string;
  private readonly pid: number;
  private readonly probe: (pid: number) => boolean | null;
  private heldRevision: number | null = null;
  private heldUntilMonotonic = -Infinity;
  constructor(private readonly db: DatabaseSync, options: ClaimsOptions = {}) {
    this.clock = options.clock ?? new SystemClock(); this.hostId = options.hostId ?? hostname();
    this.ownerId = options.ownerId ?? randomUUID(); this.pid = options.pid ?? process.pid; this.probe = options.isProcessAlive ?? alive;
    if (!this.ownerId.trim() || !this.hostId.trim() || !Number.isSafeInteger(this.pid) || this.pid < 1) throw new Error('Invalid runtime identity.');
  }
  workerId(): string { return this.ownerId; }
  now(): string { return this.clock.now().toISOString(); }
  private row(): { revision: number; lease: RuntimeLease | null } {
    const row = this.db.prepare('SELECT revision,payload FROM runtime_ownership WHERE singleton=1').get()!;
    return { revision: Number(row['revision']), lease: row['payload'] === null ? null : JSON.parse(String(row['payload'])) as RuntimeLease };
  }
  current(): RuntimeLease | null { return this.row().lease; }
  private duration(ms: number): void { if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 86_400_000) throw new Error('Invalid runtime lease duration.'); }
  acquire(leaseMs: number): RuntimeLease | null {
    this.duration(leaseMs);
    const before = this.row(), now = this.now();
    // OS liveness checks happen OUTSIDE the SQLite transaction; revision is rechecked inside.
    const reclaimable = before.lease !== null && before.lease.hostId === this.hostId
      && Date.parse(before.lease.leaseUntil) <= Date.parse(now) && this.probe(before.lease.pid) === false;
    const acquired = transaction(this.db, () => {
      const row = this.row();
      if (row.revision !== before.revision || (row.lease !== null && !reclaimable)) return null;
      const lease: RuntimeLease = { ownerId: this.ownerId, hostId: this.hostId, pid: this.pid, sessionId: randomUUID(),
        revision: row.revision + 1, acquiredAt: now, leaseUntil: new Date(Date.parse(now) + leaseMs).toISOString() };
      this.db.prepare('UPDATE runtime_ownership SET revision=?,payload=? WHERE singleton=1').run(lease.revision, JSON.stringify(lease));
      this.audit('acquire_runtime', lease.revision); return lease;
    });
    if (acquired) { this.heldRevision = acquired.revision; this.heldUntilMonotonic = this.clock.monotonicMs() + leaseMs; }
    return acquired;
  }
  assertWriteAuthority(_now: string): void {
    const lease = this.current();
    if (!lease && this.heldRevision === null) return; // Explicit standalone storage operations before a host exists.
    if (!lease || lease.ownerId !== this.ownerId || lease.revision !== this.heldRevision || this.clock.monotonicMs() >= this.heldUntilMonotonic)
      throw new Error('Database execution right is owned elsewhere or expired.');
  }
  assertOwned(expectedRevision: number): RuntimeLease {
    const lease = this.current();
    if (!lease || lease.ownerId !== this.ownerId || this.heldRevision !== lease.revision) throw new Error('Runtime ownership is required.');
    requireRevision(lease.revision, expectedRevision); return lease;
  }
  renew(expectedRevision: number, leaseMs: number): RuntimeLease {
    this.duration(leaseMs); const now = this.now();
    const renewed = transaction(this.db, () => {
      const old = this.assertOwned(expectedRevision);
      const lease = { ...old, revision: old.revision + 1, leaseUntil: new Date(Date.parse(now) + leaseMs).toISOString() };
      this.db.prepare('UPDATE runtime_ownership SET revision=?,payload=? WHERE singleton=1').run(lease.revision, JSON.stringify(lease));
      return lease;
    });
    this.heldRevision = renewed.revision; this.heldUntilMonotonic = this.clock.monotonicMs() + leaseMs; return renewed;
  }
  release(expectedRevision: number): void {
    transaction(this.db, () => {
      const lease = this.assertOwned(expectedRevision);
      if (this.db.prepare("SELECT 1 FROM analysis_jobs WHERE state='processing' LIMIT 1").get()
        || this.db.prepare("SELECT 1 FROM notifications WHERE state='sending' LIMIT 1").get()
        || this.db.prepare("SELECT 1 FROM runtime_tasks WHERE state='running' LIMIT 1").get()) throw new Error('In-flight work must be settled before releasing ownership.');
      this.db.prepare('UPDATE runtime_ownership SET revision=?,payload=NULL WHERE singleton=1').run(lease.revision + 1);
      this.audit('release_runtime', lease.revision);
    });
  }
  audit(action: string, revision: number): void {
    const record: AuditRecord = { id: randomUUID(), actor: this.ownerId, action, entityId: 'runtime', expectedRevision: revision,
      reason: 'Explicit runtime operation', createdAt: this.now() };
    this.db.prepare('INSERT INTO audit_events(payload) VALUES(?)').run(JSON.stringify(record));
  }
}
