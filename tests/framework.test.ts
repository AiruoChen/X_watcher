import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/bootstrap.js';
import { ManualClock } from '../src/adapters/clock.js';
import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { FixtureSource } from '../src/adapters/source/fixture-source.js';
import { FixtureAnalyzer } from '../src/adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from '../src/adapters/notification/preview-channel.js';
import { PollTarget } from '../src/application/poll-target.js';
import { DailyDigest } from '../src/application/daily-digest.js';
import { DeliverNotifications } from '../src/application/deliver-notifications.js';
import { TextDigestRenderer } from '../src/application/digest-renderer.js';
import { ResetRule } from '../src/application/rules/reset-rule.js';
import { dueDigestWindow } from '../src/domain/time.js';
import { validateAnalysis } from '../src/domain/validation.js';
import { IncompleteBatchError, RevisionConflictError } from '../src/domain/errors.js';
import type { Analysis, AppEvent, Notification, Post } from '../src/domain/model.js';
import type { ContentAnalyzer, PostSource } from '../src/domain/ports.js';

const config = loadConfig({});
const target = config.targets[0]!;
const post: Post = { id: 'sample-1', targetId: target.id, text: 'Limits reset tomorrow. ChatGPT update.',
  publishedAt: '2026-01-01T04:00:00Z', url: 'https://example.invalid/sample-1' };
const analysis: Analysis = { summary: '示例摘要', chatgptUpdates: ['示例更新'],
  reset: { evidence: 'Limits reset tomorrow.', whenText: 'tomorrow', timeZoneText: null } };
const message: Notification = { id: 'test:1', kind: 'reset', targetId: target.id,
  recipient: 'reader@example.invalid', subject: 'Test', text: 'Test', createdAt: '2026-01-02T00:00:00Z' };
function harness(source?: PostSource, analyzer?: ContentAnalyzer) {
  const store = new MemoryStore();
  const clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
  const channel = new PreviewChannel();
  const events: AppEvent[] = [];
  const dependencies = { sources: new Map([['x', source ?? new FixtureSource([post])]]),
    analyzer: analyzer ?? new FixtureAnalyzer(new Map([[post.id, analysis]])),
    notifications: channel, store, clock, rules: [new ResetRule()],
    digestRenderer: new TextDigestRenderer(), events: { record: (event: AppEvent) => { events.push(event); } } };
  const app = createApplication(config, dependencies);
  return { store, clock, channel, events, dependencies, app };
}
function poll(h: ReturnType<typeof harness>, source: PostSource, analyzer?: ContentAnalyzer): PollTarget {
  return new PollTarget(source, analyzer ?? h.dependencies.analyzer, h.store,
    h.dependencies.rules, h.clock, config.recipient);
}

test('configuration validates usernames, schedule, timezone, and recipient', () => {
  assert.equal(config.pollIntervalMs, 30 * 60_000);
  assert.equal(config.dailyDigestAt, '08:00');
  assert.equal(config.timeZone, 'Asia/Shanghai');
  for (const env of [ { WATCH_HANDLES: '' }, { WATCH_HANDLES: 'Tibo,tibo' },
    { DAILY_DIGEST_AT: '8:00' }, { TIME_ZONE: 'Not/AZone' }, { POLL_INTERVAL_MINUTES: '0' },
    { APP_MODE: 'production' }, { NOTIFICATION_TO: 'invalid' } ]) assert.throws(() => loadConfig(env));
});

test('safe composition rejects live mode and any real adapter', () => {
  const h = harness();
  assert.throws(() => createApplication({ ...config, mode: 'live' }, h.dependencies), /not implemented/);
  assert.throws(() => createApplication(config, { ...h.dependencies,
    notifications: { capability: 'real', send: async () => { throw new Error('must never execute'); } } }), /real adapters/);
  assert.throws(() => createApplication(config, { ...h.dependencies, sources: new Map() }), /Missing source/);
});

test('Beijing digest fires at 08:00 and covers the previous full day', () => {
  assert.equal(dueDigestWindow(new Date('2026-01-01T23:59:59Z'), 'Asia/Shanghai', '08:00'), null);
  assert.deepEqual(dueDigestWindow(new Date('2026-01-02T00:00:00Z'), 'Asia/Shanghai', '08:00'),
    { day: '2026-01-01', from: '2025-12-31T16:00:00.000Z', to: '2026-01-01T16:00:00.000Z' });
});

test('date windows handle year boundaries and daylight saving days', () => {
  const year = dueDigestWindow(new Date('2026-01-01T00:00:00Z'), 'Asia/Shanghai', '08:00')!;
  assert.equal(year.day, '2025-12-31');
  const spring = dueDigestWindow(new Date('2026-03-09T12:00:00Z'), 'America/New_York', '08:00')!;
  assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3_600_000);
  const autumn = dueDigestWindow(new Date('2026-11-02T13:00:00Z'), 'America/New_York', '08:00')!;
  assert.equal(Date.parse(autumn.to) - Date.parse(autumn.from), 25 * 3_600_000);
});

test('end-to-end: reset first, daily digest second, repeated ticks do not resend', async () => {
  const h = harness();
  await h.app.tick();
  await h.app.tick();
  assert.deepEqual(h.channel.list().map(item => item.kind), ['reset', 'digest']);
  assert.match(h.channel.list()[0]!.text, /时区（原文）：未知/);
  assert.match(h.channel.list()[1]!.text, /https:\/\/example.invalid\/sample-1/);
  assert.equal(h.store.checkpoint(target.id).revision, 1);
  h.clock.advance(30 * 60_000);
  await h.app.tick();
  assert.equal(h.store.checkpoint(target.id).revision, 2);
  assert.equal(h.channel.list().length, 2);
});

test('scheduler polls only after 30 minutes; digest still occurs between polls', async () => {
  const h = harness();
  h.clock.advance(-60_000); // 07:59
  await h.app.tick();
  assert.equal(h.channel.list().length, 1);
  h.clock.advance(60_000); // 08:00, next poll is not yet due
  await h.app.tick();
  assert.equal(h.channel.list().length, 2);
  assert.equal(h.store.checkpoint(target.id).revision, 1);
  h.clock.advance(29 * 60_000);
  await h.app.tick();
  assert.equal(h.store.checkpoint(target.id).revision, 2);
});

test('concurrent ticks share one source operation', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const h = harness({ capability: 'simulated', fetch: async () => {
    calls++; await gate; return { posts: [post], nextCursor: '1', complete: true };
  } });
  const a = h.app.tick();
  const b = h.app.tick();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(h.channel.list().length, 2);
});

test('incomplete pagination leaves posts, notifications, and checkpoint untouched', async () => {
  const h = harness();
  await assert.rejects(poll(h, { capability: 'simulated', fetch: async () =>
    ({ posts: [post], nextCursor: '2', complete: false }) }).execute(target), IncompleteBatchError);
  assert.equal(h.store.hasPost(target.id, post.id), false);
  assert.equal(h.store.checkpoint(target.id).revision, 0);
  assert.equal(h.store.outbox().length, 0);
});

test('analysis failure rolls back the whole batch; next poll can retry safely', async () => {
  const h = harness();
  const source = new FixtureSource([post, { ...post, id: 'second' }]);
  await assert.rejects(poll(h, source).execute(target));
  assert.equal(h.store.hasPost(target.id, post.id), false);
  assert.equal(h.store.checkpoint(target.id).cursor, null);
  const analyzer: ContentAnalyzer = { capability: 'simulated', analyze: async () => analysis };
  assert.equal(await poll(h, source, analyzer).execute(target), 2);
});

test('duplicate items in one batch and later batches are analyzed only once', async () => {
  const h = harness();
  let calls = 0;
  const analyzer: ContentAnalyzer = { capability: 'simulated', analyze: async () => { calls++; return analysis; } };
  const source: PostSource = { capability: 'simulated', fetch: async () =>
    ({ posts: [post, post], nextCursor: 'cursor', complete: true }) };
  assert.equal(await poll(h, source, analyzer).execute(target), 1);
  assert.equal(await poll(h, source, analyzer).execute(target), 0);
  assert.equal(calls, 1);
  assert.equal(h.store.outbox().length, 1);
});

test('revision conflict cannot partly add posts or notifications', () => {
  const store = new MemoryStore();
  store.commitPoll({ targetId: target.id, expectedRevision: 0, cursor: 'first',
    observedAt: message.createdAt, posts: [], notifications: [] });
  assert.throws(() => store.commitPoll({ targetId: target.id, expectedRevision: 0, cursor: 'second',
    observedAt: message.createdAt, posts: [{ post, analysis }], notifications: [message] }), RevisionConflictError);
  assert.equal(store.hasPost(target.id, post.id), false);
  assert.equal(store.outbox().length, 0);
  assert.equal(store.checkpoint(target.id).cursor, 'first');
});

test('notification snapshots are immutable and claims are exclusive', () => {
  const store = new MemoryStore();
  const mutable = { ...message };
  assert.equal(store.enqueue(mutable), true);
  mutable.text = 'changed';
  assert.equal(store.enqueue({ ...message, text: 'replacement' }), false);
  const claimed = store.claim(message.id)!;
  assert.equal(claimed.text, 'Test');
  assert.equal(store.claim(message.id), null);
  Object.assign(claimed, { text: 'changed after claim' });
  assert.equal(store.outbox()[0]!.notification.text, 'Test');
});

test('delivery exceptions become needs_attention and are never auto-retried', async () => {
  const store = new MemoryStore(); store.enqueue(message);
  let attempts = 0;
  const delivery = new DeliverNotifications(store, { capability: 'simulated', send: async () => {
    attempts++; throw new Error('timeout after provider may have accepted');
  } });
  await delivery.execute(); await delivery.execute();
  assert.equal(attempts, 1);
  assert.equal(store.outbox()[0]!.state, 'needs_attention');
});

test('explicit recovery isolates interrupted sends and preserves pending entries', () => {
  const store = new MemoryStore(); store.enqueue(message); store.enqueue({ ...message, id: 'test:2' });
  store.claim(message.id);
  assert.equal(store.recoverInFlight(), 1);
  assert.deepEqual(store.outbox().map(entry => entry.state), ['needs_attention', 'pending']);
  assert.equal(store.recoverInFlight(), 0);
});

test('source failure does not block previously queued alerts or cause fast polling retries', async () => {
  let calls = 0;
  const h = harness({ capability: 'simulated', fetch: async () => { calls++; throw new Error('offline'); } });
  h.store.enqueue(message);
  await h.app.tick(); await h.app.tick();
  assert.equal(calls, 1);
  assert.equal(h.channel.list().length, 1);
  assert.equal(h.store.checkpoint(target.id).revision, 0);
  assert.ok(h.events.some(event => event.type === 'cycle.failed'));
});

test('fabricated reset evidence and times are rejected; absent time stays unknown', () => {
  assert.throws(() => validateAnalysis(post, { ...analysis,
    reset: { evidence: 'fabricated', whenText: null, timeZoneText: null } }));
  assert.throws(() => validateAnalysis(post, { ...analysis,
    reset: { evidence: 'Limits reset tomorrow.', whenText: '09:00', timeZoneText: null } }));
  const noTime: Analysis = { ...analysis, reset: { evidence: 'Limits reset tomorrow.', whenText: null, timeZoneText: null } };
  validateAnalysis(post, noTime);
  const alert = new ResetRule().evaluate({ post, analysis: noTime }, message.recipient, message.createdAt)[0]!;
  assert.match(alert.text, /原文未明确说明/);
});

test('digest excludes the next day and requires successful retrieval after the window', () => {
  const store = new MemoryStore();
  const digest = new DailyDigest(store, new TextDigestRenderer(), message.recipient);
  const window = dueDigestWindow(new Date(message.createdAt), 'Asia/Shanghai', '08:00')!;
  assert.equal(digest.execute(target, window, message.createdAt), false);
  store.commitPoll({ targetId: target.id, expectedRevision: 0, cursor: '1', observedAt: message.createdAt,
    posts: [{ post, analysis }, { post: { ...post, id: 'next-day', publishedAt: window.to }, analysis }], notifications: [] });
  assert.equal(store.listPosts(target.id, window).length, 1);
  assert.equal(digest.execute(target, window, message.createdAt), true);
  assert.equal(digest.execute(target, window, message.createdAt), false);
});
