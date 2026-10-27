import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisCommit, WatchStore } from '../../src/domain/ports.js';
import type { AnalysisJob, Post } from '../../src/domain/model.js';
import { loadConfig } from '../../src/config.js';
import { ManualClock } from '../../src/adapters/clock.js';
import { Sha256Hasher } from '../../src/adapters/hash.js';
import { FixtureSource } from '../../src/adapters/source/fixture-source.js';
import { IngestTarget } from '../../src/application/ingest-target.js';
import { ProcessAnalysis } from '../../src/application/process-analysis.js';
import { FixtureAnalyzer } from '../../src/adapters/analysis/fixture-analyzer.js';
import { ResetRule } from '../../src/application/rules/reset-rule.js';
import { DailyDigest } from '../../src/application/daily-digest.js';
import { TextDigestRenderer } from '../../src/application/digest-renderer.js';
import { stableId } from '../../src/domain/identifiers.js';
import { RevisionConflictError } from '../../src/domain/errors.js';
const config = loadConfig({}), target = config.targets[0]!;
const sample: Post = { id: 'p', targetId: target.id, text: 'Limits reset tomorrow.',
  publishedAt: '2026-01-01T12:00:00Z', url: 'https://example.invalid/post' };
const answer = { summary: 'Reset announcement', chatgptUpdates: [],
  reset: { evidence: sample.text, whenText: 'tomorrow', timeZoneText: null } };
const window = { day: '2026-01-01', from: '2025-12-31T16:00:00.000Z', to: '2026-01-01T16:00:00.000Z' };
export async function seeded(create: () => WatchStore) {
  const store = create(), clock = new ManualClock(new Date('2026-01-02T00:00:00Z')), hasher = new Sha256Hasher();
  store.registerTarget({ ...target, authorId: `fixture:${target.handle.toLowerCase()}`, enabled: true,
    monitorStartedAt: '2026-01-01T00:00:00Z', configRevision: config.revision });
  await new IngestTarget(new FixtureSource([sample]), store, clock, config, hasher).execute(target);
  return { store, clock, hasher };
}
function completion(store: WatchStore, job: AnalysisJob): AnalysisCommit {
  const event = { id: stableId('event', job.postKey, 'reset', 'v1'), jobId: job.id, postKey: job.postKey,
    targetId: job.targetId, ruleId: 'reset', ruleVersion: 'v1', createdAt: '2026-01-02T00:00:00Z' };
  assert.ok(store.versions(target.id).some(p => p.key === job.postKey));
  return { jobId: job.id, expectedRevision: job.revision, result: { jobId: job.id, postKey: job.postKey,
    analyzerVersion: job.analyzerVersion, promptVersion: job.promptVersion, completedAt: event.createdAt, analysis: answer }, events: [event],
    notifications: [{ id: stableId('notification', event.id), originId: event.id, kind: 'reset', targetId: target.id,
      recipient: config.recipient, configRevision: config.revision, subject: 'reset', text: 'reset', createdAt: event.createdAt }] };
}
/** Reuse this suite unchanged for the future SQLite implementation. */
export function watchStoreContract(name: string, create: () => WatchStore): void {
  test(`${name}: reset and correction preempt digest backlog before applying the page limit`, () => {
    const store = create();
    const message = { targetId: target.id, recipient: config.recipient, subject: 'Synthetic', text: 'Synthetic', createdAt: '2026-01-02T00:00:00Z' };
    store.enqueue({ ...message, id: 'digest-old', kind: 'digest' });
    store.enqueue({ ...message, id: 'correction', kind: 'correction' });
    store.enqueue({ ...message, id: 'reset', kind: 'reset' });
    assert.deepEqual(store.pendingNotifications(2).map(entry => entry.notification.id), ['correction','reset']);
  });
  test(`${name}: ingestion persists raw versions, coverage and jobs before analysis`, async () => {
    const { store } = await seeded(create);
    assert.equal(store.checkpoint(target.id).revision, 1);
    assert.equal(store.analysisJobs(target.id)[0]!.state, 'pending');
    assert.equal(store.versions(target.id).length, 1);
    assert.equal(store.isCovered(target.id, window), true);
    assert.equal(store.listPosts(target.id, window).length, 0);
  });
  test(`${name}: invalid ingestion and stale revisions leave no partial state`, async () => {
    const { store } = await seeded(create), snapshot = store.checkpoint(target.id);
    const version = store.versions(target.id)[0]!, job = store.analysisJobs(target.id)[0]!;
    const commit = { targetId: target.id, expectedRevision: snapshot.revision, cursor: 'invalid', observedAt: snapshot.observedAt!,
      coverage: store.coverage(target.id)[0]!, posts: [version], jobs: [{ ...job, targetId: 'wrong' }] };
    assert.throws(() => store.commitIngestion(commit));
    assert.deepEqual(store.checkpoint(target.id), snapshot);
    assert.throws(() => store.commitIngestion({ ...commit, expectedRevision: 0 }), RevisionConflictError);
    assert.equal(store.versions(target.id).length, 1);
  });
  test(`${name}: recorded gaps remain visible without moving the checkpoint`, async () => {
    const { store } = await seeded(create), before = store.checkpoint(target.id);
    const gap = { id: 'gap', targetId: target.id, status: 'gap' as const, reason: 'source history limit',
      from: '2025-01-01T00:00:00Z', to: '2025-01-02T00:00:00Z' };
    store.recordCoverageGap(gap, before.revision);
    assert.deepEqual(store.checkpoint(target.id), before);
    assert.equal(store.isCovered(target.id, gap), false);
    assert.ok(store.coverage(target.id).some(r => r.status === 'gap'));
    assert.throws(() => store.recordCoverageGap(gap, 0), RevisionConflictError);
  });
  test(`${name}: target identity and monitoring start cannot silently change`, async () => {
    const { store } = await seeded(create), original = store.target(target.id)!;
    assert.deepEqual(store.registerTarget({ ...original, monitorStartedAt: '2030-01-01T00:00:00Z' }), original);
    assert.throws(() => store.registerTarget({ ...original, authorId: 'different-person' }));
  });
  test(`${name}: analysis claim is exclusive; result/event/notification commit is atomic`, async () => {
    const { store, clock } = await seeded(create);
    const job = store.claimAnalysis(store.analysisJobs(target.id)[0]!.id, clock.now().toISOString())!;
    assert.equal(store.claimAnalysis(job.id, clock.now().toISOString()), null);
    const commit = completion(store, job);
    assert.throws(() => store.commitAnalysis({ ...commit, notifications: [{ ...commit.notifications[0]!, originId: 'wrong' }] }));
    assert.equal(store.analysisResult(job.postKey), null); assert.equal(store.ruleEvents().length, 0); assert.equal(store.outbox().length, 0);
    store.commitAnalysis(commit);
    assert.equal(store.analysisJobs(target.id)[0]!.state, 'completed'); assert.equal(store.outbox().length, 1);
    assert.throws(() => store.commitAnalysis(commit), RevisionConflictError);
  });
  test(`${name}: retry claims obey nextAttemptAt and completed jobs cannot be retried`, async () => {
    const { store, clock } = await seeded(create);
    const job = store.claimAnalysis(store.analysisJobs(target.id)[0]!.id, clock.now().toISOString())!;
    store.failAnalysis(job.id, job.revision, new Date(clock.now().getTime() + 1000).toISOString());
    assert.equal(store.claimAnalysis(job.id, clock.now().toISOString()), null);
    clock.advance(1000);
    const retried = store.claimAnalysis(job.id, clock.now().toISOString())!;
    assert.equal(retried.attempts, 2); store.commitAnalysis(completion(store, retried));
    assert.equal(store.claimAnalysis(job.id, clock.now().toISOString()), null);
  });
  test(`${name}: read snapshots do not leak mutable internal state`, async () => {
    const { store } = await seeded(create), post = store.versions(target.id)[0]!;
    Object.assign(post, { text: 'tampered' }); Object.assign(store.analysisJobs(target.id)[0]!, { state: 'completed' });
    assert.equal(store.versions(target.id)[0]!.text, sample.text);
    assert.equal(store.analysisJobs(target.id)[0]!.state, 'pending');
  });
  test(`${name}: report and notification are created once, with frozen recipients`, async () => {
    const { store, clock, hasher } = await seeded(create);
    const job = store.claimAnalysis(store.analysisJobs(target.id)[0]!.id, clock.now().toISOString())!;
    store.commitAnalysis(completion(store, job));
    const report = new DailyDigest(store, new TextDigestRenderer(), config.recipient, hasher, config.timeZone, config.revision);
    assert.equal(report.execute(target, window, clock.now().toISOString()), true);
    assert.equal(report.execute(target, window, clock.now().toISOString()), false);
    assert.equal(new DailyDigest(store, new TextDigestRenderer(), 'changed@example.invalid', hasher, config.timeZone, 'new-config')
      .execute(target, window, clock.now().toISOString()), false);
    assert.equal(store.outbox().find(e => e.notification.kind === 'digest')!.notification.recipient, config.recipient);
    const saved = store.reports(target.id)[0]!;
    assert.throws(() => store.createReportWithNotification({ ...saved, id: 'new-invalid-id' }, null));
    assert.equal(store.reports(target.id).length, 1);
  });
  test(`${name}: accepted is not delivered; interrupted attempts never auto-resend`, async () => {
    const { store, clock } = await seeded(create);
    const job = store.claimAnalysis(store.analysisJobs(target.id)[0]!.id, clock.now().toISOString())!;
    store.commitAnalysis(completion(store, job));
    const id = store.outbox()[0]!.notification.id;
    const claim = store.claimDelivery(id, clock.now().toISOString())!;
    assert.equal(store.claimDelivery(id, clock.now().toISOString()), null);
    store.finishDelivery(claim.attemptId, { status: 'accepted', providerId: 'provider-message' }, clock.now().toISOString());
    assert.equal(store.outbox()[0]!.state, 'provider_accepted'); assert.equal(store.claimDelivery(id, clock.now().toISOString()), null);
    assert.throws(() => store.finishDelivery(claim.attemptId, { status: 'unknown', reason: 'stale result' }, clock.now().toISOString()));
    const pending = { ...claim.notification, id: 'interrupted' }; store.enqueue(pending); store.claimDelivery(pending.id, clock.now().toISOString());
    assert.equal(store.recoverInFlight(), 1); assert.equal(store.claimDelivery(pending.id, clock.now().toISOString()), null);
    assert.equal(store.deliveryAttempts().filter(a => a.notificationId === pending.id)[0]!.result!.status, 'unknown');
  });
  test(`${name}: reanalysis can save a new result without replaying old notifications`, async () => {
    const { store, clock } = await seeded(create);
    const job = store.analysisJobs(target.id)[0]!;
    const replay = { ...job, id: stableId('analysis', job.postKey, 'new-model', job.promptVersion), analyzerVersion: 'new-model', emitNotifications: false };
    const checkpoint = store.checkpoint(target.id);
    store.commitIngestion({ targetId: target.id, expectedRevision: checkpoint.revision, cursor: checkpoint.cursor,
      observedAt: checkpoint.observedAt!, coverage: store.coverage(target.id)[0]!, posts: [], jobs: [replay] });
    const claimed = store.claimAnalysis(replay.id, clock.now().toISOString())!;
    const commit = completion(store, claimed);
    assert.throws(() => store.commitAnalysis(commit));
    store.commitAnalysis({ ...commit, notifications: [] });
    assert.equal(store.analysisResult(replay.postKey)!.analyzerVersion, 'new-model'); assert.equal(store.outbox().length, 0);
  });
  test(`${name}: historical startup posts contribute to digests but not instant alerts`, async () => {
    const store = create(), clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
    await new IngestTarget(new FixtureSource([sample]), store, clock, config, new Sha256Hasher()).execute(target);
    await new ProcessAnalysis(new FixtureAnalyzer(new Map([[sample.id, answer]])), store, [new ResetRule()], clock, config).execute(target);
    assert.equal(store.outbox().length, 0); assert.equal(store.ruleEvents().length, 1);
    assert.equal(store.listPosts(target.id, window).length, 1);
  });
}

export const contractFixture = { config, target, sample, answer, window };
