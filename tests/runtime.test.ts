import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { Analysis, DeliveryResult, PostBatch } from '../src/domain/model.js';
import type { ContentAnalyzer, NotificationChannel, PostSource } from '../src/domain/ports.js';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { FixtureSource } from '../src/adapters/source/fixture-source.js';
import { FixtureAnalyzer } from '../src/adapters/analysis/fixture-analyzer.js';
import { IngestTarget } from '../src/application/ingest-target.js';
import { ProcessAnalysis } from '../src/application/process-analysis.js';
import { DeliverNotifications } from '../src/application/deliver-notifications.js';
import { DueDigests } from '../src/application/due-digests.js';
import { loadConfig } from '../src/config.js';
import { deferred, flush, runtimeFixture } from './helpers/runtime.js';
import { contractFixture as f } from './contracts/watch-store.contract.js';

const message = { id: 'synthetic-mail', kind: 'reset' as const, targetId: f.target.id,
  recipient: 'reader@example.invalid', subject: 'Synthetic', text: 'Synthetic', createdAt: '2026-01-02T00:00:00Z' };

test('persistent schedules require ownership, fence revisions and preserve retry deadlines on restart', async () => {
  const s = runtimeFixture(); let reopened: SqliteStore | undefined;
  try {
    const { scheduler } = s.app(); assert.throws(() => scheduler.initialize(), /ownership/);
    const lease = s.store.runtime.acquire(60_000)!; scheduler.initialize();
    const task = s.store.schedules.tasks().find(t => t.stage === 'ingest')!;
    const claim = s.store.schedules.claim(task.id, task.revision, s.clock.now().toISOString())!;
    assert.equal(s.store.schedules.claim(task.id, task.revision, s.clock.now().toISOString()), null);
    assert.throws(() => s.store.schedules.finish(task.id, task.revision, task.dueAt, true, false, task.dueAt));
    const due = new Date(s.clock.now().getTime() + 30_000).toISOString();
    s.store.schedules.finish(task.id, claim.revision, due, true, false, task.dueAt); s.store.runtime.release(lease.revision);
    reopened = new SqliteStore(s.path, { claims: { clock: s.clock } });
    let calls = 0;
    const source: PostSource = { capability: 'simulated', fetch: async () => { calls++; return { posts: [], nextCursor: null, complete: true }; } };
    const second = s.app({ store: reopened, lease: reopened.runtime, state: reopened.schedules,
      reconcile: revision => reopened!.recoverAbandonedWork(revision), sources: new Map([['x', source]]) });
    const next = reopened.runtime.acquire(60_000)!; second.scheduler.initialize();
    second.scheduler.pulse(s.context); await second.scheduler.drain(); assert.equal(calls, 0);
    assert.equal(reopened.schedules.tasks().find(t => t.id === task.id)!.failures, 1);
    s.clock.advance(30_000); second.scheduler.pulse(s.context); await second.scheduler.drain(); assert.equal(calls, 1);
    reopened.runtime.release(next.revision);
  } finally { reopened?.close(); s.close(); }
});

test('a slow source does not block delivery, analysis or another target; overlapping pulses do not duplicate claims', async () => {
  const s = runtimeFixture({ WATCH_HANDLES: 'thsottiaux,fixture' }), slow = deferred<PostBatch>();
  let calls = 0;
  const source: PostSource = { capability: 'simulated', fetch: target => {
    calls++; return target.handle === 'thsottiaux' ? slow.promise : Promise.resolve({ posts: [], complete: true, nextCursor: 'done' });
  } };
  const { scheduler } = s.app({ sources: new Map([['x', source]]) });
  try {
    s.store.runtime.acquire(60_000); s.store.enqueue(message); scheduler.initialize(); scheduler.pulse(s.context);
    await flush(); scheduler.pulse(s.context); await flush();
    assert.equal(calls, 2); assert.equal(s.preview.list().length, 1);
    assert.equal(s.store.checkpoint('x:fixture').cursor, 'done'); assert.equal(s.store.checkpoint(f.target.id).revision, 0);
    assert.ok(s.store.schedules.tasks().some(t => t.stage === 'analysis' && t.finishedAt !== null));
    s.controller.abort(); await scheduler.drain();
    slow.resolve({ posts: [], complete: true, nextCursor: 'late' }); await flush();
    assert.equal(s.store.checkpoint(f.target.id).revision, 0);
  } finally { s.controller.abort(); await scheduler.drain(); s.close(); }
});

test('ingestion retry is bounded, persisted and exhausted without a hot loop', async () => {
  const s = runtimeFixture({ RETRY_MAX_ATTEMPTS: '2', RETRY_BASE_SECONDS: '1', RETRY_MAX_SECONDS: '2' }); let calls = 0;
  const source: PostSource = { capability: 'simulated', fetch: async () => { calls++; throw new Error('synthetic'); } };
  const { scheduler } = s.app({ sources: new Map([['x', source]]) });
  try {
    s.store.runtime.acquire(60_000); scheduler.initialize(); scheduler.pulse(s.context); await scheduler.drain();
    assert.equal(calls, 1); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 1);
    s.clock.advance(1000); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 2);
    const task = s.store.schedules.tasks().find(t => t.stage === 'ingest')!;
    assert.equal(task.state, 'needs_attention'); assert.equal(task.failures, 2);
    s.clock.advance(5000); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 2);
  } finally { s.close(); }
});

test('wall-clock jumps do not alter monotonic polling or duplicate reports', async () => {
  const s = runtimeFixture(); let calls = 0;
  const source: PostSource = { capability: 'simulated', fetch: async () => { calls++; return { posts: [], complete: true, nextCursor: null }; } };
  const { scheduler } = s.app({ sources: new Map([['x', source]]) });
  try {
    s.store.runtime.acquire(86_400_000); scheduler.initialize();
    scheduler.pulse(s.context); await scheduler.drain(); s.clock.advance(1000); scheduler.pulse(s.context); await scheduler.drain();
    assert.equal(calls, 1); assert.equal(s.store.reports(f.target.id).length, 1);
    s.clock.jumpWallClock(3 * 86_400_000); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 1);
    s.clock.jumpWallClock(-6 * 86_400_000); s.clock.advance(s.config.pollIntervalMs);
    scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 1); // Application never moves a checkpoint backwards.
    const task = s.store.schedules.tasks().find(t => t.stage === 'ingest')!; assert.equal(task.failures, 0);
    s.clock.jumpWallClock(3 * 86_400_000); s.clock.advance(s.config.pollIntervalMs);
    scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 2);
    assert.equal(s.store.reports(f.target.id).length, 1);
  } finally { s.close(); }
});

test('a full simulated day covers midnight and 08:00, with one report and no duplicate reset', async () => {
  const s = runtimeFixture();
  s.clock.jumpWallClock(-8 * 3_600_000); // Jan 2 00:00 in Shanghai.
  const fresh = { ...f.sample, id: 'fresh', publishedAt: new Date(s.clock.now().getTime() + 1000).toISOString() };
  const { scheduler } = s.app({ sources: new Map([['x', new FixtureSource([f.sample, fresh])]]),
    analyzer: new FixtureAnalyzer(new Map([[f.sample.id, f.answer], [fresh.id, f.answer]])) });
  try {
    s.store.runtime.acquire(86_400_000); scheduler.initialize();
    for (let halfHour = 0; halfHour <= 48; halfHour++) {
      for (let step = 0; step < 4; step++) { scheduler.pulse(s.context); await scheduler.drain(); s.clock.advance(1000); }
      if (halfHour === 15) assert.equal(s.store.reports(f.target.id).length, 0);
      if (halfHour === 16) assert.equal(s.store.reports(f.target.id).length, 1);
      if (halfHour < 48) s.clock.advance(30 * 60_000 - 4000);
      const lease = s.store.runtime.current()!; s.store.runtime.renew(lease.revision, 86_400_000);
    }
    assert.equal(s.store.reports(f.target.id).length, 1);
    assert.equal(s.preview.list().filter(n => n.kind === 'reset').length, 1);
    assert.equal(s.preview.list().filter(n => n.kind === 'digest').length, 1);
  } finally { s.close(); }
});

test('multi-day restart catches up complete windows oldest first within configured bounds', async () => {
  const s = runtimeFixture({ MAX_CATCH_UP_EMAILS: '2' });
  try {
    s.store.registerTarget({ ...f.target, authorId: `fixture:${f.target.handle}`, enabled: true,
      monitorStartedAt: '2026-01-01T00:00:00Z', configRevision: s.config.revision });
    await new IngestTarget(new FixtureSource([]), s.store, s.clock, s.config, s.deps.hasher).execute(f.target);
    s.clock.advance(4 * 86_400_000);
    const { scheduler } = s.app(); s.store.runtime.acquire(60_000); scheduler.initialize();
    for (let i = 0; i < 5; i++) { scheduler.pulse(s.context); await scheduler.drain(); s.clock.advance(1000); }
    assert.deepEqual(s.store.reports(f.target.id).map(r => r.day), ['2025-12-31','2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05']);
    assert.ok(s.store.reports(f.target.id).every(r => r.state === 'empty')); assert.equal(s.preview.list().length, 0);
  } finally { s.close(); }
});

test('before 08:00 an overdue older report remains due; missing coverage is not declared empty', () => {
  const s = runtimeFixture();
  try {
    s.store.registerTarget({ ...f.target, authorId: 'fixture:thsottiaux', enabled: true,
      monitorStartedAt: '2026-01-01T00:00:00Z', configRevision: s.config.revision });
    s.clock.advance(2 * 86_400_000 - 60_000);
    const windows = new DueDigests(s.store, s.clock, s.config).execute(f.target);
    assert.equal(windows.at(-1)!.day, '2026-01-02');
    assert.equal(s.store.reports(f.target.id).length, 0); assert.equal(s.store.isCovered(f.target.id, windows[0]!), false);
  } finally { s.close(); }
});

test('digest catch-up email limit applies across targets in each pulse', async () => {
  const s = runtimeFixture({ WATCH_HANDLES: 'thsottiaux,fixture', INITIAL_BACKFILL_DAYS: '7', MAX_CATCH_UP_EMAILS: '2' });
  s.clock.advance(2 * 86_400_000);
  const posts = s.config.targets.flatMap(target => [1, 2, 3].map(day => ({ ...f.sample, targetId: target.id,
    id: `${target.id}-${day}`, publishedAt: `2026-01-0${day}T12:00:00Z` })));
  const { scheduler } = s.app({ sources: new Map([['x', new FixtureSource(posts)]]),
    analyzer: new FixtureAnalyzer(new Map(posts.map(p => [p.id, { summary: 'Synthetic', chatgptUpdates: [], reset: null }]))) });
  try {
    s.store.runtime.acquire(60_000); scheduler.initialize();
    for (let i = 0; i < 8; i++) {
      const before = s.store.outbox().filter(n => n.notification.kind === 'digest').length;
      scheduler.pulse(s.context); await scheduler.drain();
      assert.ok(s.store.outbox().filter(n => n.notification.kind === 'digest').length - before <= 2);
      s.clock.advance(1000);
    }
    assert.equal(s.store.outbox().filter(n => n.notification.kind === 'digest').length, 6);
  } finally { s.close(); }
});

test('startup reconciles abandoned analysis and sending before restarting stage triggers, without resend', async () => {
  const s = runtimeFixture(); let second: SqliteStore | undefined;
  try {
    await new IngestTarget(new FixtureSource([f.sample]), s.store, s.clock, s.config, s.deps.hasher).execute(f.target);
    const first = s.store.runtime.acquire(1000)!;
    const { scheduler } = s.app(); scheduler.initialize();
    const stage = s.store.schedules.tasks().find(t => t.stage === 'analysis')!;
    s.store.schedules.claim(stage.id, stage.revision, s.clock.now().toISOString());
    s.store.claimAnalysis(s.store.analysisJobs(f.target.id)[0]!.id, s.clock.now().toISOString());
    s.store.enqueue(message); s.store.claimDelivery(message.id, s.clock.now().toISOString());
    s.clock.advance(2000);
    second = new SqliteStore(s.path, { claims: { clock: s.clock, hostId: 'fixture-host', ownerId: 'second', pid: 222, isProcessAlive: () => false } });
    const { host } = s.app({ store: second, lease: second.runtime, state: second.schedules, reconcile: rev => second!.recoverAbandonedWork(rev) });
    const run = host.run(); await flush();
    assert.equal(second.analysisJobs(f.target.id)[0]!.state, 'needs_attention');
    assert.equal(second.outbox()[0]!.state, 'needs_attention'); assert.equal(s.preview.list().length, 0);
    assert.ok(second.schedules.tasks().every(t => t.state !== 'running'));
    assert.throws(() => s.store.runtime.renew(first.revision, 1000));
    host.stop(); assert.deepEqual(await run, { exitCode: 0, reason: 'stopped' }); assert.equal(second.runtime.current(), null);
  } finally { second?.close(); s.close(); }
});

test('host renews while a call is in flight; a second host cannot start', async () => {
  const s = runtimeFixture({ RUNTIME_LEASE_SECONDS: '3' }), held = deferred<PostBatch>(); let other: SqliteStore | undefined;
  const source: PostSource = { capability: 'simulated', fetch: () => held.promise };
  const { host } = s.app({ sources: new Map([['x', source]]) });
  const run = host.run();
  try {
    await flush(); const revision = s.store.runtime.current()!.revision;
    await s.waiter.step(2000); assert.ok(s.store.runtime.current()!.revision > revision);
    other = new SqliteStore(s.path, { claims: { clock: s.clock, hostId: 'fixture-host', isProcessAlive: () => true } });
    const second = s.app({ store: other, state: other.schedules, lease: other.runtime, reconcile: rev => other!.recoverAbandonedWork(rev) });
    assert.deepEqual(await second.host.run(), { exitCode: 1, reason: 'already_running' });
    held.resolve({ posts: [], complete: true, nextCursor: null }); await flush(); host.stop();
    assert.deepEqual(await run, { exitCode: 0, reason: 'stopped' });
  } finally { host.stop(); held.resolve({ posts: [], complete: true, nextCursor: null }); await flush(); await s.waiter.step(); await run; other?.close(); s.close(); }
});

test('graceful stop stops new claims and waits for accepted delivery to be saved', async () => {
  const s = runtimeFixture(), held = deferred<DeliveryResult>(); let sends = 0;
  const channel: NotificationChannel = { capability: 'simulated', send: () => { sends++; return held.promise; } };
  s.store.enqueue(message); s.store.enqueue({ ...message, id: 'new-pending' });
  const { host } = s.app({ notifications: channel }); const run = host.run();
  try {
    await flush(); host.stop(); await flush(); assert.equal(s.store.outbox()[0]!.state, 'sending');
    held.resolve({ status: 'accepted', providerId: 'simulated' }); await flush(); await s.waiter.step();
    assert.deepEqual(await run, { exitCode: 0, reason: 'stopped' }); assert.equal(sends, 1);
    assert.deepEqual(s.store.outbox().map(n => n.state), ['provider_accepted','pending']); assert.equal(s.store.runtime.current(), null);
  } finally { held.resolve({ status: 'accepted', providerId: 'simulated' }); host.stop(); await flush(); await s.waiter.step(); await run; s.close(); }
});

test('shutdown deadline persists unknown mail, retains unclaimed work and ignores late acceptance', async () => {
  const s = runtimeFixture({ RUNTIME_SHUTDOWN_SECONDS: '1' }), held = deferred<DeliveryResult>();
  const channel: NotificationChannel = { capability: 'simulated', send: () => held.promise };
  s.store.enqueue(message); s.store.enqueue({ ...message, id: 'second' });
  const { host } = s.app({ notifications: channel }); const run = host.run();
  try {
    await flush(); host.stop(); await flush(); await s.waiter.step(1000);
    assert.deepEqual(await run, { exitCode: 2, reason: 'shutdown_timeout' });
    assert.deepEqual(s.store.outbox().map(n => n.state), ['needs_attention','pending']);
    held.resolve({ status: 'accepted', providerId: 'late' }); await flush();
    assert.equal(s.store.outbox()[0]!.state, 'needs_attention'); assert.equal(s.store.deliveryAttempts().length, 1);
    assert.equal(s.store.runtime.current(), null);
  } finally { held.resolve({ status: 'accepted', providerId: 'late' }); s.close(); }
});

test('normal stop finishes the claimed analysis but does not claim the next item in the same batch', async () => {
  const s = runtimeFixture(), held = deferred<Analysis>(); let calls = 0;
  const analyzer: ContentAnalyzer = { capability: 'simulated', analyze: () => { calls++; return held.promise; } };
  const posts = [f.sample, { ...f.sample, id: 'second-post' }];
  await new IngestTarget(new FixtureSource(posts), s.store, s.clock, s.config, s.deps.hasher).execute(f.target);
  const { host } = s.app({ analyzer }); const run = host.run();
  try {
    await flush(); host.stop(); await flush(); held.resolve(f.answer); await flush(); await s.waiter.step();
    assert.equal((await run).exitCode, 0); assert.equal(calls, 1);
    assert.deepEqual(s.store.analysisJobs(f.target.id).map(j => j.state), ['completed','pending']);
  } finally { held.resolve(f.answer); host.stop(); await flush(); await s.waiter.step(); await run; s.close(); }
});

test('source deadline leaves checkpoint intact even if the adapter resolves later', async () => {
  const s = runtimeFixture(), held = deferred<PostBatch>();
  const source: PostSource = { capability: 'simulated', fetch: () => held.promise };
  const config = { ...s.config, services: { ...s.config.services, source: { ...s.config.services.source, timeoutMs: 10 } } };
  try {
    await assert.rejects(new IngestTarget(source, s.store, s.clock, config, s.deps.hasher).execute(f.target, s.context));
    held.resolve({ posts: [f.sample], complete: true, nextCursor: 'late' }); await flush();
    assert.equal(s.store.checkpoint(f.target.id).revision, 0); assert.equal(s.store.analysisJobs(f.target.id).length, 0);
  } finally { s.close(); }
});

test('analysis cancellation saves retry state and does not commit a late model response', async () => {
  const s = runtimeFixture(), held = deferred<Analysis>();
  const analyzer: ContentAnalyzer = { capability: 'simulated', analyze: () => held.promise };
  try {
    await new IngestTarget(new FixtureSource([f.sample]), s.store, s.clock, s.config, s.deps.hasher).execute(f.target);
    const run = new ProcessAnalysis(analyzer, s.store, s.deps.rules, s.clock, s.config).execute(f.target, s.context);
    await flush(); s.controller.abort(); await assert.rejects(run);
    assert.equal(s.store.analysisJobs(f.target.id)[0]!.state, 'retry_wait');
    held.resolve(f.answer); await flush(); assert.equal(s.store.analysisResult(s.store.analysisJobs(f.target.id)[0]!.postKey), null);
  } finally { s.close(); }
});

test('mail deadline creates one unknown attempt and does not automatically retry', async () => {
  const s = runtimeFixture(), held = deferred<DeliveryResult>(); let calls = 0;
  const channel: NotificationChannel = { capability: 'simulated', send: () => { calls++; return held.promise; } };
  try {
    s.store.enqueue(message); const delivery = new DeliverNotifications(s.store, channel, s.clock);
    await delivery.execute(s.context, 10); await delivery.execute(s.context, 10);
    assert.equal(calls, 1); assert.equal(s.store.outbox()[0]!.state, 'needs_attention');
    held.resolve({ status: 'accepted', providerId: 'late' }); await flush(); assert.equal(s.store.deliveryAttempts()[0]!.result?.status, 'unknown');
  } finally { s.close(); }
});

test('a reset arriving during a digest send runs before the next queued digest', async () => {
  const s = runtimeFixture(), sent: string[] = [];
  try {
    s.store.enqueue({ ...message, id: 'digest-1', kind: 'digest' }); s.store.enqueue({ ...message, id: 'digest-2', kind: 'digest' });
    const channel: NotificationChannel = { capability: 'simulated', send: async note => {
      sent.push(note.id); if (note.id === 'digest-1') s.store.enqueue({ ...message, id: 'urgent' });
      return { status: 'accepted', providerId: 'simulated' };
    } };
    await new DeliverNotifications(s.store, channel, s.clock).execute(s.context);
    assert.deepEqual(sent, ['digest-1','urgent','digest-2']);
    const raw = new DatabaseSync(s.path);
    try {
      const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE state='pending' ORDER BY (CASE WHEN json_extract(payload,'$.kind') IN ('reset','correction') THEN 0 ELSE 1 END),seq LIMIT 1").all();
      assert.ok(JSON.stringify(plan).includes('notification_priority'));
    } finally { raw.close(); }
  } finally { s.close(); }
});

test('host fails on renewal failure and never claims further work', async () => {
  const s = runtimeFixture({ RUNTIME_LEASE_SECONDS: '3' });
  const { host } = s.app({ lease: { current: () => s.store.runtime.current(), acquire: ms => s.store.runtime.acquire(ms),
    renew: () => { throw new Error('injected renewal failure'); }, release: rev => s.store.runtime.release(rev) } });
  const run = host.run();
  try {
    await flush(); await s.waiter.step(1000); assert.deepEqual(await run, { exitCode: 1, reason: 'failed' });
  } finally { host.stop(); s.close(); }
});

test('a killed process leaves stage and mail claims; startup proves death and quarantines rather than resending', async () => {
  const s = runtimeFixture();
  try {
    const script = `import { SqliteStore } from './dist/src/adapters/storage/sqlite/store.js';
import { ManualClock } from './dist/src/adapters/clock.js';
const clock=new ManualClock(new Date('2026-01-02T00:00:00Z'));
const store=new SqliteStore(process.argv[1],{claims:{clock,hostId:'fixture-host',ownerId:'killed-child'}});
store.runtime.acquire(1000);
const task={id:'crashed-stage',stage:'delivery',targetId:null,configRevision:'fixture',revision:0,state:'idle',dueAt:clock.now().toISOString(),failures:0,startedAt:null,finishedAt:null};
store.schedules.ensure(task);store.schedules.claim(task.id,0,task.dueAt);
store.enqueue(${JSON.stringify(message)});store.claimDelivery('synthetic-mail',task.dueAt);
process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--experimental-sqlite','--input-type=module','-e',script,s.path], { windowsHide: true, timeout: 10_000 });
    assert.notEqual(child.status, 0); assert.equal(s.store.outbox()[0]!.state, 'sending');
    s.clock.advance(2000); const { host } = s.app(); const run = host.run(); await flush();
    assert.equal(s.store.outbox()[0]!.state, 'needs_attention');
    assert.equal(s.store.schedules.tasks().find(t => t.id === 'crashed-stage')!.state, 'idle');
    assert.equal(s.preview.list().length, 0); host.stop(); assert.equal((await run).exitCode, 0);
  } finally { s.close(); }
});

test('a failure saving an accepted result retains ownership and sending state for explicit recovery', async () => {
  const s = runtimeFixture(); const raw = new DatabaseSync(s.path);
  try {
    s.store.enqueue(message);
    raw.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON notifications WHEN NEW.state='provider_accepted' BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END");
    const { host } = s.app(); const run = host.run(); await flush(); host.stop();
    assert.deepEqual(await run, { exitCode: 1, reason: 'failed' });
    assert.equal(s.store.outbox()[0]!.state, 'sending'); assert.ok(s.store.runtime.current()); assert.equal(s.preview.list().length, 1);
  } finally { raw.close(); s.close(); }
});

test('restart caps a future poll deadline after a backwards clock correction', async () => {
  const s = runtimeFixture();
  try {
    const { scheduler } = s.app(); const lease = s.store.runtime.acquire(86_400_000)!;
    scheduler.initialize(); scheduler.pulse(s.context); await scheduler.drain(); s.store.runtime.release(lease.revision);
    s.clock.jumpWallClock(-3 * 86_400_000);
    const second = s.app(); const next = s.store.runtime.acquire(86_400_000)!; second.scheduler.initialize();
    second.scheduler.pulse(s.context); await second.scheduler.drain();
    const before = s.store.schedules.tasks().find(t => t.stage === 'ingest')!.revision;
    s.clock.advance(Math.max(s.config.pollIntervalMs, s.config.retry.maxDelayMs));
    second.scheduler.pulse(s.context); await second.scheduler.drain();
    assert.ok(s.store.schedules.tasks().find(t => t.stage === 'ingest')!.revision > before);
    s.store.runtime.release(next.revision);
  } finally { s.close(); }
});

test('runtime configuration bounds prevent lease/wake mismatch and unsafe concurrency', () => {
  for (const env of [{ RUNTIME_MAX_CONCURRENT: '3' }, { RUNTIME_LEASE_SECONDS: '3', RUNTIME_WAKE_MS: '1001' },
    { RUNTIME_BATCH_SIZE: '0' }, { RUNTIME_SHUTDOWN_SECONDS: '0' }]) assert.throws(() => loadConfig(env));
  assert.equal(loadConfig({}).runtime.maxConcurrent, 8);
});

test('foreground watch CLI opens persistent storage and exits cleanly on a stop signal', { timeout: 15_000 }, async () => {
  const s = runtimeFixture();
  const script = `process.argv=[process.execPath,'cli','watch','--create'];
process.on('message',()=>process.emit('SIGINT'));
await import('./dist/src/cli.js');process.disconnect();`;
  const child = spawn(process.execPath, ['--experimental-sqlite','--input-type=module','-e',script], {
    windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'],
    env: { ...process.env, APP_MODE: 'demo', STORAGE_KIND: 'sqlite', DATABASE_PATH: s.path, NOTIFICATION_TO: 'reader@example.invalid' },
  });
  let output = '', error = '', stopped = false;
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', chunk => {
        output += String(chunk);
        if (!stopped && output.includes('Simulated foreground runtime:')) { stopped = true; child.send('stop'); }
      });
      child.stderr!.on('data', chunk => { error += String(chunk); }); child.on('error', reject);
      child.on('exit', code => { try { assert.equal(code, 0, error); resolve(); } catch (failure) { reject(failure); } });
    });
    assert.ok(output.includes('Runtime stopped: stopped')); assert.equal(s.store.runtime.current(), null);
    assert.ok(s.store.schedules.tasks().length > 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); s.close(); }
});

test('runtime rejects real adapters and memory durability before acquiring execution rights', () => {
  const s = runtimeFixture();
  try {
    assert.throws(() => s.app({ notifications: { capability: 'real', send: async () => ({ status: 'accepted', providerId: 'forbidden' }) } }));
    assert.throws(() => s.app({ store: { ...s.store, durability: 'memory' } as unknown as SqliteStore }));
    assert.equal(s.store.runtime.current(), null);
  } finally { s.close(); }
});
