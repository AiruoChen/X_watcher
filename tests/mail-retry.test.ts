import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { ManualClock } from '../src/adapters/clock.js';
import { EmailChannel } from '../src/adapters/notification/email/channel.js';
import { DeliverNotifications } from '../src/application/deliver-notifications.js';
import { Sha256Hasher } from '../src/adapters/hash.js';
import { migrate, MIGRATIONS } from '../src/adapters/storage/sqlite/migrations.js';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
import type { WatchStore, MailTransport } from '../src/domain/ports.js';
import type { Notification } from '../src/domain/model.js';
const now = '2026-01-02T00:00:00.000Z';
const notification: Notification = { id: 'retry', kind: 'reset', targetId: 'synthetic', recipient: 'reader@example.invalid',
  subject: 'Synthetic retry', text: 'Synthetic content', createdAt: now };
function fixture(store: WatchStore, responses: unknown[], opts: { ttl?: number; attempts?: number } = {}) {
  const clock = new ManualClock(new Date(now)); let calls = 0;
  const client: MailTransport = { capability: 'simulated', provider: 'synthetic', account: 'synthetic',
    send: async () => { const response = responses[Math.min(calls++, responses.length - 1)]; if (response instanceof Error) throw response; return response; } };
  const channel = new EmailChannel(client, clock, new Sha256Hasher(), { from: 'sender@example.invalid',
    idempotencyTtlMs: opts.ttl ?? 0, maxAttempts: opts.attempts ?? 3, retryPolicy: { baseDelayMs: 1000, maxDelayMs: 5000 } });
  store.enqueue(notification);
  return { store, clock, channel, calls: () => calls, deliver: new DeliverNotifications(store, channel, clock) };
}
const transient = { status: 'rejected', definitelyNotAccepted: true, retryable: true };
for (const kind of ['memory','sqlite']) {
  const create = () => kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:', { claims: { clock: new ManualClock(new Date(now)) } });
  test(kind + ': proven temporary rejection waits, preserves binding and succeeds without duplicate attempts', async () => {
    const s = fixture(create(), [transient, { status: 'accepted', providerId: 'synthetic-id' }]);
    try {
      await s.deliver.execute(); const first = s.store.deliveryAttempts()[0]!;
      assert.equal(s.store.outbox()[0]!.state, 'retry_wait'); assert.equal(s.store.outbox()[0]!.nextAttemptAt, '2026-01-02T00:00:01.000Z');
      assert.equal(s.store.claimDelivery(notification.id, now), null);
      await s.deliver.execute(); assert.equal(s.calls(), 1); s.clock.advance(999); await s.deliver.execute(); assert.equal(s.calls(), 1);
      s.clock.advance(1); await s.deliver.execute();
      assert.equal(s.calls(), 2); assert.equal(s.store.outbox()[0]!.state, 'provider_accepted');
      assert.equal(s.store.outbox()[0]!.nextAttemptAt, undefined);
      assert.deepEqual(s.store.deliveryAttempts()[0], first); assert.deepEqual(s.store.deliveryAttempts()[1]!.binding, first.binding);
      await s.deliver.execute(); assert.equal(s.calls(), 2);
    } finally { if (s.store instanceof SqliteStore) s.store.close(); }
  });
  test(kind + ': provider lower bound, exponential delay, priority and exhaustion are persisted', async () => {
    const s = fixture(create(), [{ ...transient, retryAt: '2026-01-02T00:01:00.000Z' }, transient, transient]);
    try {
      await s.deliver.execute(); assert.equal(s.store.outbox()[0]!.nextAttemptAt, '2026-01-02T00:01:00.000Z');
      s.clock.advance(59000); await s.deliver.execute(); assert.equal(s.calls(), 1);
      s.clock.advance(1000);
      s.store.enqueue({ ...notification, id: 'digest', kind: 'digest' });
      assert.equal(s.store.pendingNotifications(1, s.clock.now().toISOString())[0]!.notification.id, 'retry');
      await s.deliver.execute(undefined, 1000, 1);
      assert.equal(s.store.outbox()[0]!.nextAttemptAt, '2026-01-02T00:01:02.000Z');
      s.clock.advance(2000); await s.deliver.execute(undefined, 1000, 1);
      assert.equal(s.store.deliveryRecord('retry')!.entry.state, 'failed'); assert.equal(s.store.deliveryAttempts().length, 3);
      assert.equal(s.store.deliveryRecord('retry')!.entry.nextAttemptAt, undefined);
    } finally { if (s.store instanceof SqliteStore) s.store.close(); }
  });
  test(kind + ': expiry stops retry and abandon atomically cancels a scheduled retry', async () => {
    const short = fixture(create(), [transient], { ttl: 500 });
    try {
      await short.deliver.execute(); assert.equal(short.store.outbox()[0]!.state, 'failed');
      assert.equal(short.store.outbox()[0]!.nextAttemptAt, undefined);
    } finally { if (short.store instanceof SqliteStore) short.store.close(); }
    const s = fixture(create(), [transient]);
    try {
      await s.deliver.execute(); const record = s.store.deliveryRecord(notification.id)!;
      s.store.resolveDelivery({ notificationId: notification.id, attemptId: record.attempt!.id, expectedRevision: record.revision,
        action: 'abandon', actor: 'operator', reason: 'Stop scheduled synthetic retry', at: now });
      s.clock.advance(10000); await s.deliver.execute(); assert.equal(s.calls(), 1); assert.equal(s.store.mailAudits(notification.id).length, 1);
      assert.equal(s.store.outbox()[0]!.state, 'failed'); assert.equal(s.store.outbox()[0]!.nextAttemptAt, undefined);
    } finally { if (s.store instanceof SqliteStore) s.store.close(); }
  });
}
test('unknown, permanent or malformed responses never schedule automatic retries', async () => {
  for (const response of [new Error('synthetic disconnect'), { status: 'unknown' }, { status: 'rejected', retryable: true },
    { status: 'rejected', definitelyNotAccepted: true }, { ...transient, retryAt: 'invalid' }]) {
    const s = fixture(new MemoryStore(), [response]); await s.deliver.execute(); s.clock.advance(86400000); await s.deliver.execute();
    assert.equal(s.calls(), 1); assert.notEqual(s.store.outbox()[0]!.state, 'retry_wait');
  }
});
test('SQLite retry deadline survives reopen and two connections cannot claim it early or twice', async () => {
  const root = temporaryStorage(), path = join(root, 'retry.sqlite'); let first = new SqliteStore(path, { create: true }), second: SqliteStore | undefined;
  try {
    const s = fixture(first, [{ ...transient, retryAt: '2026-01-02T00:02:00.000Z' }]); await s.deliver.execute();
    const attempts = first.deliveryAttempts(); first.close(); first = new SqliteStore(path); second = new SqliteStore(path);
    assert.deepEqual(first.deliveryAttempts(), attempts); assert.equal(first.outbox()[0]!.nextAttemptAt, '2026-01-02T00:02:00.000Z');
    assert.equal(second.claimDelivery(notification.id, '2026-01-02T00:01:59.999Z'), null);
    assert.ok(first.claimDelivery(notification.id, '2026-01-02T00:02:00.000Z'));
    assert.equal(second.claimDelivery(notification.id, '2026-01-02T00:02:00.000Z'), null);
  } finally { first.close(); second?.close(); cleanupStorage(root); }
});
test('interruption on a retry becomes unknown and is never automatically resubmitted', async () => {
  const s = fixture(new MemoryStore(), [transient]); await s.deliver.execute(); s.clock.advance(1000);
  s.store.claimDelivery(notification.id, s.clock.now().toISOString()); s.store.recoverInFlight();
  s.clock.advance(10000); await s.deliver.execute(); assert.equal(s.calls(), 1);
  assert.equal(s.store.outbox()[0]!.state, 'needs_attention'); assert.equal(s.store.outbox()[0]!.nextAttemptAt, undefined);
});
test('schema v4 upgrades losslessly with verified backup; unknown and unbound legacy mail cannot auto-retry', () => {
  const root = temporaryStorage(), path = join(root, 'v4.sqlite'); let store: SqliteStore | undefined;
  try {
    const db = new DatabaseSync(path); migrate(db, true, MIGRATIONS.slice(0, 4));
    db.prepare('INSERT INTO notifications(id,state,payload,result,revision) VALUES(?,?,?,?,?)')
      .run(notification.id, 'needs_attention', JSON.stringify(notification), JSON.stringify({ status: 'unknown', reason: 'synthetic' }), 7);
    db.close(); store = new SqliteStore(path);
    assert.deepEqual(store.outbox()[0]!.notification, notification); assert.equal(store.deliveryRecord(notification.id)!.revision, 7);
    assert.equal(store.pendingNotifications(10, '2030-01-01T00:00:00Z').length, 0);
    const backup = readdirSync(root).find(p => p.includes('.pre-v' + MIGRATIONS.length + '.') && p.endsWith('.sqlite'))!;
    const raw = new DatabaseSync(join(root, backup), { readOnly: true }); assert.equal(raw.prepare('PRAGMA user_version').get()!['user_version'], 4); raw.close();
    store.enqueue({ ...notification, id: 'legacy' }); const claim = store.claimDelivery('legacy', now)!;
    store.finishDelivery(claim.attemptId, { status: 'rejected', reason: 'synthetic proof', retry: { notBefore: null } }, now);
    assert.equal(store.deliveryRecord('legacy')!.entry.state, 'failed');
  } finally { store?.close(); cleanupStorage(root); }
});
test('SQLite finish rolls back attempts and retry deadline together when notification update fails', async () => {
  const root = temporaryStorage(), path = join(root, 'rollback.sqlite'), store = new SqliteStore(path, { create: true });
  try {
    const s = fixture(store, [transient]), claim = store.claimDelivery(notification.id, now, s.channel.deliveryBinding(notification, now))!;
    const before = store.deliveryRecord(notification.id);
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER reject_finish BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"); raw.close();
    assert.throws(() => store.finishDelivery(claim.attemptId, { status: 'rejected', reason: 'synthetic', retry: { notBefore: null } }, now));
    assert.deepEqual(store.deliveryRecord(notification.id), before);
  } finally { store.close(); cleanupStorage(root); }
});
