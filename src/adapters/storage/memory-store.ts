import type { AnalysisCommit, IngestionCommit, PollCommit, WatchStore } from '../../domain/ports.js';
import type { AnalysisJob, AnalysisResult, AnalyzedPost, Checkpoint, Coverage, DeliveryAttempt, DeliveryClaim, DeliveryResult, DigestReport, DigestWindow, Notification, OutboxEntry, PostVersion, RuleEvent, SourceQuery, TargetIdentity } from '../../domain/model.js';
import { RevisionConflictError } from '../../domain/errors.js';
import { isInstant } from '../../domain/time.js';
import { stableId } from '../../domain/identifiers.js';
import { covers } from '../../domain/policies/coverage.js';
import { requireRevision, transitionJob, transitionDelivery } from '../../domain/policies/state.js';
import { validateAnalysis, validatePost } from '../../domain/validation.js';

const key = (targetId: string, postId: string): string => JSON.stringify([targetId, postId]);
/** Demo/reference implementation; every returned object is detached from internal state. */
export class MemoryStore implements WatchStore {
  readonly durability = 'memory';
  private checkpoints = new Map<string, Checkpoint>();
  private posts = new Map<string, AnalyzedPost>();
  private identities = new Map<string, TargetIdentity>();
  private ranges = new Map<string, Coverage>();
  private raw = new Map<string, PostVersion>();
  private jobs = new Map<string, AnalysisJob>();
  private results = new Map<string, AnalysisResult>();
  private events = new Map<string, RuleEvent>();
  private reportData = new Map<string, DigestReport>();
  private attempts = new Map<string, DeliveryAttempt>();
  private messages = new Map<string, OutboxEntry>();

  checkpoint(targetId: string): Checkpoint {
    return structuredClone(this.checkpoints.get(targetId) ?? { revision: 0, cursor: null, observedAt: null });
  }
  hasPost(targetId: string, postId: string): boolean { return this.posts.has(key(targetId, postId)) || [...this.raw.values()].some(p => p.targetId === targetId && p.id === postId); }
  commitPoll(commit: PollCommit): void {
    if (this.checkpoint(commit.targetId).revision !== commit.expectedRevision) throw new RevisionConflictError();
    if (commit.posts.some(item => item.post.targetId !== commit.targetId)
      || commit.notifications.some(item => item.targetId !== commit.targetId)) throw new Error('Target mismatch.');
    // Prepare a complete copy before publishing any mutation: all-or-nothing semantics.
    const posts = structuredClone(this.posts);
    const messages = structuredClone(this.messages);
    const checkpoints = structuredClone(this.checkpoints);
    for (const item of commit.posts) {
      const id = key(commit.targetId, item.post.id);
      if (!posts.has(id)) posts.set(id, structuredClone(item));
    }
    for (const notification of commit.notifications) {
      if (!messages.has(notification.id)) messages.set(notification.id,
        { notification: structuredClone(notification), state: 'pending', result: null });
    }
    checkpoints.set(commit.targetId, { revision: commit.expectedRevision + 1,
      cursor: commit.cursor, observedAt: commit.observedAt });
    this.posts = posts;
    this.messages = messages;
    this.checkpoints = checkpoints;
  }
  listPosts(targetId: string, window: DigestWindow): readonly AnalyzedPost[] {
    const latest = new Map<string, AnalyzedPost>();
    for (const item of this.posts.values()) if (item.post.targetId === targetId) latest.set(item.post.id, item);
    for (const post of this.raw.values()) {
      if (post.targetId !== targetId) continue;
      latest.delete(post.id); // An unanalysed new version must not expose an old result.
      const result = this.analysisResult(post.key);
      if (result && !post.deleted) latest.set(post.id, { post, analysis: result.analysis });
    }
    return structuredClone([...latest.values()].filter(item => Date.parse(item.post.publishedAt) >= Date.parse(window.from)
      && Date.parse(item.post.publishedAt) < Date.parse(window.to))
      .sort((a, b) => Date.parse(a.post.publishedAt) - Date.parse(b.post.publishedAt) || a.post.id.localeCompare(b.post.id)));
  }
  enqueue(notification: Notification): boolean {
    if (this.messages.has(notification.id)) return false;
    this.messages.set(notification.id, { notification: structuredClone(notification), state: 'pending', result: null });
    return true;
  }
  outbox(): readonly OutboxEntry[] { return structuredClone([...this.messages.values()]); }
  claim(id: string): Notification | null {
    return this.claimDelivery(id, new Date(0).toISOString())?.notification ?? null;
  }
  finish(id: string, result: DeliveryResult): void {
    const attempt = [...this.attempts.values()].find(a => a.notificationId === id && a.result === null);
    if (!attempt) throw new Error('Notification was not claimed.');
    this.finishDelivery(attempt.id, result, attempt.startedAt);
  }
  recoverInFlight(): number {
    let count = 0;
    for (const entry of this.messages.values()) {
      if (entry.state !== 'sending') continue;
      this.finish(entry.notification.id, { status: 'unknown', reason: 'Interrupted delivery; manual verification required.' });
      count++;
    }
    return count;
  }
  pendingNotifications(limit: number): readonly OutboxEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid page limit.');
    const priority = (entry: OutboxEntry): number => ['reset', 'correction'].includes(entry.notification.kind) ? 0 : 1;
    return this.outbox().filter(entry => entry.state === 'pending').sort((a, b) => priority(a) - priority(b)).slice(0, limit);
  }
  pendingAnalysisJobs(targetId: string, now: string, limit: number): readonly AnalysisJob[] {
    if (!isInstant(now) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid queue query.');
    return this.analysisJobs(targetId).filter(job => (job.state === 'pending' || job.state === 'retry_wait')
      && (job.nextAttemptAt === null || Date.parse(job.nextAttemptAt) <= Date.parse(now))).slice(0, limit);
  }
  registerTarget(target: TargetIdentity): TargetIdentity {
    const old = this.identities.get(target.id);
    if (old) {
      if (old.authorId !== target.authorId || old.provider !== target.provider) throw new Error('Target identity changed.');
      return structuredClone(old);
    }
    if (!target.authorId || !isInstant(target.monitorStartedAt)) throw new Error('Invalid target identity.');
    this.identities.set(target.id, structuredClone(target));
    return structuredClone(target);
  }
  target(id: string): TargetIdentity | null { return structuredClone(this.identities.get(id) ?? null); }
  commitIngestion(commit: IngestionCommit): void {
    requireRevision(this.checkpoint(commit.targetId).revision, commit.expectedRevision);
    const target = this.identities.get(commit.targetId), coverage = commit.coverage;
    const previousTime = this.checkpoint(commit.targetId).observedAt;
    if (previousTime !== null && Date.parse(commit.observedAt) < Date.parse(previousTime)) throw new Error('Checkpoint cannot move backward.');
    if (!target || coverage.targetId !== target.id || coverage.status !== 'complete' || coverage.reason !== null
      || !isInstant(coverage.from) || !isInstant(coverage.to)
      || Date.parse(coverage.from) >= Date.parse(coverage.to) || coverage.to !== commit.observedAt) throw new Error('Invalid complete coverage.');
    const raw = structuredClone(this.raw), jobs = structuredClone(this.jobs), ranges = structuredClone(this.ranges);
    for (const post of commit.posts) {
      validatePost(post, target);
      const expectedKey = stableId('post', target.provider, target.authorId, post.id, post.sourceVersion);
      if (post.targetId !== target.id || post.provider !== target.provider || post.authorId !== target.authorId || post.key !== expectedKey
        || !/^[a-f0-9]{64}$/.test(post.contentHash) || !isInstant(post.discoveredAt)) throw new Error('Invalid post version.');
      const old = raw.get(post.key);
      if (old && (old.contentHash !== post.contentHash || old.text !== post.text || old.publishedAt !== post.publishedAt)) throw new Error('Post version is immutable.');
      if (!old) raw.set(post.key, structuredClone(post));
    }
    for (const job of commit.jobs) {
      if (!raw.has(job.postKey) || raw.get(job.postKey)!.targetId !== target.id || job.targetId !== target.id
        || job.id !== stableId('analysis', job.postKey, job.analyzerVersion, job.promptVersion)
        || job.state !== 'pending' || job.revision !== 0 || job.attempts !== 0 || job.nextAttemptAt !== null) throw new Error('Invalid analysis job.');
      if (!jobs.has(job.id)) jobs.set(job.id, structuredClone(job));
    }
    // Every new post needs an analysis job in the same transaction.
    for (const post of commit.posts) if (![...jobs.values()].some(j => j.postKey === post.key)) throw new Error('Missing analysis job.');
    const oldRange = ranges.get(coverage.id);
    if (oldRange && JSON.stringify(oldRange) !== JSON.stringify(coverage)) throw new Error('Coverage identity collision.');
    ranges.set(coverage.id, structuredClone(coverage));
    this.raw = raw; this.jobs = jobs; this.ranges = ranges;
    this.checkpoints.set(target.id, { revision: commit.expectedRevision + 1, cursor: commit.cursor, observedAt: commit.observedAt });
  }
  recordCoverageGap(gap: Coverage, expectedRevision: number): void {
    requireRevision(this.checkpoint(gap.targetId).revision, expectedRevision);
    if (!this.identities.has(gap.targetId) || gap.status !== 'gap' || !gap.reason?.trim()
      || !isInstant(gap.from) || !isInstant(gap.to)
      || Date.parse(gap.from) >= Date.parse(gap.to)) throw new Error('Invalid coverage gap.');
    const old = this.ranges.get(gap.id);
    if (old && JSON.stringify(old) !== JSON.stringify(gap)) throw new Error('Coverage identity collision.');
    this.ranges.set(gap.id, structuredClone(gap));
  }
  coverage(targetId: string): readonly Coverage[] { return structuredClone([...this.ranges.values()].filter(r => r.targetId === targetId)); }
  isCovered(targetId: string, query: SourceQuery): boolean { return covers(this.coverage(targetId), targetId, query); }
  postVersion(key: string): PostVersion | null { return structuredClone(this.raw.get(key) ?? null); }
  hasPostVersion(key: string): boolean { return this.raw.has(key); }
  latestVersions(targetId: string, query: SourceQuery): readonly PostVersion[] {
    const latest = new Map<string, PostVersion>();
    for (const post of this.raw.values()) if (post.targetId === targetId) latest.set(post.id, post);
    return structuredClone([...latest.values()].filter(p => Date.parse(p.publishedAt) >= Date.parse(query.from) && Date.parse(p.publishedAt) < Date.parse(query.to)));
  }
  versions(targetId: string): readonly PostVersion[] { return structuredClone([...this.raw.values()].filter(p => p.targetId === targetId)); }
  analysisJobs(targetId: string): readonly AnalysisJob[] { return structuredClone([...this.jobs.values()].filter(j => j.targetId === targetId)); }
  claimAnalysis(id: string, now: string): AnalysisJob | null {
    if (!isInstant(now)) throw new Error('Invalid claim time.');
    const job = this.jobs.get(id);
    if (!job || (job.state !== 'pending' && job.state !== 'retry_wait')
      || (job.nextAttemptAt !== null && Date.parse(job.nextAttemptAt) > Date.parse(now))) return null;
    const claimed = { ...job, state: transitionJob(job.state, 'processing'), revision: job.revision + 1, attempts: job.attempts + 1, nextAttemptAt: null };
    this.jobs.set(id, claimed); return structuredClone(claimed);
  }
  failAnalysis(id: string, expectedRevision: number, nextAttemptAt: string | null): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown job.');
    requireRevision(job.revision, expectedRevision);
    if (nextAttemptAt !== null && !isInstant(nextAttemptAt)) throw new Error('Invalid retry time.');
    this.jobs.set(id, { ...job, state: transitionJob(job.state, nextAttemptAt === null ? 'needs_attention' : 'retry_wait'),
      revision: job.revision + 1, nextAttemptAt });
  }
  commitAnalysis(commit: AnalysisCommit): void {
    const job = this.jobs.get(commit.jobId);
    if (!job) throw new Error('Unknown job.');
    requireRevision(job.revision, commit.expectedRevision);
    const nextState = transitionJob(job.state, 'completed'), result = commit.result;
    const post = this.raw.get(job.postKey)!;
    if (result.jobId !== job.id || result.postKey !== job.postKey || result.analyzerVersion !== job.analyzerVersion
      || result.promptVersion !== job.promptVersion || !isInstant(result.completedAt)) throw new Error('Analysis identity mismatch.');
    validateAnalysis(post, result.analysis);
    const savedResult = structuredClone(result);
    const events = structuredClone(this.events), messages = structuredClone(this.messages);
    for (const event of commit.events) {
      if (event.jobId !== job.id || event.targetId !== job.targetId || event.postKey !== job.postKey
        || event.id !== stableId('event', job.postKey, event.ruleId, event.ruleVersion)) throw new Error('Rule event identity mismatch.');
      if (!events.has(event.id)) events.set(event.id, structuredClone(event));
    }
    for (const message of commit.notifications) {
      if (!job.emitNotifications || message.targetId !== job.targetId || !commit.events.some(e => e.id === message.originId))
        throw new Error('Invalid notification origin or replay.');
      if (messages.has(message.id) && messages.get(message.id)!.notification.originId !== message.originId) throw new Error('Notification identity collision.');
      if (!messages.has(message.id)) messages.set(message.id, { notification: structuredClone(message), state: 'pending', result: null });
    }
    this.events = events; this.messages = messages;
    this.results.set(job.id, savedResult);
    this.jobs.set(job.id, { ...job, state: nextState, revision: job.revision + 1 });
  }
  analysisResult(postKey: string): AnalysisResult | null { return this.analysisResults(postKey).at(-1) ?? null; }
  analysisResults(postKey: string): readonly AnalysisResult[] { return structuredClone([...this.results.values()].filter(result => result.postKey === postKey)); }
  ruleEvents(): readonly RuleEvent[] { return structuredClone([...this.events.values()]); }
  createReportWithNotification(report: DigestReport, notification: Notification | null): boolean {
    if (this.reportData.has(report.id)) return false;
    if (report.id !== stableId('report', report.targetId, report.day, String(report.revision))
      || !Number.isInteger(report.revision) || report.revision < 1 || !this.isCovered(report.targetId, report)) throw new Error('Invalid report identity or coverage.');
    const previous = [...this.reportData.values()].filter(r => r.targetId === report.targetId && r.day === report.day);
    if (report.revision !== Math.max(0, ...previous.map(r => r.revision)) + 1) throw new RevisionConflictError();
    const unique = new Set(report.postKeys);
    const latest = new Map<string, PostVersion>();
    for (const post of this.versions(report.targetId)) latest.set(post.id, post);
    const required = [...latest.values()].filter(p => !p.deleted && Date.parse(p.publishedAt) >= Date.parse(report.from) && Date.parse(p.publishedAt) < Date.parse(report.to));
    if (unique.size !== report.postKeys.length || required.length !== unique.size
      || required.some(p => !unique.has(p.key) || !this.analysisResult(p.key))) throw new Error('Incomplete report source set.');
    if ((report.state !== 'empty' && report.state !== 'ready') || (report.state === 'empty') !== (unique.size === 0)
      || (report.state === 'empty') !== (notification === null)) throw new Error('Invalid report state.');
    if (notification && (notification.originId !== report.id || notification.targetId !== report.targetId || this.messages.has(notification.id))) throw new Error('Invalid report notification.');
    const savedReport = structuredClone(report), savedMessage = notification ? structuredClone(notification) : null;
    this.reportData.set(report.id, savedReport);
    if (savedMessage) this.messages.set(savedMessage.id, { notification: savedMessage, state: 'pending', result: null });
    return true;
  }
  reports(targetId: string): readonly DigestReport[] { return structuredClone([...this.reportData.values()].filter(r => r.targetId === targetId)); }
  claimDelivery(id: string, now: string): DeliveryClaim | null {
    const entry = this.messages.get(id);
    if (!entry || entry.state !== 'pending') return null;
    if (!isInstant(now)) throw new Error('Invalid delivery time.');
    const number = [...this.attempts.values()].filter(a => a.notificationId === id).length + 1;
    const attemptId = stableId('attempt', id, String(number));
    this.attempts.set(attemptId, { id: attemptId, notificationId: id, number, startedAt: now, finishedAt: null, result: null });
    this.messages.set(id, { ...entry, state: transitionDelivery(entry.state, 'sending') });
    return { attemptId, notification: structuredClone(entry.notification) };
  }
  finishDelivery(attemptId: string, result: DeliveryResult, now: string): void {
    const attempt = this.attempts.get(attemptId), entry = attempt ? this.messages.get(attempt.notificationId) : undefined;
    if (!attempt || !entry || attempt.result !== null || !isInstant(now)) throw new Error('Invalid delivery attempt.');
    const state = transitionDelivery(entry.state, result.status === 'accepted' ? 'provider_accepted' : result.status === 'rejected' ? 'failed' : 'needs_attention');
    const copy = structuredClone(result);
    this.attempts.set(attemptId, { ...attempt, finishedAt: now, result: copy });
    this.messages.set(attempt.notificationId, { ...entry, state, result: copy });
  }
  deliveryAttempts(): readonly DeliveryAttempt[] { return structuredClone([...this.attempts.values()]); }
}
