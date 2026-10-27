import type { SQLInputValue } from 'node:sqlite';
import type { DeliveryBinding, DeliveryRecord, DeliveryResolution, MailAudit } from '../../../domain/model.js';
import { deliveryOutcome } from '../../../domain/policies/mail-retry.js';
import { resolvedDeliveryState, validateBinding } from '../../../domain/policies/mail.js';
import type { AnalysisCommit, IngestionCommit, PollCommit, WatchStore } from '../../../domain/ports.js';
import type { AnalysisJob, AnalysisResult, AnalyzedPost, Checkpoint, Coverage, DeliveryAttempt, DeliveryClaim,
  DeliveryResult, DigestReport, DigestWindow, Notification, OutboxEntry, PostVersion, RuleEvent, SourceQuery, TargetIdentity } from '../../../domain/model.js';
import type { SemanticAnalysis } from '../../../domain/model.js';
import { correctionBasis, validateCorrectionLink } from '../../../domain/policies/correction.js';
import { validateReanalysis } from '../../../domain/policies/reanalysis.js';
import { RevisionConflictError } from '../../../domain/errors.js';
import { stableId } from '../../../domain/identifiers.js';
import { isInstant } from '../../../domain/time.js';
import { covers, validIngestionCoverage } from '../../../domain/policies/coverage.js';
import { requireRevision, transitionJob, transitionDelivery } from '../../../domain/policies/state.js';
import { validatePost, validateAnalysis } from '../../../domain/validation.js';
import { openDatabase } from './connection.js';
import { transaction } from './transaction.js';
import { backupDatabase, type BackupManifest } from './backup.js';
import { RuntimeClaims, type ClaimsOptions } from './claims.js';
import { SqliteRuntimeState } from './runtime-state.js';

const pack = (value: unknown): string => JSON.stringify(structuredClone(value));
/** Indexed row storage. No process-wide cache is authoritative. */
export class SqliteStore implements WatchStore {
  readonly durability = 'persistent';
  private readonly db;
  readonly runtime: RuntimeClaims;
  readonly schedules: SqliteRuntimeState;
  constructor(path: string, options: { create?: boolean; claims?: ClaimsOptions } = {}) {
    this.db = openDatabase(path, options.create ?? false);
    try { this.runtime = new RuntimeClaims(this.db, options.claims); this.schedules = new SqliteRuntimeState(this.db, this.runtime); }
    catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  backup(destination: string): BackupManifest { return backupDatabase(this.db, destination); }
  private one<T>(sql: string, ...args: SQLInputValue[]): T | null {
    const row = this.db.prepare(sql).get(...args); return row ? JSON.parse(String(row['payload'])) as T : null;
  }
  private rows<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args).map(row => JSON.parse(String(row['payload'])) as T);
  }
  private write<T>(action: () => T): T {
    const now = this.runtime.now();
    return transaction(this.db, () => { this.runtime.assertWriteAuthority(now); return action(); });
  }
  checkpoint(targetId: string): Checkpoint {
    const row = this.db.prepare('SELECT revision,cursor,observed_at FROM checkpoints WHERE target_id=?').get(targetId);
    return row ? { revision: Number(row['revision']), cursor: row['cursor'] as string | null, observedAt: row['observed_at'] as string | null }
      : { revision: 0, cursor: null, observedAt: null };
  }
  target(id: string): TargetIdentity | null { return this.one('SELECT payload FROM targets WHERE id=?', id); }
  registerTarget(target: TargetIdentity): TargetIdentity {
    return this.write(() => {
      const old = this.target(target.id);
      if (old) {
        if (old.authorId !== target.authorId || old.provider !== target.provider) throw new Error('Target identity changed.');
        return old;
      }
      if (!target.authorId || !isInstant(target.monitorStartedAt)) throw new Error('Invalid target identity.');
      this.db.prepare('INSERT INTO targets VALUES(?,?,?,?)').run(target.id, target.provider, target.authorId, pack(target));
      this.db.prepare('INSERT INTO checkpoints VALUES(?,0,NULL,NULL)').run(target.id);
      return this.target(target.id)!;
    });
  }
  hasPost(targetId: string, postId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM post_versions WHERE target_id=? AND post_id=? LIMIT 1').get(targetId, postId)
      || !!this.db.prepare('SELECT 1 FROM legacy_posts WHERE target_id=? AND post_id=?').get(targetId, postId);
  }
  private saveCoverage(coverage: Coverage): void {
    const old = this.one<Coverage>('SELECT payload FROM coverage_ranges WHERE id=?', coverage.id);
    if (old && pack(old) !== pack(coverage)) throw new Error('Coverage identity collision.');
    this.db.prepare('INSERT INTO coverage_ranges VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(coverage.id, coverage.targetId, Date.parse(coverage.from), Date.parse(coverage.to), coverage.status, pack(coverage));
  }
  commitIngestion(commit: IngestionCommit): void {
    this.write(() => {
      const checkpoint = this.checkpoint(commit.targetId), target = this.target(commit.targetId), range = commit.coverage;
      requireRevision(checkpoint.revision, commit.expectedRevision);
      if (!target || range.targetId !== target.id || !validIngestionCoverage(range, target.provider)
        || !isInstant(range.from) || !isInstant(range.to) || Date.parse(range.from) >= Date.parse(range.to)
        || range.to !== commit.observedAt || (checkpoint.observedAt !== null && Date.parse(range.to) < Date.parse(checkpoint.observedAt))) throw new Error('Invalid complete coverage.');
      for (const post of commit.posts) {
        validatePost(post, target);
        if (post.targetId !== target.id || post.provider !== target.provider || post.authorId !== target.authorId
          || post.key !== stableId('post', target.provider, target.authorId, post.id, post.sourceVersion)
          || !/^[a-f0-9]{64}$/.test(post.contentHash) || !isInstant(post.discoveredAt)) throw new Error('Invalid post version.');
        const old = this.one<PostVersion>('SELECT payload FROM post_versions WHERE key=?', post.key);
        if (old && (old.contentHash !== post.contentHash || old.text !== post.text || old.publishedAt !== post.publishedAt)) throw new Error('Post version is immutable.');
        this.db.prepare('INSERT INTO post_versions(key,target_id,post_id,published_ms,payload) VALUES(?,?,?,?,?) ON CONFLICT(key) DO NOTHING')
          .run(post.key, post.targetId, post.id, Date.parse(post.publishedAt), pack(post));
      }
      for (const job of commit.jobs) {
        const post = this.one<PostVersion>('SELECT payload FROM post_versions WHERE key=?', job.postKey);
        if (!post || post.targetId !== target.id || job.targetId !== target.id
          || job.id !== stableId('analysis', job.postKey, job.analyzerVersion, job.promptVersion)
          || job.state !== 'pending' || job.revision !== 0 || job.attempts !== 0 || job.nextAttemptAt !== null) throw new Error('Invalid analysis job.');
        this.db.prepare('INSERT INTO analysis_jobs(id,post_key,target_id,state,revision,next_ms,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
          .run(job.id, job.postKey, job.targetId, job.state, job.revision, null, pack(job));
      }
      for (const post of commit.posts) if (!this.db.prepare('SELECT 1 FROM analysis_jobs WHERE post_key=? LIMIT 1').get(post.key)) throw new Error('Missing analysis job.');
      this.saveCoverage(range);
      const updated = this.db.prepare('UPDATE checkpoints SET revision=revision+1,cursor=?,observed_at=? WHERE target_id=? AND revision=?')
        .run(commit.cursor, commit.observedAt, target.id, commit.expectedRevision);
      if (Number(updated.changes) !== 1) throw new RevisionConflictError();
    });
  }
  recordCoverageGap(gap: Coverage, expectedRevision: number): void {
    this.write(() => {
      requireRevision(this.checkpoint(gap.targetId).revision, expectedRevision);
      if (!this.target(gap.targetId) || gap.status !== 'gap' || !gap.reason?.trim() || !isInstant(gap.from) || !isInstant(gap.to)
        || Date.parse(gap.from) >= Date.parse(gap.to)) throw new Error('Invalid coverage gap.');
      this.saveCoverage(gap);
    });
  }
  coverage(targetId: string): readonly Coverage[] { return this.rows('SELECT payload FROM coverage_ranges WHERE target_id=? ORDER BY start_ms,id', targetId); }
  isCovered(targetId: string, query: SourceQuery): boolean {
    const ranges = this.rows<Coverage>("SELECT payload FROM coverage_ranges WHERE target_id=? AND status='complete' AND start_ms<=? AND end_ms>? ORDER BY start_ms", targetId, Date.parse(query.to), Date.parse(query.from));
    return covers(ranges, targetId, query);
  }
  postVersion(key: string): PostVersion | null { return this.one('SELECT payload FROM post_versions WHERE key=?', key); }
  previousPostVersion(postKey: string, explicitPostId: string | null): PostVersion | null {
    const post = this.postVersion(postKey); if (!post) return null;
    const source = post.origin?.sourcePostId ?? post.id, history = post.origin?.editHistory ?? [];
    const ids = explicitPostId !== null ? [explicitPostId] : [post.id, ...history.slice(0, Math.max(0, history.indexOf(source)))];
    const marks = ids.map(() => '?').join(',');
    const candidates = this.rows<PostVersion>(`SELECT p.payload FROM post_versions p WHERE p.target_id=?
      AND p.seq<(SELECT seq FROM post_versions WHERE key=?) AND (p.post_id IN (${marks})
      OR json_extract(p.payload,'$.origin.sourcePostId') IN (${marks})) ORDER BY p.seq DESC`, post.targetId, postKey, ...ids, ...ids);
    return candidates.find(p => correctionBasis(post, p, explicitPostId) !== null) ?? null;
  }
  hasPostVersion(key: string): boolean { return !!this.db.prepare('SELECT 1 FROM post_versions WHERE key=?').get(key); }
  latestVersions(targetId: string, query: SourceQuery): readonly PostVersion[] { return this.latestPosts(targetId, query); }
  versions(targetId: string): readonly PostVersion[] { return this.rows('SELECT payload FROM post_versions WHERE target_id=? ORDER BY seq', targetId); }
  private latestPosts(targetId: string, query: SourceQuery): PostVersion[] {
    return this.rows(`SELECT p.payload FROM post_versions p WHERE p.target_id=? AND p.published_ms>=? AND p.published_ms<?
      AND NOT EXISTS(SELECT 1 FROM post_versions n WHERE n.target_id=p.target_id AND n.post_id=p.post_id AND n.seq>p.seq)
      ORDER BY p.published_ms,p.post_id`, targetId, Date.parse(query.from), Date.parse(query.to));
  }
  listPosts(targetId: string, window: DigestWindow): readonly AnalyzedPost[] {
    const posts = new Map<string, AnalyzedPost>();
    for (const item of this.rows<AnalyzedPost>('SELECT payload FROM legacy_posts WHERE target_id=?', targetId)) {
      if (Date.parse(item.post.publishedAt) >= Date.parse(window.from) && Date.parse(item.post.publishedAt) < Date.parse(window.to)) posts.set(item.post.id, item);
    }
    for (const post of this.latestPosts(targetId, window)) {
      posts.delete(post.id);
      const result = this.analysisResult(post.key);
      if (result && !post.deleted) posts.set(post.id, { post, analysis: result.analysis });
    }
    return [...posts.values()];
  }
  analysisJobs(targetId: string): readonly AnalysisJob[] { return this.rows('SELECT payload FROM analysis_jobs WHERE target_id=? ORDER BY seq', targetId); }
  pendingAnalysisJobs(targetId: string, now: string, limit: number): readonly AnalysisJob[] {
    this.limit(limit); if (!isInstant(now)) throw new Error('Invalid queue time.');
    return this.rows("SELECT payload FROM analysis_jobs WHERE target_id=? AND state IN ('pending','retry_wait') AND (next_ms IS NULL OR next_ms<=?) ORDER BY seq LIMIT ?", targetId, Date.parse(now), limit);
  }
  queueAnalysis(job: AnalysisJob): AnalysisJob {
    return this.write(() => {
      validateReanalysis(job, this.postVersion(job.postKey));
      this.db.prepare('INSERT INTO analysis_jobs(id,post_key,target_id,state,revision,next_ms,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(job.id, job.postKey, job.targetId, job.state, job.revision, null, pack(job));
      return this.one<AnalysisJob>('SELECT payload FROM analysis_jobs WHERE id=?', job.id)!;
    });
  }
  claimAnalysis(id: string, now: string): AnalysisJob | null {
    if (!isInstant(now)) throw new Error('Invalid claim time.');
    return this.write(() => {
      const job = this.one<AnalysisJob>('SELECT payload FROM analysis_jobs WHERE id=?', id);
      if (!job || (job.state !== 'pending' && job.state !== 'retry_wait') || (job.nextAttemptAt !== null && Date.parse(job.nextAttemptAt) > Date.parse(now))) return null;
      const claimed = { ...job, state: transitionJob(job.state, 'processing'), revision: job.revision + 1, attempts: job.attempts + 1, nextAttemptAt: null };
      this.saveJob(claimed);
      this.db.prepare('UPDATE analysis_jobs SET claimed_by=? WHERE id=?').run(this.runtime.workerId(), id);
      return claimed;
    });
  }
  private saveJob(job: AnalysisJob): void {
    this.db.prepare('UPDATE analysis_jobs SET state=?,revision=?,next_ms=?,payload=? WHERE id=?')
      .run(job.state, job.revision, job.nextAttemptAt === null ? null : Date.parse(job.nextAttemptAt), pack(job), job.id);
  }
  failAnalysis(id: string, expectedRevision: number, nextAttemptAt: string | null): void {
    this.write(() => {
      const job = this.one<AnalysisJob>('SELECT payload FROM analysis_jobs WHERE id=?', id);
      if (!job || (nextAttemptAt !== null && !isInstant(nextAttemptAt))) throw new Error('Invalid job/retry time.');
      requireRevision(job.revision, expectedRevision);
      this.assertClaim('analysis_jobs', id);
      this.saveJob({ ...job, state: transitionJob(job.state, nextAttemptAt === null ? 'needs_attention' : 'retry_wait'), revision: job.revision + 1, nextAttemptAt });
    });
  }
  commitAnalysis(commit: AnalysisCommit): void {
    this.write(() => {
      const job = this.one<AnalysisJob>('SELECT payload FROM analysis_jobs WHERE id=?', commit.jobId);
      if (!job) throw new Error('Unknown analysis job.');
      requireRevision(job.revision, commit.expectedRevision);
      this.assertClaim('analysis_jobs', job.id);
      const state = transitionJob(job.state, 'completed'), result = commit.result;
      const post = this.one<PostVersion>('SELECT payload FROM post_versions WHERE key=?', job.postKey)!;
      if (result.jobId !== job.id || result.postKey !== job.postKey || result.analyzerVersion !== job.analyzerVersion
        || result.promptVersion !== job.promptVersion || !isInstant(result.completedAt)) throw new Error('Analysis identity mismatch.');
      validateAnalysis(post, result.analysis);
      const semantic = result.analysis as Partial<SemanticAnalysis>;
      if (Object.hasOwn(semantic, 'correctionLink'))
        validateCorrectionLink(post, result.analysis, this.previousPostVersion(post.key, semantic.resetDetails?.previousPostId ?? null));
      this.db.prepare('INSERT INTO analysis_results(job_id,post_key,payload) VALUES(?,?,?)').run(job.id, job.postKey, pack(result));
      for (const event of commit.events) {
        if ((event.supersedesPostKey ?? null) !== (semantic.correctionLink?.postKey ?? null)) throw new Error('Invalid correction event link.');
        if (event.jobId !== job.id || event.targetId !== job.targetId || event.postKey !== job.postKey
          || event.id !== stableId('event', job.postKey, event.ruleId, event.ruleVersion)) throw new Error('Rule event identity mismatch.');
        this.db.prepare('INSERT INTO rule_events(id,job_id,target_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING')
          .run(event.id, job.id, job.targetId, pack(event));
      }
      for (const message of commit.notifications) {
        if ((message.supersedesPostKey ?? null) !== (semantic.correctionLink?.postKey ?? null)) throw new Error('Invalid correction notification link.');
        if (!job.emitNotifications || message.targetId !== job.targetId || !commit.events.some(e => e.id === message.originId)) throw new Error('Invalid notification origin or replay.');
        const old = this.one<Notification>('SELECT payload FROM notifications WHERE id=?', message.id);
        if (old && old.originId !== message.originId) throw new Error('Notification identity collision.');
        this.enqueueRaw(message);
      }
      this.saveJob({ ...job, state, revision: job.revision + 1 });
    });
  }
  analysisResult(postKey: string): AnalysisResult | null { return this.one('SELECT payload FROM analysis_results WHERE post_key=? ORDER BY seq DESC LIMIT 1', postKey); }
  analysisResults(postKey: string): readonly AnalysisResult[] { return this.rows('SELECT payload FROM analysis_results WHERE post_key=? ORDER BY seq', postKey); }
  ruleEvents(): readonly RuleEvent[] { return this.rows('SELECT payload FROM rule_events ORDER BY seq'); }
  createReportWithNotification(report: DigestReport, notification: Notification | null): boolean {
    return this.write(() => {
      if (this.db.prepare('SELECT 1 FROM digest_reports WHERE id=?').get(report.id)) return false;
      if (report.id !== stableId('report', report.targetId, report.day, String(report.revision)) || !Number.isInteger(report.revision)
        || report.revision < 1 || !this.isCovered(report.targetId, report)) throw new Error('Invalid report identity or coverage.');
      const previous = this.db.prepare('SELECT MAX(revision) revision FROM digest_reports WHERE target_id=? AND day=?').get(report.targetId, report.day)!;
      if (report.revision !== Number(previous['revision'] ?? 0) + 1) throw new RevisionConflictError();
      const keys = new Set(report.postKeys), required = this.latestPosts(report.targetId, report).filter(p => !p.deleted);
      if (keys.size !== report.postKeys.length || required.length !== keys.size || required.some(p => !keys.has(p.key) || !this.analysisResult(p.key))) throw new Error('Incomplete report source set.');
      if ((report.state !== 'ready' && report.state !== 'empty') || (report.state === 'empty') !== (keys.size === 0)
        || (report.state === 'empty') !== (notification === null)) throw new Error('Invalid report state.');
      if (notification && (notification.originId !== report.id || notification.targetId !== report.targetId
        || this.db.prepare('SELECT 1 FROM notifications WHERE id=?').get(notification.id))) throw new Error('Invalid report notification.');
      this.db.prepare('INSERT INTO digest_reports(id,target_id,day,revision,payload) VALUES(?,?,?,?,?)')
        .run(report.id, report.targetId, report.day, report.revision, pack(report));
      if (notification) this.enqueueRaw(notification);
      return true;
    });
  }
  reports(targetId: string): readonly DigestReport[] { return this.rows('SELECT payload FROM digest_reports WHERE target_id=? ORDER BY day,revision', targetId); }
  private enqueueRaw(notification: Notification): boolean {
    return Number(this.db.prepare("INSERT INTO notifications(id,state,payload,result) VALUES(?,'pending',?,NULL) ON CONFLICT(id) DO NOTHING")
      .run(notification.id, pack(notification)).changes) === 1;
  }
  enqueue(notification: Notification): boolean { return this.write(() => this.enqueueRaw(notification)); }
  private entries(sql: string, ...args: SQLInputValue[]): OutboxEntry[] {
    return this.db.prepare(sql).all(...args).map(r => ({ notification: JSON.parse(String(r['payload'])) as Notification,
      state: r['state'] as OutboxEntry['state'], result: r['result'] === null ? null : JSON.parse(String(r['result'])) as DeliveryResult,
      ...(r['next_delivery_ms'] === null ? {} : { nextAttemptAt: new Date(Number(r['next_delivery_ms'])).toISOString() }) }));
  }
  outbox(): readonly OutboxEntry[] { return this.entries('SELECT * FROM notifications ORDER BY seq'); }
  private limit(limit: number): void { if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid page limit.'); }
  pendingNotifications(limit: number, now?: string): readonly OutboxEntry[] {
    this.limit(limit); if (now !== undefined && !isInstant(now)) throw new Error('Invalid delivery time.');
    return this.entries("SELECT * FROM notifications WHERE state='pending' OR (state='retry_wait' AND next_delivery_ms<=?) ORDER BY (CASE WHEN json_extract(payload,'$.kind') IN ('reset','correction') THEN 0 ELSE 1 END),seq LIMIT ?", now === undefined ? -1 : Date.parse(now), limit);
  }
  deliveryRecord(id: string): DeliveryRecord | null {
    const row = this.db.prepare(`SELECT n.*, a.payload AS attempt_payload FROM notifications n
      LEFT JOIN delivery_attempts a ON a.notification_id=n.id AND a.number=(SELECT MAX(number) FROM delivery_attempts WHERE notification_id=n.id)
      WHERE n.id=?`).get(id);
    if (!row) return null;
    return { entry: { notification: JSON.parse(String(row['payload'])) as Notification, state: row['state'] as OutboxEntry['state'],
      result: row['result'] === null ? null : JSON.parse(String(row['result'])) as DeliveryResult,
      ...(row['next_delivery_ms'] === null ? {} : { nextAttemptAt: new Date(Number(row['next_delivery_ms'])).toISOString() }) },
      revision: Number(row['revision']), attempt: row['attempt_payload'] === null ? null : JSON.parse(String(row['attempt_payload'])) as DeliveryAttempt };
  }
  resolveDelivery(command: DeliveryResolution): DeliveryRecord {
    return this.write(() => {
      const record = this.deliveryRecord(command.notificationId);
      if (!record) throw new Error('Unknown notification.');
      const state = resolvedDeliveryState(record, command);
      const result = state === 'pending' ? null : command.receipt?.providerId
        ? { status: 'accepted' as const, providerId: command.receipt.providerId } : record.entry.result;
      const changed = this.db.prepare('UPDATE notifications SET state=?,result=?,revision=revision+1,next_delivery_ms=NULL WHERE id=? AND revision=?')
        .run(state, result === null ? null : pack(result), command.notificationId, command.expectedRevision);
      if (Number(changed.changes) !== 1) throw new RevisionConflictError();
      const audit: MailAudit = { ...command, kind: 'mail_resolution', resultingState: state };
      this.db.prepare('INSERT INTO audit_events(payload) VALUES(?)').run(pack(audit));
      return this.deliveryRecord(command.notificationId)!;
    });
  }
  mailAudits(id: string): readonly MailAudit[] {
    return this.rows("SELECT payload FROM audit_events WHERE json_extract(payload,'$.kind')='mail_resolution' AND json_extract(payload,'$.notificationId')=? ORDER BY seq", id);
  }
  claimDelivery(id: string, now: string, proposedBinding?: DeliveryBinding): DeliveryClaim | null {
    if (!isInstant(now)) throw new Error('Invalid delivery time.');
    return this.write(() => {
      const entry = this.entries('SELECT * FROM notifications WHERE id=?', id)[0];
      if (!entry || (entry.state !== 'pending' && !(entry.state === 'retry_wait' && entry.nextAttemptAt !== undefined
        && Date.parse(entry.nextAttemptAt) <= Date.parse(now)))) return null;
      const row = this.db.prepare('SELECT MAX(number) number FROM delivery_attempts WHERE notification_id=?').get(id)!;
      const number = Number(row['number'] ?? 0) + 1, attemptId = stableId('attempt', id, String(number));
      const previous = this.deliveryRecord(id)!;
      const binding = previous.attempt ? previous.attempt.binding : proposedBinding;
      if (binding) { validateBinding(binding); if (number > binding.maxAttempts) return null; }
      if (previous.attempt && !binding && proposedBinding) throw new Error('Legacy delivery has no saved mail identity.');
      const savedBinding = binding ? { binding: structuredClone(binding) } : {};
      const attempt: DeliveryAttempt = { id: attemptId, notificationId: id, number, startedAt: now, finishedAt: null, result: null, ...savedBinding };
      this.db.prepare('INSERT INTO delivery_attempts(id,notification_id,number,payload,claimed_by) VALUES(?,?,?,?,?)').run(attemptId, id, number, pack(attempt), this.runtime.workerId());
      this.db.prepare('UPDATE notifications SET state=?,revision=revision+1,next_delivery_ms=NULL WHERE id=?').run(transitionDelivery(entry.state, 'sending'), id);
      return { attemptId, notification: entry.notification, ...savedBinding };
    });
  }
  private assertClaim(table: 'analysis_jobs' | 'delivery_attempts', id: string): void {
    if (this.db.prepare(`SELECT claimed_by FROM ${table} WHERE id=?`).get(id)?.['claimed_by'] !== this.runtime.workerId())
      throw new Error('Work was claimed by another worker; reconciliation is required.');
  }
  private finishRaw(attempt: DeliveryAttempt, result: DeliveryResult, now: string): void {
    const row = this.db.prepare('SELECT state FROM notifications WHERE id=?').get(attempt.notificationId)!;
    if (attempt.result !== null || !isInstant(now)) throw new Error('Invalid delivery attempt.');
    const outcome = deliveryOutcome(attempt, result, now);
    const state = transitionDelivery(row['state'] as OutboxEntry['state'], outcome.state);
    this.db.prepare('UPDATE delivery_attempts SET payload=? WHERE id=?').run(pack({ ...attempt, finishedAt: now, result }), attempt.id);
    this.db.prepare('UPDATE notifications SET state=?,result=?,revision=revision+1,next_delivery_ms=? WHERE id=?')
      .run(state, pack(result), outcome.nextAttemptAt ? Date.parse(outcome.nextAttemptAt) : null, attempt.notificationId);
  }
  finishDelivery(attemptId: string, result: DeliveryResult, now: string): void {
    this.write(() => {
      const attempt = this.one<DeliveryAttempt>('SELECT payload FROM delivery_attempts WHERE id=?', attemptId);
      if (!attempt) throw new Error('Unknown delivery attempt.'); this.assertClaim('delivery_attempts', attempt.id); this.finishRaw(attempt, result, now);
    });
  }
  deliveryAttempts(): readonly DeliveryAttempt[] { return this.rows('SELECT payload FROM delivery_attempts ORDER BY seq'); }
  claim(id: string): Notification | null { return this.claimDelivery(id, this.runtime.now())?.notification ?? null; }
  finish(id: string, result: DeliveryResult): void {
    this.write(() => {
      const attempt = this.one<DeliveryAttempt>("SELECT payload FROM delivery_attempts WHERE notification_id=? AND json_extract(payload,'$.result') IS NULL ORDER BY seq DESC LIMIT 1", id);
      if (!attempt) throw new Error('Notification was not claimed.'); this.assertClaim('delivery_attempts', attempt.id); this.finishRaw(attempt, result, this.runtime.now());
    });
  }
  recoverInFlight(): number {
    return this.write(() => {
      let count = 0;
      for (const attempt of this.rows<DeliveryAttempt>("SELECT a.payload FROM delivery_attempts a JOIN notifications n ON n.id=a.notification_id WHERE n.state='sending' AND json_extract(a.payload,'$.result') IS NULL")) {
        this.finishRaw(attempt, { status: 'unknown', reason: 'Interrupted delivery; manual verification required.' }, this.runtime.now()); count++;
      }
      return count;
    });
  }
  recoverAbandonedWork(expectedRevision: number): { analysisJobs: number; notifications: number } {
    return this.write(() => {
      this.runtime.assertOwned(expectedRevision);
      let analysisJobs = 0, notifications = 0;
      for (const job of this.rows<AnalysisJob>("SELECT payload FROM analysis_jobs WHERE state='processing' AND (claimed_by IS NULL OR claimed_by<>?)", this.runtime.workerId())) {
        this.saveJob({ ...job, state: 'needs_attention', revision: job.revision + 1 }); analysisJobs++;
      }
      for (const attempt of this.rows<DeliveryAttempt>("SELECT a.payload FROM delivery_attempts a JOIN notifications n ON n.id=a.notification_id WHERE n.state='sending' AND json_extract(a.payload,'$.result') IS NULL AND (a.claimed_by IS NULL OR a.claimed_by<>?)", this.runtime.workerId())) {
        this.finishRaw(attempt, { status: 'unknown', reason: 'Interrupted delivery; manual verification required.' }, this.runtime.now()); notifications++;
      }
      this.runtime.audit('recover_work', expectedRevision);
      return { analysisJobs, notifications };
    });
  }
  commitPoll(commit: PollCommit): void {
    this.write(() => {
      requireRevision(this.checkpoint(commit.targetId).revision, commit.expectedRevision);
      if (!this.target(commit.targetId)) throw new Error('Legacy commit requires a registered target.');
      for (const item of commit.posts) {
        if (item.post.targetId !== commit.targetId) throw new Error('Target mismatch.');
        this.db.prepare('INSERT INTO legacy_posts VALUES(?,?,?) ON CONFLICT(target_id,post_id) DO NOTHING').run(commit.targetId, item.post.id, pack(item));
      }
      for (const notification of commit.notifications) { if (notification.targetId !== commit.targetId) throw new Error('Target mismatch.'); this.enqueueRaw(notification); }
      const updated = this.db.prepare('UPDATE checkpoints SET revision=revision+1,cursor=?,observed_at=? WHERE target_id=? AND revision=?')
        .run(commit.cursor, commit.observedAt, commit.targetId, commit.expectedRevision);
      if (Number(updated.changes) !== 1) throw new RevisionConflictError();
    });
  }
}
