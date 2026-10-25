import type { DatabaseSync } from 'node:sqlite';
import type { OperationsStore } from '../../../domain/ports.js';
import type { BudgetDecision, BudgetRequest, ControlCommand, ControlResult, HealthCommand, HealthState, Incident,
  TokenUsage, UsageRecord, UsageTotal } from '../../../domain/model.js';
import { budgetReason, evolveHealth, SERVICES } from '../../../domain/policies/operations.js';
import { isInstant } from '../../../domain/time.js';
import { transaction } from './transaction.js';
import { RuntimeClaims } from './claims.js';
import { SqliteRetention } from './retention.js';

export class SqliteOperations implements OperationsStore {
  private readonly retention: SqliteRetention;
  constructor(private readonly db: DatabaseSync, private readonly claims: RuntimeClaims) { this.retention = new SqliteRetention(db, claims); }
  private write<T>(action: () => T): T { return transaction(this.db, () => { this.claims.assertWriteAuthority(this.claims.now()); return action(); }); }
  private one<T>(table: 'usage_ledger' | 'operation_health' | 'operation_incidents', id: string): T | null {
    const row = this.db.prepare('SELECT payload FROM ' + table + ' WHERE id=?').get(id);
    return row ? JSON.parse(String(row['payload'])) as T : null;
  }
  budgetDay(day: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isInstant(day + 'T00:00:00Z')) throw new Error('Invalid budget day.');
    const old = String(this.db.prepare('SELECT day FROM budget_clock WHERE singleton=1').get()!['day']);
    return old > day ? old : day;
  }
  usage(day?: string): readonly UsageTotal[] {
    const rows = day ? this.db.prepare('SELECT * FROM usage_daily WHERE day=? ORDER BY service').all(day)
      : this.db.prepare('SELECT * FROM usage_daily ORDER BY day,service').all();
    return rows.map(r => ({ day: String(r['day']), service: r['service'] as UsageTotal['service'], calls: Number(r['calls']), currency: r['currency'] === null ? null : String(r['currency']),
      knownMicros: Number(r['known_micros']), unpricedCalls: Number(r['unpriced_calls']), inputTokens: Number(r['input_tokens']),
      outputTokens: Number(r['output_tokens']), measuredCalls: Number(r['measured_calls']) }));
  }
  usageRecord(id: string): UsageRecord | null { return this.one('usage_ledger', id); }
  reserveUsage(c: BudgetRequest): BudgetDecision {
    if (!isInstant(c.at) || !SERVICES.includes(c.service) || !/^[\w:-]{1,150}$/.test(c.id)) throw new Error('Invalid usage reservation.');
    return this.write(() => {
      if (this.usageRecord(c.id)) throw new Error('Usage reservation already exists.');
      const day = this.budgetDay(c.day), totals = this.usage(day), reason = budgetReason(totals, c.service, c.policy);
      this.db.prepare('UPDATE budget_clock SET day=? WHERE singleton=1').run(day);
      if (reason) return { allowed: false, day, reason };
      const cost = c.policy.unitMicros[c.service];
      const record: UsageRecord = { id: c.id, service: c.service, day, state: 'reserved', createdAt: c.at, currency: cost === null ? null : c.policy.currency, priceReference: cost === null ? null : c.policy.priceReference,
        configRevision:c.configRevision, estimatedMicros: cost, usage: null, finishedAt: null };
      this.db.prepare('INSERT INTO usage_ledger VALUES(?,?,?,?)').run(c.id, day, c.service, JSON.stringify(record));
      this.db.prepare('INSERT INTO usage_daily(day,service,currency,calls,known_micros,unpriced_calls,input_tokens,output_tokens,measured_calls) VALUES(?,?,?,1,?,?,0,0,0) ON CONFLICT(day,service) DO UPDATE SET currency=CASE WHEN calls=unpriced_calls THEN excluded.currency ELSE currency END,calls=calls+1,known_micros=known_micros+excluded.known_micros,unpriced_calls=unpriced_calls+excluded.unpriced_calls')
        .run(day, c.service, cost === null ? null : c.policy.currency, cost ?? 0, cost === null ? 1 : 0);
      return { allowed: true, record };
    });
  }
  startUsage(id: string): void {
    this.write(() => { const old = this.usageRecord(id); if (!old || old.state !== 'reserved') throw new Error('Usage permit is not reserved.');
      this.db.prepare('UPDATE usage_ledger SET payload=? WHERE id=?').run(JSON.stringify({ ...old, state: 'started' }), id); });
  }
  finishUsage(id: string, success: boolean, usage?: TokenUsage): void {
    if (usage && (![usage.inputTokens, usage.outputTokens].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 1e9))) throw new Error('Invalid measured usage.');
    this.write(() => {
      const old = this.usageRecord(id); if (!old || old.state !== 'started') throw new Error('Usage permit is not started.');
      if (usage) {
        const total = this.usage(old.day).find(r => r.service === old.service)!;
        if (![total.inputTokens + usage.inputTokens,total.outputTokens + usage.outputTokens].every(Number.isSafeInteger)) throw new Error('Measured usage exceeds safe integer range.');
      }
      this.db.prepare('UPDATE usage_ledger SET payload=? WHERE id=?').run(JSON.stringify({ ...old, state: success ? 'complete' : 'failed', usage: usage ?? null, finishedAt: this.claims.now() }), id);
      if (usage) this.db.prepare('UPDATE usage_daily SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,measured_calls=measured_calls+1 WHERE day=? AND service=?')
        .run(usage.inputTokens, usage.outputTokens, old.day, old.service);
    });
  }
  cancelUsage(id: string): void {
    this.write(() => {
      const old = this.usageRecord(id); if (!old || old.state !== 'reserved') throw new Error('Only an unstarted reservation may be cancelled.');
      this.db.prepare('UPDATE usage_ledger SET payload=? WHERE id=?').run(JSON.stringify({ ...old, state: 'cancelled', finishedAt: this.claims.now() }), id);
      this.db.prepare('UPDATE usage_daily SET calls=calls-1,known_micros=known_micros-?,unpriced_calls=unpriced_calls-? WHERE day=? AND service=?')
        .run(old.estimatedMicros ?? 0, old.estimatedMicros === null ? 1 : 0, old.day, old.service);
    });
  }
  health(): readonly HealthState[] { return this.db.prepare('SELECT payload FROM operation_health ORDER BY id').all().map(r => JSON.parse(String(r['payload'])) as HealthState); }
  incidents(): readonly Incident[] { return this.db.prepare('SELECT payload FROM operation_incidents ORDER BY id').all().map(r => JSON.parse(String(r['payload'])) as Incident); }
  recordHealth(c: HealthCommand): void {
    this.write(() => {
      const next = evolveHealth(this.one<HealthState>('operation_health', c.key), this.one<Incident>('operation_incidents', c.key), c);
      this.db.prepare('INSERT INTO operation_health VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(c.key, JSON.stringify(next.health));
      if (next.incident) this.db.prepare('INSERT INTO operation_incidents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(c.key, JSON.stringify(next.incident));
      for (const n of next.notifications) this.db.prepare("INSERT INTO notifications(id,state,payload) VALUES(?,'pending',?)").run(n.id, JSON.stringify(n));
    });
  }
  control(id: string): ControlResult | null {
    const row = this.db.prepare('SELECT id,state,code FROM operation_commands WHERE id=?').get(id);
    return row ? { id: String(row['id']), state: row['state'] as ControlResult['state'], code: String(row['code']) } : null;
  }
  requestControl(c: ControlCommand): ControlResult {
    if (!isInstant(c.at) || !/^[\w:-]{1,128}$/.test(c.id) || !['check','stop','resume','retry_analysis'].includes(c.kind)
      || typeof c.reason !== 'string' || !c.reason.trim() || c.reason.length > 500 || /[\r\n\0]/.test(c.reason)
      || (['resume','retry_analysis'].includes(c.kind) && (!c.entityId || !Number.isSafeInteger(c.expectedRevision) || c.expectedRevision! < 0)))
      throw new Error('Invalid operation control request.');
    // A different process may append bounded commands; only the owner can consume or change business state.
    return transaction(this.db, () => {
      if (c.targetId && !this.db.prepare('SELECT 1 FROM targets WHERE id=?').get(c.targetId)) throw new Error('Unknown target.');
      if (c.kind === 'check' && !c.targetId) throw new Error('Check target is required.');
      const payload = JSON.stringify(c), previous = this.db.prepare('SELECT payload FROM operation_commands WHERE id=?').get(c.id);
      if (previous) { if (String(previous['payload']) !== payload) throw new Error('Control ID collision.'); return this.control(c.id)!; }
      const lease = this.claims.current();
      const owner = lease ? lease.ownerId + '/' + (lease.sessionId ?? lease.acquiredAt) : null;
      const code = c.kind === 'stop' && !owner ? 'no_running_host' : 'queued';
      this.db.prepare('INSERT INTO operation_commands VALUES(?,?,?,?,?,?)').run(c.id, code === 'queued' ? 'pending' : 'rejected', code, payload, owner, c.at);
      return this.control(c.id)!;
    });
  }
  applyControls(now: string): { stop: boolean } {
    return this.write(() => {
      const lease = this.claims.current(); if (!lease) throw new Error('Runtime ownership is required.');
      this.claims.assertOwned(lease.revision);
      let stop = false;
      for (const row of this.db.prepare("SELECT * FROM operation_commands WHERE state='pending' ORDER BY rowid LIMIT 100").all()) {
        const c = JSON.parse(String(row['payload'])) as ControlCommand;
        let code = 'applied';
        if (Date.parse(now) - Date.parse(c.at) > 86400000) code = 'expired';
        else if (c.kind === 'stop') { if (row['owner_id'] !== lease.ownerId + '/' + (lease.sessionId ?? lease.acquiredAt)) code = 'host_changed'; else stop = true; }
        else if (c.kind === 'retry_analysis') {
          const r = this.db.prepare('SELECT payload FROM analysis_jobs WHERE id=?').get(c.entityId!);
          const job = r ? JSON.parse(String(r['payload'])) as import('../../../domain/model.js').AnalysisJob : null;
          if (!job || job.revision !== c.expectedRevision || job.state !== 'needs_attention') code = 'revision_or_state_changed';
          else {
            const next = { ...job, revision: job.revision + 1, state: 'pending', attempts: 0, nextAttemptAt: null };
            this.db.prepare("UPDATE analysis_jobs SET revision=?,state='pending',next_ms=NULL,claimed_by=NULL,payload=? WHERE id=?")
              .run(next.revision, JSON.stringify(next), job.id);
          }
        } else {
          const r = c.kind === 'check'
            ? this.db.prepare("SELECT payload FROM runtime_tasks WHERE json_extract(payload,'$.stage')='ingest' AND json_extract(payload,'$.targetId')=?").get(c.targetId!)
            : this.db.prepare('SELECT payload FROM runtime_tasks WHERE id=?').get(c.entityId!);
          const task = r ? JSON.parse(String(r['payload'])) as import('../../../domain/model.js').ScheduledTask : null;
          if (!task) code = 'task_missing';
          else if (task.state === 'running') code = c.kind === 'check' ? 'already_running' : 'revision_or_state_changed';
          else if (c.kind === 'resume' && ((task.state !== 'needs_attention' && !(task.state === 'idle' && task.failureCode === 'budget_exhausted')) || task.revision !== c.expectedRevision)) code = 'revision_or_state_changed';
          else if (c.kind === 'check' && task.state !== 'idle') code = 'needs_attention';
          else if ((task.retryNotBeforeAt && Date.parse(task.retryNotBeforeAt) > Date.parse(now) && !(c.kind === 'resume' && task.failureCode === 'budget_exhausted'))
            || (c.kind === 'check' && task.failures > 0 && Date.parse(task.dueAt) > Date.parse(now))) code = 'backoff_active';
          else {
            const next = { ...task, revision: task.revision + 1, state: 'idle', dueAt: now,
              ...(c.kind === 'resume' ? { failures: 0, failureCode: null, retryNotBeforeAt: null } : {}) };
            this.db.prepare("UPDATE runtime_tasks SET revision=?,state='idle',due_ms=?,payload=? WHERE id=?")
              .run(next.revision, Date.parse(now), JSON.stringify(next), task.id);
          }
        }
        const state = ['applied','already_running'].includes(code) ? 'applied' : 'rejected';
        this.db.prepare('UPDATE operation_commands SET state=?,code=? WHERE id=?').run(state, code, c.id);
        this.db.prepare('INSERT INTO audit_events(payload) VALUES(?)').run(JSON.stringify({ kind: 'operations', action: c.kind,
          entityId: c.entityId ?? c.targetId, reason: c.reason, expectedRevision: c.expectedRevision, createdAt: now, result: code }));
      }
      return { stop };
    });
  }
  summary(): Readonly<Record<string, unknown>> {
    const countStates = (table: 'analysis_jobs' | 'notifications' | 'runtime_tasks'): Record<string, number> =>
      Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) count FROM ' + table + ' GROUP BY state').all().map(r => [String(r['state']), Number(r['count'])]));
    const targets = this.db.prepare('SELECT id,provider,payload FROM targets ORDER BY id').all().map(r => {
      const id = String(r['id']), target = JSON.parse(String(r['payload'])) as import('../../../domain/model.js').TargetIdentity;
      const cp = this.db.prepare('SELECT observed_at,revision FROM checkpoints WHERE target_id=?').get(id);
      const coverage = this.db.prepare('SELECT payload FROM coverage_ranges WHERE target_id=? ORDER BY end_ms DESC,start_ms LIMIT 1').get(id);
      const range = coverage ? JSON.parse(String(coverage['payload'])) as import('../../../domain/model.js').Coverage : null;
      const report = this.db.prepare('SELECT day,revision,json_extract(payload,\'$.state\') state FROM digest_reports WHERE target_id=? ORDER BY day DESC,revision DESC LIMIT 1').get(id);
      const progress = this.db.prepare('SELECT day,json_extract(payload,\'$.state\') state FROM report_progress WHERE target_id=? ORDER BY day DESC LIMIT 1').get(id);
      return { id, handle: target.handle, provider: r['provider'], enabled: target.enabled,
        lastObservationAt: cp?.['observed_at'] ?? null, checkpointRevision: cp?.['revision'] ?? 0,
        coverage: range ? { from: range.from, to: range.to, status: range.status, scope: range.scope ?? 'unspecified' } : null,
        latestReport: report ?? null, latestProgress: progress ?? null };
    });
    const schedules = this.db.prepare('SELECT payload FROM runtime_tasks ORDER BY id').all().map(r => {
      const t = JSON.parse(String(r['payload'])) as import('../../../domain/model.js').ScheduledTask;
      return { id: t.id, stage: t.stage, targetId: t.targetId, revision: t.revision, state: t.state,
        lastStartedAt: t.startedAt, lastFinishedAt: t.finishedAt, nextAt: t.dueAt, failures: t.failures,
        failureCode: t.failureCode ?? null, retryNotBeforeAt: t.retryNotBeforeAt ?? null };
    });
    return { archives: this.db.prepare('SELECT kind,COUNT(*) count FROM retained_keys GROUP BY kind').all(), runtime: { active: this.claims.current() !== null, leaseUntil: this.claims.current()?.leaseUntil ?? null },
      targets, schedules, analysis: countStates('analysis_jobs'), notifications: countStates('notifications'),
      health: this.health(), incidents: this.incidents(), unresolvedUsage: this.db.prepare("SELECT COUNT(*) n FROM usage_ledger WHERE json_extract(payload,'$.state') IN ('reserved','started')").get()!['n'] };
  }
  analysisJobs(limit: number): readonly Readonly<Record<string, unknown>>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid analysis job limit.');
    return this.db.prepare('SELECT id,state,revision,payload FROM analysis_jobs ORDER BY seq DESC LIMIT ?').all(limit).map(r => {
      const job = JSON.parse(String(r['payload'])) as import('../../../domain/model.js').AnalysisJob;
      return { id:job.id,targetId:job.targetId,state:job.state,revision:job.revision,attempts:job.attempts,nextAttemptAt:job.nextAttemptAt,
        analyzerVersion:job.analyzerVersion,promptVersion:job.promptVersion };
    });
  }
  notifications(limit: number): readonly Readonly<Record<string, unknown>>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid notification limit.');
    return this.db.prepare('SELECT id,state,revision,payload,next_delivery_ms FROM notifications ORDER BY seq DESC LIMIT ?').all(limit).map(r => {
      const n = JSON.parse(String(r['payload'])) as import('../../../domain/model.js').Notification;
      return { id: r['id'], state: r['state'], revision: r['revision'], kind: n.kind, targetId: n.targetId, createdAt: n.createdAt,
        nextAttemptAt: r['next_delivery_ms'] === null ? null : new Date(Number(r['next_delivery_ms'])).toISOString() };
    });
  }
  cleanupPlan(at: string, postDays: number, auditDays: number) { return this.retention.plan(at, postDays, auditDays); }
  cleanup(plan: import('../../../domain/model.js').CleanupPlan) { return this.retention.apply(plan); }
  archiveRows(from: string, to: string, targetIds: readonly string[]) { return this.retention.archive(from, to, targetIds); }
}
