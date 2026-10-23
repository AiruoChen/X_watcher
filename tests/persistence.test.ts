import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { openDatabase } from '../src/adapters/storage/sqlite/connection.js';
import { migrate, MIGRATIONS } from '../src/adapters/storage/sqlite/migrations.js';
import { restoreBackup, fileHash } from '../src/adapters/storage/sqlite/backup.js';
import { transaction } from '../src/adapters/storage/sqlite/transaction.js';
import { seeded, contractFixture } from './contracts/watch-store.contract.js';
import { ProcessAnalysis } from '../src/application/process-analysis.js';
import { FixtureAnalyzer } from '../src/adapters/analysis/fixture-analyzer.js';
import { ResetRule } from '../src/application/rules/reset-rule.js';
import { DailyDigest } from '../src/application/daily-digest.js';
import { TextDigestRenderer } from '../src/application/digest-renderer.js';
import { ManualClock } from '../src/adapters/clock.js';
import { RevisionConflictError } from '../src/domain/errors.js';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
import type { Notification } from '../src/domain/model.js';

const now = '2026-01-02T00:00:00.000Z';
const message: Notification = { id: 'n', kind: 'reset', targetId: 't', recipient: 'reader@example.invalid', subject: 'test', text: 'test', createdAt: now };
const target = { id: 't', provider: 'fixture', handle: 'fixture', authorId: 'a', enabled: true, monitorStartedAt: now, configRevision: 'v1' };
function setup() {
  const root = temporaryStorage(), path = join(root, 'db.sqlite'), stores: SqliteStore[] = [];
  const open = (options: ConstructorParameters<typeof SqliteStore>[1] = {}) => {
    const store = new SqliteStore(path, { create: true, ...options }); stores.push(store); return store;
  };
  return { root, path, open, close: () => { for (const store of stores) { try { store.close(); } catch { /* Already closed. */ } } cleanupStorage(root); } };
}

test('creation is explicit; corrupt, empty and future-schema files are never rebuilt', () => {
  const s = setup();
  try {
    assert.throws(() => new SqliteStore(s.path)); assert.equal(existsSync(s.path), false);
    for (const bytes of [Buffer.alloc(0), Buffer.from('bad database')]) {
      writeFileSync(s.path, bytes); assert.throws(() => new SqliteStore(s.path, { create: true })); assert.deepEqual(readFileSync(s.path), bytes);
    }
    const other = join(s.root, 'future.sqlite'), store = new SqliteStore(other, { create: true }); store.close();
    const db = new DatabaseSync(other); db.exec('PRAGMA user_version=99'); db.close();
    const before = fileHash(other); assert.throws(() => new SqliteStore(other)); assert.equal(fileHash(other), before);
    const corrupt = join(s.root, 'corrupt-page.sqlite'), created = new SqliteStore(corrupt, { create: true }); created.close();
    const bytes = readFileSync(corrupt); bytes[100] = 255; writeFileSync(corrupt, bytes);
    const corruptHash = fileHash(corrupt); assert.throws(() => new SqliteStore(corrupt)); assert.equal(fileHash(corrupt), corruptHash);
  } finally { s.close(); }
});

test('schema v1 migrates losslessly with a verified pre-upgrade backup', () => {
  const s = setup();
  try {
    const db = new DatabaseSync(s.path); db.exec('PRAGMA foreign_keys=ON'); migrate(db, true, MIGRATIONS.slice(0, 1));
    db.prepare('INSERT INTO targets VALUES(?,?,?,?)').run(target.id, target.provider, target.authorId, JSON.stringify(target)); db.close();
    const upgraded = s.open(); assert.deepEqual(upgraded.target(target.id), target);
    const backups = readdirSync(s.root).filter(p => p.includes('.pre-v2.')); assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(s.root, backups[0]!), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()!['user_version'], 1); assert.equal(backup.prepare('SELECT count(*) n FROM targets').get()!['n'], 1); backup.close();
  } finally { s.close(); }
});

test('failed migration rolls back DDL, history and data together', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, true); db.prepare('INSERT INTO targets VALUES(?,?,?,?)').run(target.id, target.provider, target.authorId, JSON.stringify(target));
    assert.throws(() => migrate(db, false, [...MIGRATIONS, { version: 3, sql: 'CREATE TABLE should_rollback(id); INSERT INTO missing_table VALUES(1);' }]));
    assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 2);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='should_rollback'").get()!['n'], 0);
    assert.equal(db.prepare('SELECT count(*) n FROM targets').get()!['n'], 1);
  } finally { db.close(); }
});

test('migration history tampering and missing schema objects fail closed', () => {
  const s = setup();
  try {
    s.open().close(); const db = new DatabaseSync(s.path); db.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1"); db.close();
    assert.throws(() => s.open(), /history/);
    const missing = join(s.root, 'missing-index.sqlite'), fresh = new SqliteStore(missing, { create: true }); fresh.close();
    const raw = new DatabaseSync(missing); raw.exec('DROP INDEX posts_target_time'); raw.close();
    assert.throws(() => new SqliteStore(missing), /Missing database index/);
  } finally { s.close(); }
});

test('transaction helper rolls back partial writes and refuses async callbacks before execution', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => transaction(db, () => { db.exec('CREATE TABLE no_partial_write(id)'); throw new Error('abort'); }));
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='no_partial_write'").get()!['n'], 0);
    let called = false; assert.throws(() => transaction(db, async () => { called = true; }), /Async/); assert.equal(called, false);
    assert.throws(() => transaction(db, () => ({ then: () => undefined })), /Thenable/);
  } finally { db.close(); }
});

test('checkpoints, completed mail, interrupted attempts and duplicate keys survive reopen', () => {
  const s = setup();
  try {
    const first = s.open(); first.registerTarget(target); first.enqueue(message);
    const claim = first.claimDelivery(message.id, now)!; first.finishDelivery(claim.attemptId, { status: 'accepted', providerId: 'provider' }, now);
    first.enqueue({ ...message, id: 'interrupted' }); first.claimDelivery('interrupted', now); first.close();
    const second = s.open(); assert.equal(second.enqueue(message), false);
    assert.deepEqual(second.outbox().map(e => e.state), ['provider_accepted', 'sending']);
    assert.equal(second.claimDelivery('interrupted', now), null); assert.equal(second.recoverInFlight(), 1);
    assert.equal(second.outbox()[1]!.state, 'needs_attention'); assert.equal(second.deliveryAttempts().length, 2);
  } finally { s.close(); }
});

test('two connections cannot both claim a notification or overwrite an old checkpoint revision', () => {
  const s = setup();
  try {
    const a = s.open(), b = s.open(); a.registerTarget(target); a.enqueue(message);
    assert.ok(a.claimDelivery(message.id, now)); assert.equal(b.claimDelivery(message.id, now), null);
    a.commitPoll({ targetId: target.id, expectedRevision: 0, cursor: 'new', observedAt: now, posts: [], notifications: [] });
    assert.throws(() => b.commitPoll({ targetId: target.id, expectedRevision: 0, cursor: 'old', observedAt: now, posts: [], notifications: [] }), RevisionConflictError);
    assert.equal(b.checkpoint(target.id).cursor, 'new');
    const raw = new DatabaseSync(s.path); raw.prepare('DELETE FROM checkpoints WHERE target_id=?').run(target.id); raw.close();
    assert.throws(() => a.commitIngestion({ targetId: target.id, expectedRevision: 0, cursor: 'invalid', observedAt: now,
      coverage: { id: 'must-rollback', targetId: target.id, from: '2026-01-01T00:00:00Z', to: now, status: 'complete', reason: null },
      posts: [], jobs: [] }), RevisionConflictError);
    assert.equal(a.coverage(target.id).length, 0);
  } finally { s.close(); }
});

const childScript = `import { SqliteStore } from './dist/src/adapters/storage/sqlite/store.js';
const s=new SqliteStore(process.argv[1]);
const claim=s.claimDelivery('n','2026-01-02T00:00:00.000Z');
console.log(claim ? 'claimed' : 'not_claimed'); s.close();`;
function childClaim(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite','--input-type=module','-e',childScript,path], { windowsHide: true });
    let output = '', error = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { error += String(chunk); });
    child.on('error', reject); child.on('exit', code => { if (code !== 0) reject(new Error(error)); else resolve(output.trim()); });
  });
}
test('separate processes competing for the same mail create exactly one attempt', { timeout: 15000 }, async () => {
  const s = setup();
  try {
    s.open().enqueue(message);
    const results = await Promise.all([childClaim(s.path), childClaim(s.path)]);
    assert.deepEqual(results.sort(), ['claimed','not_claimed']); assert.equal(s.open().deliveryAttempts().length, 1);
  } finally { s.close(); }
});

test('hard process termination during a transaction does not publish its checkpoint update', () => {
  const s = setup();
  try {
    const store = s.open(); store.registerTarget(target);
    const script = `import { DatabaseSync } from 'node:sqlite'; const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN IMMEDIATE'); d.exec("UPDATE checkpoints SET revision=77,cursor='uncommitted'"); process.kill(process.pid,'SIGKILL');`;
    const result = spawnSync(process.execPath, ['--experimental-sqlite','--input-type=module','-e',script,s.path], { windowsHide: true, timeout: 10000 });
    assert.notEqual(result.status, 0); assert.equal(store.checkpoint(target.id).revision, 0); assert.equal(store.checkpoint(target.id).cursor, null);
  } finally { s.close(); }
});

test('runtime ownership fences other connections and expiry alone never proves a live process dead', () => {
  const s = setup(), clock = new ManualClock(new Date(now));
  try {
    const a = s.open({ claims: { clock, hostId: 'test', ownerId: 'a', pid: 111 } });
    const b = s.open({ claims: { clock, hostId: 'test', ownerId: 'b', pid: 222, isProcessAlive: () => true } });
    const lease = a.runtime.acquire(1000)!; assert.ok(lease); assert.equal(b.runtime.acquire(1000), null);
    assert.throws(() => b.enqueue(message), /execution right/);
    clock.advance(2000); assert.equal(b.runtime.acquire(1000), null); assert.throws(() => a.enqueue(message), /expired/);
    const renewed = a.runtime.renew(lease.revision, 1000); a.runtime.release(renewed.revision);
    const next = b.runtime.acquire(1000)!; assert.ok(next.revision > renewed.revision);
    assert.throws(() => a.enqueue(message), /execution right/);
  } finally { s.close(); }
});

test('dead same-host owner may be explicitly replaced, but sending work stays unknown', () => {
  const s = setup(), clock = new ManualClock(new Date(now));
  try {
    const a = s.open({ claims: { clock, hostId: 'test', ownerId: 'a', pid: 111 } });
    const old = a.runtime.acquire(1000)!; a.enqueue(message); a.claimDelivery(message.id, now);
    assert.throws(() => a.runtime.release(old.revision), /In-flight/);
    clock.advance(2000);
    const b = s.open({ claims: { clock, hostId: 'test', ownerId: 'b', pid: 222, isProcessAlive: () => false } });
    const lease = b.runtime.acquire(1000)!; assert.ok(lease);
    assert.equal(b.outbox()[0]!.state, 'sending'); assert.equal(b.claimDelivery(message.id, now), null);
    assert.throws(() => b.recoverAbandonedWork(lease.revision - 1), RevisionConflictError);
    assert.deepEqual(b.recoverAbandonedWork(lease.revision), { analysisJobs: 0, notifications: 1 });
    assert.equal(b.outbox()[0]!.state, 'needs_attention'); assert.equal(b.claimDelivery(message.id, now), null);
    assert.throws(() => a.runtime.renew(old.revision, 1000));
    b.runtime.release(lease.revision);
  } finally { s.close(); }
});

test('liveness proof is revalidated against the ownership revision inside acquisition', () => {
  const s = setup(), clock = new ManualClock(new Date(now));
  try {
    const a = s.open({ claims: { clock, hostId: 'test', ownerId: 'a', pid: 111 } });
    const old = a.runtime.acquire(1000)!; clock.advance(2000);
    const b = s.open({ claims: { clock, hostId: 'test', ownerId: 'b', pid: 222,
      isProcessAlive: () => { a.runtime.renew(old.revision, 1000); return false; } } });
    assert.equal(b.runtime.acquire(1000), null); assert.equal(a.runtime.current()!.ownerId, 'a');
  } finally { s.close(); }
});

test('WAL-consistent backup restores to a new path and never overwrites an original database', () => {
  const s = setup();
  try {
    const store = s.open(); store.enqueue(message); store.claimDelivery(message.id, now);
    const backup = join(s.root, 'backup.sqlite'), manifest = store.backup(backup), destination = join(s.root, 'restored.sqlite');
    assert.equal(manifest.sha256, fileHash(backup)); assert.throws(() => store.backup(backup), /exists/);
    const before = fileHash(s.path); assert.throws(() => restoreBackup(backup, s.path, manifest.sha256), /exists/); assert.equal(fileHash(s.path), before);
    assert.throws(() => restoreBackup(backup, destination, '0'.repeat(64)), /checksum/); assert.equal(existsSync(destination), false);
    restoreBackup(backup, destination, manifest.sha256);
    const restored = new SqliteStore(destination);
    try { assert.equal(restored.outbox()[0]!.state, 'sending'); assert.equal(restored.recoverInFlight(), 1); assert.equal(restored.claimDelivery(message.id, now), null); }
    finally { restored.close(); }
    assert.equal(readdirSync(s.root).some(name => name.endsWith('.partial')), false);
  } finally { s.close(); }
});

test('a SQL failure after report insertion rolls back report and notification together', async () => {
  const s = setup();
  try {
    const store = s.open(), h = await seeded(() => store), f = contractFixture;
    await new ProcessAnalysis(new FixtureAnalyzer(new Map([[f.sample.id, f.answer]])), store, [new ResetRule()], h.clock, f.config).execute(f.target);
    const raw = new DatabaseSync(s.path);
    raw.exec("CREATE TRIGGER reject_digest BEFORE INSERT ON notifications WHEN json_extract(NEW.payload,'$.kind')='digest' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const digest = new DailyDigest(store, new TextDigestRenderer(), f.config.recipient, h.hasher, f.config.timeZone, f.config.revision);
    assert.throws(() => digest.execute(f.target, f.window, now)); assert.equal(store.reports(f.target.id).length, 0);
    raw.exec('DROP TRIGGER reject_digest'); raw.close();
    assert.equal(digest.execute(f.target, f.window, now), true); assert.equal(store.reports(f.target.id).length, 1);
  } finally { s.close(); }
});

test('processing analysis is preserved on reopen and explicit recovery quarantines it', async () => {
  const s = setup();
  try {
    const first = s.open(), h = await seeded(() => first), f = contractFixture;
    first.claimAnalysis(first.analysisJobs(f.target.id)[0]!.id, h.clock.now().toISOString()); first.close();
    const second = s.open(); assert.equal(second.analysisJobs(f.target.id)[0]!.state, 'processing');
    const lease = second.runtime.acquire(10_000)!;
    assert.deepEqual(second.recoverAbandonedWork(lease.revision), { analysisJobs: 1, notifications: 0 });
    assert.equal(second.analysisJobs(f.target.id)[0]!.state, 'needs_attention');
    second.runtime.release(lease.revision);
  } finally { s.close(); }
});

test('unknown liveness and a different host cannot reclaim an expired runtime lease', () => {
  const s = setup(), clock = new ManualClock(new Date(now));
  try {
    const a = s.open({ claims: { clock, hostId: 'host-a', ownerId: 'a', pid: 111 } }); a.runtime.acquire(1000); clock.advance(2000);
    const unknown = s.open({ claims: { clock, hostId: 'host-a', ownerId: 'b', pid: 222, isProcessAlive: () => null } });
    const other = s.open({ claims: { clock, hostId: 'host-b', ownerId: 'c', pid: 333, isProcessAlive: () => false } });
    assert.equal(unknown.runtime.acquire(1000), null); assert.equal(other.runtime.acquire(1000), null);
  } finally { s.close(); }
});

test('normal ingestion, analysis and reporting never request all historical versions', async () => {
  const s = setup();
  class IndexedOnlyStore extends SqliteStore { override versions(): never { throw new Error('History-wide read is forbidden.'); } }
  const store = new IndexedOnlyStore(s.path, { create: true });
  try {
    const h = await seeded(() => store), f = contractFixture;
    await new ProcessAnalysis(new FixtureAnalyzer(new Map([[f.sample.id, f.answer]])), store, [new ResetRule()], h.clock, f.config).execute(f.target);
    const digest = new DailyDigest(store, new TextDigestRenderer(), f.config.recipient, h.hasher, f.config.timeZone, f.config.revision);
    assert.equal(digest.execute(f.target, f.window, now), true);
  } finally { store.close(); s.close(); }
});

test('a worker cannot finish another worker claim and recovery cannot quarantine its own active work', () => {
  const s = setup();
  try {
    const a = s.open(), b = s.open(); a.enqueue(message);
    const claim = a.claimDelivery(message.id, now)!;
    assert.throws(() => b.finishDelivery(claim.attemptId, { status: 'accepted', providerId: 'wrong' }, now), /another worker/);
    const lease = a.runtime.acquire(10_000)!;
    assert.deepEqual(a.recoverAbandonedWork(lease.revision), { analysisJobs: 0, notifications: 0 });
    assert.equal(a.outbox()[0]!.state, 'sending');
    a.finishDelivery(claim.attemptId, { status: 'accepted', providerId: 'right' }, now); a.runtime.release(lease.revision);
  } finally { s.close(); }
});
