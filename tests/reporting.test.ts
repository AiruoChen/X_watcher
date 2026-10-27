import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Post, ReportCommit, ReportSnapshot, RuntimeConfig } from '../src/domain/model.js';
import type { WatchStore } from '../src/domain/ports.js';
import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { migrate, MIGRATIONS } from '../src/adapters/storage/sqlite/migrations.js';
import { FixtureSource } from '../src/adapters/source/fixture-source.js';
import { FixtureAnalyzer } from '../src/adapters/analysis/fixture-analyzer.js';
import { ManualClock } from '../src/adapters/clock.js';
import { Sha256Hasher } from '../src/adapters/hash.js';
import { BuildReport } from '../src/application/build-report.js';
import { ReportTextRenderer } from '../src/application/report-renderer.js';
import { IngestTarget } from '../src/application/ingest-target.js';
import { ProcessAnalysis } from '../src/application/process-analysis.js';
import { DueDigests } from '../src/application/due-digests.js';
import { loadConfig } from '../src/config.js';
import { loadLocalConfig } from '../src/config/load.js';
import { digestWindowForDay, shiftDay } from '../src/domain/time.js';
import { hasFreshReportCheck, latestReportDay, reportDueAt } from '../src/domain/policies/reporting.js';
import { RevisionConflictError, SourceFailure } from '../src/domain/errors.js';
import { stableId } from '../src/domain/identifiers.js';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
import { deferred, flush, runtimeFixture } from './helpers/runtime.js';

const day = '2026-01-01', window = digestWindowForDay(day, 'Asia/Shanghai'), hash = new Sha256Hasher();
const config = loadConfig({}), target = config.targets[0]!;
const post: Post = { id: 'synthetic-post', targetId: target.id, text: 'A synthetic product update.',
  publishedAt: '2026-01-01T12:00:00Z', url: 'https://example.invalid/synthetic' };
const answer = { summary: '合成产品动态', chatgptUpdates: ['合成更新'], reset: null };
function setup(kind: string, cfg: RuntimeConfig = config, path = ':memory:') {
  const clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
  const store: WatchStore = kind === 'memory' ? new MemoryStore() : new SqliteStore(path, { create: true, claims: { clock } });
  const t = cfg.targets[0]!;
  store.registerTarget({ ...t, authorId: 'fixture:' + t.handle.toLowerCase(), enabled: true,
    monitorStartedAt: '2026-01-02T00:00:00Z', configRevision: cfg.revision });
  const build = new BuildReport(store, hash, new ReportTextRenderer(), cfg);
  const ingest = (posts: readonly Post[] = [post], from = window.from) =>
    new IngestTarget(new FixtureSource(posts), store, clock, cfg, hash).execute(t, undefined, from);
  const analyze = () => new ProcessAnalysis(new FixtureAnalyzer(new Map(store.versions(t.id).map(p => [p.id, answer]))),
    store, [], clock, cfg).execute(t);
  return { clock, store, target: t, build, ingest, analyze,
    generate: (w = window) => build.execute(t, w, clock.now().toISOString()),
    close: () => { if (store instanceof SqliteStore) store.close(); } };
}
function capture(s: ReturnType<typeof setup>): ReportCommit {
  let result: ReportCommit | undefined;
  const proxy = new Proxy(s.store, { get: (store, property) => property === 'commitReport'
    ? (command: ReportCommit) => { result = structuredClone(command); return false; }
    : typeof Reflect.get(store, property) === 'function' ? Reflect.get(store, property).bind(store) : Reflect.get(store, property) });
  new BuildReport(proxy, hash, new ReportTextRenderer(), config).execute(s.target, window, s.clock.now().toISOString());
  assert.ok(result); return result;
}
function snapshots(s: ReturnType<typeof setup>): readonly ReportSnapshot[] { return s.store.reports(s.target.id) as readonly ReportSnapshot[]; }

for (const kind of ['memory', 'sqlite']) {
  test(kind + ': 07:59 waits; 08:00 requires a fresh full recheck, fixes immutable references and deduplicates', async () => {
    const s = setup(kind);
    try {
      s.clock.jumpWallClock(-60000); await s.ingest(); await s.analyze();
      assert.equal(s.generate(), false); assert.equal(s.store.reports(target.id).length, 0);
      s.clock.advance(60000); assert.equal(s.generate(), false);
      assert.equal(s.store.reportProgress(target.id, day)!.state, 'awaiting_data');
      await s.ingest(); assert.equal(s.generate(), true);
      const saved = snapshots(s)[0]!, mail = s.store.outbox()[0]!.notification;
      assert.equal(saved.state, 'ready'); assert.deepEqual(saved.postKeys, saved.items.map(i => i.post.key));
      assert.equal(saved.items[0]!.result!.analysis.summary, answer.summary);
      assert.equal(saved.contentHash, hash.hash(saved.text)); assert.equal(mail.text, saved.text);
      assert.ok(saved.text.includes(post.url)); assert.equal(saved.timeZone, 'Asia/Shanghai');
      assert.equal(s.generate(), false); assert.equal(s.store.outbox().length, 1);
      const detached = s.store.reportInputs(target.id, window);
      (detached.items[0]!.post as { text: string }).text = 'tampered';
      assert.equal(snapshots(s)[0]!.items[0]!.post.text, post.text);
      assert.equal(s.store.postVersion(saved.postKeys[0]!)!.text, post.text);
    } finally { s.close(); }
  });
  test(kind + ': a failed or missing query is never empty; 08:15 alerts once and recovery atomically queues the report', async () => {
    const s = setup(kind);
    try {
      assert.equal(s.generate(), false); assert.equal(s.store.outbox().length, 0);
      s.clock.advance(15 * 60000); assert.equal(s.generate(), true);
      assert.equal(s.store.reportProgress(target.id, day)!.state, 'awaiting_data');
      assert.equal(s.store.outbox().length, 1); assert.equal(s.generate(), false);
      await s.ingest(); await s.analyze(); assert.equal(s.generate(), true);
      assert.equal(s.store.reportProgress(target.id, day)!.incidentClosed, true);
      assert.deepEqual(s.store.outbox().map(x => x.notification.kind), ['service_alert','service_alert','digest']);
      assert.equal(snapshots(s)[0]!.state, 'ready'); assert.equal(s.generate(), false);
      assert.equal(s.store.outbox().length, 3);
    } finally { s.close(); }
  });
  test(kind + ': full zero-post day records empty without mail; an interrupted query leaves no false empty', async () => {
    const s = setup(kind);
    try {
      await assert.rejects(new IngestTarget({ capability: 'simulated', fetch: async () => { throw new Error('offline'); } },
        s.store, s.clock, config, hash).execute(target));
      s.generate(); assert.equal(s.store.reports(target.id).length, 0);
      await s.ingest([]); assert.equal(s.generate(), false);
      assert.equal(snapshots(s)[0]!.state, 'empty'); assert.equal(s.store.outbox().length, 0);
      assert.equal(s.generate(), false); assert.equal(snapshots(s).length, 1);
    } finally { s.close(); }
  });
  test(kind + ': analysis grace produces marked excerpts, then a next-day addendum without mutating the first mail', async () => {
    const s = setup(kind);
    try {
      await s.ingest(); s.generate(); assert.equal(s.store.reportProgress(target.id, day)!.state, 'awaiting_analysis');
      s.clock.advance(14 * 60000 + 59000); s.generate(); assert.equal(snapshots(s).length, 0);
      s.clock.advance(1000); s.generate();
      const first = snapshots(s)[0]!, firstMail = s.store.outbox()[0]!;
      assert.equal(first.state, 'partial'); assert.ok(first.text.includes('待分析 · 原文摘录'));
      assert.ok(first.text.includes(post.text)); assert.ok(!first.text.includes(answer.summary));
      await s.analyze(); assert.equal(s.generate(), false);
      s.clock.advance(86400000); await s.ingest(); s.generate();
      const addon = snapshots(s)[1]!;
      assert.equal(addon.kind, 'addendum'); assert.equal(addon.previousReportId, first.id);
      assert.equal(addon.changes[0]!.kind, 'analysis_updated'); assert.equal(addon.state, 'ready');
      assert.deepEqual(snapshots(s)[0], first); assert.deepEqual(s.store.outbox()[0], firstMail);
      assert.equal(s.generate(), false);
    } finally { s.close(); }
  });
  test(kind + ': late and edited posts become historical addenda; an empty yesterday still permits them', async () => {
    const s = setup(kind);
    try {
      await s.ingest(); await s.analyze(); s.generate();
      const first = snapshots(s)[0]!, mail = s.store.outbox()[0]!;
      const late = { ...post, id: 'late', text: 'Late synthetic text.' };
      const edit = { ...post, text: 'Edited synthetic text.' };
      s.clock.advance(1000); await s.ingest([edit, late]); await s.analyze(); assert.equal(s.generate(), false);
      s.clock.advance(86400000); await s.ingest([edit, late]);
      const yesterday = digestWindowForDay('2026-01-02', config.timeZone);
      assert.equal(s.generate(yesterday), false); assert.equal(snapshots(s).at(-1)!.state, 'empty');
      assert.equal(s.generate(), true);
      const addon = snapshots(s).find(r => r.kind === 'addendum')!;
      assert.equal(addon.day, day); assert.equal(addon.previousReportId, first.id);
      assert.deepEqual(new Set(addon.changes.map(c => c.kind)), new Set(['edited','late']));
      assert.ok(addon.text.includes('不计入昨日新帖')); assert.equal(addon.items.length, 2);
      assert.deepEqual(snapshots(s)[0], first); assert.deepEqual(s.store.outbox()[0], mail);
      assert.equal(s.store.outbox().length, 2); assert.equal(s.store.versions(target.id).length, 3);
    } finally { s.close(); }
  });
  test(kind + ': explicit deletion is a linked addendum and never inferred from a missing source response', async () => {
    const s = setup(kind);
    try {
      await s.ingest(); await s.analyze(); s.generate(); const first = snapshots(s)[0]!;
      s.clock.advance(1000); await s.ingest([]); assert.equal(s.generate(), false);
      const old = s.store.versions(target.id)[0]!, cp = s.store.checkpoint(target.id), now = s.clock.now().toISOString();
      const key = stableId('post', old.provider, old.authorId, old.id, 'deleted'), job = s.store.analysisJobs(target.id)[0]!;
      s.store.commitIngestion({ targetId: target.id, expectedRevision: cp.revision, cursor: cp.cursor,
        observedAt: now, posts: [{ ...old, key, sourceVersion: 'deleted', discoveredAt: now, deleted: true }],
        jobs: [{ ...job, id: stableId('analysis', key, job.analyzerVersion, job.promptVersion), postKey: key, state: 'pending', revision: 0, attempts: 0, nextAttemptAt: null }],
        coverage: { ...window, to: now, id: 'deletion-proof', targetId: target.id, status: 'complete', reason: null } });
      s.clock.advance(86400000); await s.ingest([]); s.generate();
      const addon = snapshots(s)[1]!;
      assert.equal(addon.changes[0]!.kind, 'deleted'); assert.equal(addon.previousReportId, first.id);
      assert.ok(addon.text.includes('来源明确标记删除')); assert.equal(addon.analysisComplete, true);
    } finally { s.close(); }
  });
  test(kind + ': later incremental ingestion cannot erase the persisted daily completeness recheck', async () => {
    const s = setup(kind);
    try {
      await s.ingest(); s.generate(); s.clock.advance(60000);
      await new IngestTarget(new FixtureSource([post]), s.store, s.clock, config, hash).execute(target);
      await s.analyze();
      assert.ok(hasFreshReportCheck(s.store.reportInputs(target.id, window), '2026-01-02T00:00:00Z'));
      s.generate(); assert.equal(snapshots(s)[0]!.state, 'ready');
    } finally { s.close(); }
  });
  test(kind + ': stale post, analysis and progress snapshots fail CAS without partial writes', async () => {
    const s = setup(kind);
    try {
      await s.ingest(); s.clock.advance(15 * 60000); const pending = capture(s);
      await s.analyze(); assert.throws(() => s.store.commitReport(pending), RevisionConflictError);
      assert.equal(snapshots(s).length, 0); assert.equal(s.store.outbox().length, 0);
      const ready = capture(s); s.clock.advance(1000); await s.ingest([{ ...post, text: 'New version' }]);
      assert.throws(() => s.store.commitReport(ready), RevisionConflictError);
      await s.analyze(); const current = capture(s); assert.equal(s.store.commitReport(current), true);
      assert.throws(() => s.store.commitReport(current), RevisionConflictError);
      assert.equal(snapshots(s).length, 1); assert.equal(s.store.outbox().length, 1);
    } finally { s.close(); }
  });
  test(kind + ': forged body, item set and hash are rejected before any report/progress/notification is saved', async () => {
    const s = setup(kind);
    try {
      await s.ingest(); await s.analyze(); const command = capture(s);
      for (const alter of [
        (c: ReportCommit): ReportCommit => ({ ...c, snapshot: { ...c.snapshot!, text: 'forged' } }),
        (c: ReportCommit): ReportCommit => ({ ...c, snapshot: { ...c.snapshot!, postKeys: [], items: [] } }),
        (c: ReportCommit): ReportCommit => ({ ...c, snapshot: { ...c.snapshot!, contentHash: '0'.repeat(64) } }),
      ]) assert.throws(() => s.store.commitReport(alter(command)));
      assert.equal(snapshots(s).length, 0); assert.equal(s.store.reportProgress(target.id, day), null);
      assert.equal(s.store.outbox().length, 0);
    } finally { s.close(); }
  });
  test(kind + ': RSSHub snapshots only permit explicit partial preview and never become a full or empty report', async () => {
    const cfg = loadLocalConfig({ APP_MODE: 'preview', SOURCE_PROVIDER: 'rsshub', STORAGE_KIND: 'sqlite',
      ANALYSIS_PROVIDER: 'deferred', ANALYSIS_CREDENTIAL_ENV: '', SOURCE_CREDENTIAL_ENV: '' });
    const s = setup(kind, cfg), p: Post = { ...post, targetId: s.target.id, origin: {
      authorId: 'fixture:' + s.target.handle.toLowerCase(), sourcePostId: post.id, sourceVersion: 'snapshot',
      completeness: 'unknown', kind: 'unknown', editHistory: [], references: [] } };
    try {
      await new IngestTarget({ capability: 'simulated', fetch: async () => ({ posts: [p], complete: true, nextCursor: 'synthetic',
        coverageStatus: 'unverified', scope: 'rsshub_timeline_snapshot' }) }, s.store, s.clock, cfg, hash).execute(s.target);
      assert.throws(() => s.build.preview(s.target, window, s.clock.now().toISOString()), /--partial/);
      const preview = s.build.preview(s.target, window, s.clock.now().toISOString(), true);
      assert.ok(preview.text.includes('可能有遗漏')); assert.equal(preview.sourceComplete, false);
      assert.equal(s.store.reportProgress(s.target.id, day), null); assert.equal(s.store.outbox().length, 0);
      s.generate(); assert.equal(snapshots(s).length, 0);
      assert.throws(() => s.build.execute(s.target, window, s.clock.now().toISOString(), true, false), /complete source/);
    } finally { s.close(); }
  });
}

test('calendar deadlines follow leap years, UTC offsets and IANA fold/gap; days remain natural-day windows', () => {
  assert.equal(reportDueAt('2024-02-29', 'Asia/Shanghai', '08:00'), '2024-03-01T00:00:00.000Z');
  assert.equal(reportDueAt('2026-03-07', 'America/New_York', '02:30'), '2026-03-08T07:00:00.000Z');
  assert.equal(reportDueAt('2026-10-31', 'America/New_York', '01:30'), '2026-11-01T05:30:00.000Z');
  assert.equal(latestReportDay(new Date('2026-11-01T06:15:00Z'), 'America/New_York', '01:30'), '2026-10-31');
  assert.equal(reportDueAt('2026-01-01', 'Asia/Kathmandu', '08:00'), '2026-01-02T02:15:00.000Z');
  assert.equal(latestReportDay(new Date('2026-01-01T23:59:59Z'), 'Asia/Shanghai', '08:00'), '2025-12-31');
  assert.equal(latestReportDay(new Date('2026-01-02T00:00:00Z'), 'Asia/Shanghai', '08:00'), day);
  const dst = digestWindowForDay('2026-03-08', 'America/New_York');
  assert.equal(Date.parse(dst.to) - Date.parse(dst.from), 23 * 3600000);
  assert.throws(() => reportDueAt('2026-02-29', 'Asia/Shanghai', '08:00'));
});

test('08:00 recheck shares ingestion claim, resets opaque cursor, and captures older edits exactly once', async () => {
  const s = runtimeFixture(); s.clock.jumpWallClock(-60000);
  const calls: { cursor: string | null; from: string }[] = [];
  const source = { capability: 'simulated' as const, fetch: async (_t: unknown, cursor: string | null, q?: { from: string }) => {
    calls.push({ cursor, from: q!.from }); return { posts: [], complete: true, nextCursor: 'opaque' };
  } };
  const { scheduler } = s.app({ sources: new Map([['x', source]]) });
  try {
    s.store.runtime.acquire(3600000); scheduler.initialize(); scheduler.pulse(s.context); await scheduler.drain();
    assert.equal(calls.length, 1); s.clock.advance(60000);
    scheduler.pulse(s.context); scheduler.pulse(s.context); await scheduler.drain();
    assert.equal(calls.length, 2); assert.equal(calls[1]!.cursor, null);
    assert.equal(calls[1]!.from, window.from);
    s.clock.advance(1000); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls.length, 2);
    assert.equal(s.store.reports(target.id).length, 1);
  } finally { s.close(); }
});
test('slow daily recheck cannot overlap and its retry deadline is not bypassed by subsequent pulses', async () => {
  const s = runtimeFixture({ RETRY_BASE_SECONDS: '60', RETRY_MAX_SECONDS: '120' });
  s.clock.jumpWallClock(-60000); let calls = 0;
  const held = deferred<import('../src/domain/model.js').PostBatch>();
  const source = { capability: 'simulated' as const, fetch: async () => {
    calls++; if (calls === 1) return { posts: [], complete: true, nextCursor: null };
    if (calls === 2) return held.promise;
    throw new SourceFailure('rate_limited', true, '2026-01-02T00:10:00Z');
  } };
  const { scheduler } = s.app({ sources: new Map([['x', source]]) });
  try {
    s.store.runtime.acquire(3600000); scheduler.initialize(); scheduler.pulse(s.context); await scheduler.drain();
    s.clock.advance(60000); scheduler.pulse(s.context);
    s.clock.advance(1000); scheduler.pulse(s.context); await flush(); assert.equal(calls, 2);
    held.resolve({ posts: [], complete: false, nextCursor: null }); await scheduler.drain();
    scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 2);
    s.clock.advance(60000); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 3);
    s.clock.advance(60000); scheduler.pulse(s.context); await scheduler.drain(); assert.equal(calls, 3);
  } finally { s.close(); }
});

for (const offline of [1, 7, 10]) test('restart after ' + offline + ' days catches up oldest first, caps historical mail and persists skipped range', async () => {
  const s = runtimeFixture();
  try {
    await new IngestTarget(new FixtureSource([]), s.store, s.clock, s.config, hash).execute(target);
    new DueDigests(s.store, s.clock, s.config, true).execute(target);
    s.clock.advance(offline * 86400000);
    const latest = latestReportDay(s.clock.now(), config.timeZone, '08:00');
    const posts = Array.from({ length: offline + 1 }, (_, i) => ({ ...post, id: 'day-' + i,
      publishedAt: shiftDay(day, i) + 'T12:00:00Z' }));
    const { scheduler } = s.app({ sources: new Map([['x', new FixtureSource(posts)]]),
      analyzer: new FixtureAnalyzer(new Map(posts.map(p => [p.id, answer]))) });
    s.store.runtime.acquire(3600000); scheduler.initialize();
    for (let i = 0; i < 8; i++) {
      const before = s.store.outbox().filter(x => x.notification.kind === 'digest').length;
      scheduler.pulse(s.context); await scheduler.drain();
      assert.ok(s.store.outbox().filter(x => x.notification.kind === 'digest').length - before <= 3);
      s.clock.advance(1000);
    }
    const expected = Array.from({ length: Math.min(offline + 1, 7) }, (_, i) => shiftDay(latest, i - Math.min(offline, 6)));
    const reported = s.store.reports(target.id).filter(r => r.revision === 1);
    assert.deepEqual(reported.map(r => r.day), expected);
    const boundary = s.store.reportBoundary(target.id)!;
    assert.equal(boundary.beforeDay, expected[0]);
    if (offline === 10) {
      assert.equal(boundary.firstDay, day); assert.ok(day < boundary.beforeDay);
      new BuildReport(s.store, hash, new ReportTextRenderer(), s.config).execute(target, window, s.clock.now().toISOString(), true, false);
      assert.ok(s.store.reports(target.id).some(r => r.day === day));
    }
  } finally { s.close(); }
});

test('SQLite restart deduplicates incident, report and mail; two connections fence stale rendered snapshots', async () => {
  const root = temporaryStorage(), path = join(root, 'report.sqlite'); const s = setup('sqlite', config, path);
  let other: SqliteStore | undefined;
  try {
    s.generate(); s.clock.advance(15 * 60000); s.generate(); await s.ingest(); await s.analyze();
    const command = capture(s); other = new SqliteStore(path);
    other.commitReport(command); assert.throws(() => s.store.commitReport(command), RevisionConflictError);
    other.close(); other = new SqliteStore(path);
    const report = new BuildReport(other, hash, new ReportTextRenderer(), config);
    assert.equal(report.execute(target, window, s.clock.now().toISOString()), false);
    assert.equal(other.reports(target.id).length, 1); assert.equal(other.outbox().length, 3);
    assert.equal(other.reportProgress(target.id, day)!.incidentClosed, true);
  } finally { other?.close(); s.close(); cleanupStorage(root); }
});
test('SQLite injected notification failure rolls back report, progress and outbox as one unit', async () => {
  const root = temporaryStorage(), path = join(root, 'rollback-report.sqlite'); const s = setup('sqlite', config, path);
  try {
    await s.ingest(); await s.analyze(); const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER fail_report_mail BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
    raw.close(); assert.throws(() => s.generate());
    assert.equal(snapshots(s).length, 0); assert.equal(s.store.reportProgress(target.id, day), null);
    assert.equal(s.store.outbox().length, 0);
  } finally { s.close(); cleanupStorage(root); }
});
test('schema 5 migration retains legacy reports and unknown mail with a verified pre-schema-6 backup', () => {
  const root = temporaryStorage(), path = join(root, 'v5-report.sqlite'); let store: SqliteStore | undefined;
  try {
    const raw = new DatabaseSync(path); migrate(raw, true, MIGRATIONS.slice(0, 5));
    const identity = { ...target, authorId: 'synthetic', enabled: true, monitorStartedAt: '2026-01-02T00:00:00Z', configRevision: 'old' };
    raw.prepare('INSERT INTO targets VALUES(?,?,?,?)').run(target.id, target.provider, identity.authorId, JSON.stringify(identity));
    const old = { ...window, id: 'old-report', targetId: target.id, timeZone: config.timeZone, revision: 1, state: 'empty',
      postKeys: [], contentHash: hash.hash('old'), createdAt: '2026-01-02T00:00:00Z', configRevision: 'old' };
    raw.prepare('INSERT INTO digest_reports(id,target_id,day,revision,payload) VALUES(?,?,?,?,?)').run(old.id, target.id, day, 1, JSON.stringify(old));
    const mail = { id: 'old-unknown', kind: 'digest', targetId: target.id, recipient: 'reader@example.invalid',
      subject: 'Synthetic', text: 'Synthetic', createdAt: old.createdAt };
    raw.prepare('INSERT INTO notifications(id,state,payload,revision) VALUES(?,?,?,?)').run(mail.id, 'needs_attention', JSON.stringify(mail), 4);
    raw.close(); store = new SqliteStore(path);
    assert.deepEqual(store.reports(target.id)[0], old); assert.deepEqual(store.outbox()[0]!.notification, mail);
    assert.equal(store.deliveryRecord(mail.id)!.revision, 4); assert.equal(store.reportProgress(target.id, day), null);
    const backup = readdirSync(root).find(p => p.includes('.pre-v6.') && p.endsWith('.sqlite'))!;
    const check = new DatabaseSync(join(root, backup), { readOnly: true });
    assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 5);
    assert.equal(check.prepare('SELECT count(*) n FROM digest_reports').get()!['n'], 1); check.close();
  } finally { store?.close(); cleanupStorage(root); }
});
test('local CLI previews are read-only and manual generation never queues email or loads real credentials', async () => {
  const root = temporaryStorage(), path = join(root, 'cli-report.sqlite'); const s = setup('sqlite', config, path);
  try {
    await s.ingest(); await s.analyze();
    const env = { ...process.env, APP_MODE: 'preview', SOURCE_PROVIDER: 'x-api-v2', STORAGE_KIND: 'sqlite',
      ANALYSIS_PROVIDER: 'deferred', ANALYSIS_CREDENTIAL_ENV: '', ANALYSIS_MODEL: '', SOURCE_CREDENTIAL_ENV: 'X_BEARER_TOKEN',
      DATABASE_PATH: path, NOTIFICATION_TO: 'reader@example.invalid', WATCH_HANDLES: target.handle };
    const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-sqlite', 'dist/src/cli.js', ...args],
      { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    const before = run('digest:status', day); assert.equal(before.status, 0, before.stderr);
    assert.equal(JSON.parse(before.stdout).reportId, null); assert.ok(!before.stdout.includes(env.NOTIFICATION_TO));
    const preview = run('digest:preview', day); assert.equal(preview.status, 0, preview.stderr);
    assert.ok(preview.stdout.includes(post.url)); assert.equal(snapshots(s).length, 0); assert.equal(s.store.outbox().length, 0);
    const generated = run('digest:generate', day); assert.equal(generated.status, 0, generated.stderr);
    assert.equal(JSON.parse(generated.stdout).mailQueued, false); assert.equal(snapshots(s).length, 1);
    const invalid = run('digest:generate', '2026-02-30'); assert.notEqual(invalid.status, 0);
    assert.equal(s.store.outbox().length, 0);
  } finally { s.close(); cleanupStorage(root); }
});

test('report template distinguishes ChatGPT/API/Codex status and leaves missing reset time and timezone unknown', async () => {
  const s = setup('memory');
  try {
    await s.ingest(); const item = s.store.reportInputs(target.id, window).items[0]!;
    const analysis = { ...answer, updates: [
      { product: 'chatgpt' as const, status: 'released' as const, text: 'Synthetic ChatGPT', evidence: post.text },
      { product: 'api' as const, status: 'rolling_out' as const, text: 'Synthetic API', evidence: post.text },
      { product: 'codex' as const, status: 'planned' as const, text: 'Synthetic Codex', evidence: post.text },
    ], resetFinding: { kind: 'discussion' as const, evidence: post.text, whenText: null, timeZoneText: null, normalizedAt: null, normalizationEvidence: null } };
    const text = new ReportTextRenderer().render({ handle: target.handle, window, timeZone: config.timeZone,
      issuedOn: day, generatedAt: s.clock.now().toISOString(), kind: 'daily', sourceComplete: true, analysisComplete: true,
      changes: [], items: [{ post: item.post, result: { jobId: 'synthetic', postKey: item.post.key,
        analyzerVersion: 'synthetic', promptVersion: 'synthetic', completedAt: s.clock.now().toISOString(), analysis } }] });
    for (const phrase of ['chatgpt · 已发布', 'api · 逐步开放', 'codex · 计划', '重置信息：待确认', '时区：未知', '北京时间：未知', post.url])
      assert.ok(text.includes(phrase), phrase);
  } finally { s.close(); }
});
test('historical addendum preserves an unknown base-mail result and cannot authorize resending it', async () => {
  const s = setup('sqlite');
  try {
    await s.ingest(); await s.analyze(); s.generate();
    const id = s.store.outbox()[0]!.notification.id;
    const claim = s.store.claimDelivery(id, s.clock.now().toISOString())!;
    s.store.finishDelivery(claim.attemptId, { status: 'unknown', reason: 'synthetic connection lost' }, s.clock.now().toISOString());
    const original = s.store.deliveryRecord(id);
    s.clock.advance(86400000); await s.ingest([{ ...post, text: 'An edited synthetic post.' }]); await s.analyze(); s.generate();
    assert.deepEqual(s.store.deliveryRecord(id), original);
    assert.equal(s.store.claimDelivery(id, s.clock.now().toISOString()), null);
    assert.equal(s.store.deliveryAttempts().length, 1); assert.equal(s.store.outbox().length, 2);
  } finally { s.close(); }
});
for (const kind of ['memory','sqlite']) test(kind + ': half-open natural days exclude midnight-next-day; unknown bodies remain partial excerpts', async () => {
  const s = setup(kind);
  const partial: Post = { ...post, id: 'unknown-body', origin: { authorId: 'fixture:' + target.handle.toLowerCase(),
    sourcePostId: 'unknown-body', sourceVersion: 'synthetic', completeness: 'unknown', kind: 'unknown', editHistory: [], references: [] } };
  const start = { ...post, id: 'start', publishedAt: window.from };
  const end = { ...post, id: 'end', text: 'Excluded future day', publishedAt: window.to };
  try {
    await s.ingest([start, partial, end]); await s.analyze();
    s.clock.advance(15 * 60000); s.generate();
    const snapshot = snapshots(s)[0]!;
    assert.equal(snapshot.state, 'partial'); assert.equal(snapshot.items.length, 2);
    assert.ok(snapshot.items.some(i => i.post.id === 'start')); assert.ok(!snapshot.items.some(i => i.post.id === 'end'));
    const unknown = snapshot.items.find(i => i.post.id === 'unknown-body')!;
    assert.equal(unknown.post.completeness, 'unknown'); assert.equal(unknown.result, null);
    assert.ok(snapshot.text.includes('待分析 · 原文摘录')); assert.ok(!snapshot.text.includes(end.text));
  } finally { s.close(); }
});
