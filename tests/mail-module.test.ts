import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { migrate, MIGRATIONS } from '../src/adapters/storage/sqlite/migrations.js';
import { EmailChannel } from '../src/adapters/notification/email/channel.js';
import { ManualClock } from '../src/adapters/clock.js';
import { hasher } from './helpers/analysis-mail.js';
import { DeliverNotifications } from '../src/application/deliver-notifications.js';
import { ReconcileNotification } from '../src/application/reconcile-notification.js';
import { RevisionConflictError } from '../src/domain/errors.js';
import type { MailTransport, WatchStore } from '../src/domain/ports.js';
import type { DeliveryResolution, MailReceipt, Notification } from '../src/domain/model.js';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
const now = '2026-01-02T00:00:00.000Z';
const message: Notification = { id: 'n', targetId: 't', recipient: 'reader@example.invalid', subject: 'Synthetic reset', text: 'Synthetic body', createdAt: now, kind: 'reset' };
function setup(store: WatchStore = new MemoryStore(), response: unknown = { status: 'accepted', providerId: 'provider-1' }) {
  const clock = new ManualClock(new Date(now)); let calls = 0;
  const transport: MailTransport = { capability: 'simulated', provider: 'fake', account: 'account-a',
    send: async (n, binding) => {
      calls++; const saved = store.deliveryRecord(n.id)!;
      assert.equal(saved.entry.state, 'sending'); assert.deepEqual(saved.attempt!.binding, binding);
      assert.equal(n.recipient, message.recipient); return response;
    },
    lookup: async (binding, providerId) => ({ provider: binding.provider, account: binding.account, idempotencyKey: binding.idempotencyKey,
      providerId: providerId ?? 'provider-1', status: 'delivered', checkedAt: clock.now().toISOString() }) };
  const channel = new EmailChannel(transport, clock, hasher, { from: 'sender@example.invalid', idempotencyTtlMs: 60_000, maxAttempts: 2 });
  store.enqueue(message);
  return { store, clock, transport, channel, deliver: new DeliverNotifications(store, channel, clock), calls: () => calls };
}
function resolution(store: WatchStore, action: DeliveryResolution['action']): DeliveryResolution {
  const record = store.deliveryRecord(message.id)!;
  return { notificationId: message.id, attemptId: record.attempt!.id, expectedRevision: record.revision, action, actor: 'operator', reason: 'Verified synthetic provider record', at: now };
}
for (const kind of ['memory','sqlite']) {
  const create = () => kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:', { claims: { clock: new ManualClock(new Date(now)) } });
  test(kind + ': accepted is not delivered; exact lookup is read-only and application is audited with CAS', async () => {
    const s = setup(create());
    try {
      await s.deliver.execute(); const before = s.store.deliveryRecord(message.id)!;
      assert.equal(before.entry.state, 'provider_accepted'); assert.equal(before.revision, 2);
      const observation = await new ReconcileNotification(s.store, s.transport).execute(message.id);
      assert.deepEqual(s.store.deliveryRecord(message.id), before);
      const command = { ...resolution(s.store, 'apply_receipt'), receipt: observation.receipt };
      s.store.resolveDelivery(command); assert.equal(s.store.deliveryRecord(message.id)!.entry.state, 'delivered');
      assert.equal(s.store.mailAudits(message.id).length, 1); assert.throws(() => s.store.resolveDelivery(command), RevisionConflictError);
      assert.equal(s.store.mailAudits(message.id).length, 1);
      assert.equal((await s.deliver.execute()).length, 0); assert.equal(s.calls(), 1);
    } finally { if (s.store instanceof SqliteStore) s.store.close(); }
  });
  test(kind + ': unknown stays blocked, not_found is inconclusive, manual retry preserves original binding', async () => {
    const s = setup(create(), { status: 'unknown' });
    try {
      await s.deliver.execute(); await s.deliver.execute(); assert.equal(s.calls(), 1);
      assert.equal(s.store.deliveryRecord(message.id)!.entry.state, 'needs_attention');
      const old = s.store.deliveryAttempts()[0]!;
      const receipt: MailReceipt = { ...old.binding!, status: 'not_found', providerId: null, checkedAt: now };
      assert.throws(() => s.store.resolveDelivery({ ...resolution(s.store, 'apply_receipt'), receipt }));
      assert.equal(s.store.mailAudits(message.id).length, 0);
      s.store.resolveDelivery(resolution(s.store, 'confirm_not_sent_retry'));
      const retry = s.store.claimDelivery(message.id, now, { ...old.binding!, account: 'changed', expiresAt: null })!;
      assert.deepEqual(retry.binding, old.binding); assert.deepEqual(s.store.deliveryAttempts()[0], old);
      s.store.finishDelivery(retry.attemptId, { status: 'unknown', reason: 'synthetic' }, now);
      assert.throws(() => s.store.resolveDelivery(resolution(s.store, 'confirm_not_sent_retry')));
      assert.equal(s.store.mailAudits(message.id).length, 1);
    } finally { if (s.store instanceof SqliteStore) s.store.close(); }
  });
  test(kind + ': interruption and human confirm preserve immutable attempts and never fake delivery', async () => {
    const s = setup(create());
    try {
      s.store.claimDelivery(message.id, now, s.channel.deliveryBinding(message, now));
      assert.throws(() => s.store.resolveDelivery(resolution(s.store, 'confirm_sent')));
      s.store.recoverInFlight(); const attempts = s.store.deliveryAttempts();
      assert.equal(s.store.deliveryRecord(message.id)!.entry.state, 'needs_attention');
      assert.throws(() => s.store.resolveDelivery({ ...resolution(s.store, 'confirm_sent'), reason: '' }));
      s.store.resolveDelivery(resolution(s.store, 'confirm_sent'));
      assert.equal(s.store.deliveryRecord(message.id)!.entry.state, 'provider_accepted');
      assert.deepEqual(s.store.deliveryAttempts(), attempts); assert.equal(s.calls(), 0);
    } finally { if (s.store instanceof SqliteStore) s.store.close(); }
  });
}
test('ambiguous rejection, invalid response and transport exception are unknown and redact provider text', async () => {
  for (const response of [null, { status: 'rejected', reason: 'secret' }, { status: 'accepted', providerId: '' }, { status: 'accepted', providerId: 'bad\nid' }]) {
    const s = setup(undefined, response); await s.deliver.execute();
    assert.equal(s.store.outbox()[0]!.state, 'needs_attention'); assert.doesNotMatch(JSON.stringify(s.store.outbox()), /secret|bad\\nid/);
  }
  const s = setup(); const channel = new EmailChannel({ ...s.transport, send: async () => { throw new Error('private secret'); } }, s.clock, hasher,
    { from: 'sender@example.invalid', idempotencyTtlMs: 0, maxAttempts: 2 });
  await new DeliverNotifications(s.store, channel, s.clock).execute();
  assert.equal(s.store.outbox()[0]!.state, 'needs_attention'); assert.doesNotMatch(JSON.stringify(s.store.outbox()), /private secret/);
});
test('only proven rejection becomes failed; header injection never reaches the transport', async () => {
  const s = setup(undefined, { status: 'rejected', definitelyNotAccepted: true });
  await s.deliver.execute(); assert.equal(s.store.outbox()[0]!.state, 'failed');
  const bad = setup(); bad.store.enqueue({ ...message, id: 'bad', subject: 'hello\r\nBcc: attacker@example.invalid' });
  await bad.deliver.execute(); assert.equal(bad.calls(), 1); assert.equal(bad.store.deliveryRecord('bad')!.entry.state, 'failed');
});
test('expired idempotency, changed account and pre-aborted calls never reach transport', async () => {
  for (const mode of ['expired','account','abort']) {
    const s = setup(), claim = s.store.claimDelivery(message.id, now, s.channel.deliveryBinding(message, now))!;
    if (mode === 'expired') s.clock.advance(60_000);
    const controller = new AbortController(); if (mode === 'abort') controller.abort();
    const result = await s.channel.sendClaim(mode === 'account' ? { ...claim, binding: { ...claim.binding!, account: 'other' } } : claim, controller.signal);
    assert.equal(result.status, 'unknown'); assert.equal(s.calls(), 0);
  }
});
test('mismatched account, key, provider ID and time cannot apply a receipt or write an audit', async () => {
  const s = setup(); await s.deliver.execute();
  const { receipt } = await new ReconcileNotification(s.store, s.transport).execute(message.id);
  for (const change of [{ account: 'other' }, { provider: 'other' }, { idempotencyKey: 'other' }, { providerId: 'other' }, { checkedAt: '2000-01-01T00:00:00Z' }, { checkedAt: '2099-01-01T00:00:00Z' }]) {
    assert.throws(() => s.store.resolveDelivery({ ...resolution(s.store, 'apply_receipt'), receipt: { ...receipt, ...change } }));
  }
  assert.equal(s.store.mailAudits(message.id).length, 0);
  await assert.rejects(new ReconcileNotification(s.store, { ...s.transport, account: 'other' }).execute(message.id));
});
test('SQLite two connections cannot claim twice or resolve a stale observation after retry', async () => {
  const root = temporaryStorage(), path = join(root, 'mail.sqlite'), first = new SqliteStore(path, { create: true }), second = new SqliteStore(path);
  try {
    const s = setup(first, null); await s.deliver.execute();
    const stale = resolution(second, 'confirm_sent');
    first.resolveDelivery(resolution(first, 'confirm_not_sent_retry'));
    const claim = first.claimDelivery(message.id, now)!;
    assert.equal(second.claimDelivery(message.id, now), null);
    assert.throws(() => second.resolveDelivery(stale), RevisionConflictError);
    first.finishDelivery(claim.attemptId, { status: 'unknown', reason: 'synthetic' }, now);
    assert.equal(second.mailAudits(message.id).length, 1);
  } finally { first.close(); second.close(); cleanupStorage(root); }
});
test('schema v3 migration preserves uncertain mail, immutable snapshot and backup; audit survives restart', () => {
  const root = temporaryStorage(), path = join(root, 'old.sqlite'); let store: SqliteStore | undefined;
  try {
    const db = new DatabaseSync(path); migrate(db, true, MIGRATIONS.slice(0, 3));
    db.prepare('INSERT INTO notifications(id,state,payload,result) VALUES(?,?,?,?)').run(message.id, 'needs_attention', JSON.stringify(message), JSON.stringify({ status: 'unknown', reason: 'interrupted' }));
    db.prepare('INSERT INTO delivery_attempts(id,notification_id,number,payload) VALUES(?,?,?,?)').run('legacy', message.id, 1,
      JSON.stringify({ id: 'legacy', notificationId: message.id, number: 1, startedAt: now, finishedAt: now, result: { status: 'unknown', reason: 'interrupted' } }));
    db.close(); store = new SqliteStore(path);
    assert.deepEqual(store.outbox()[0]!.notification, message); assert.equal(store.deliveryRecord(message.id)!.revision, 0);
    const backup = readdirSync(root).find(p => p.includes('.pre-v' + MIGRATIONS.length + '.') && p.endsWith('.sqlite'))!;
    const old = new DatabaseSync(join(root, backup), { readOnly: true }); assert.equal(old.prepare('PRAGMA user_version').get()!['user_version'], 3); old.close();
    store.resolveDelivery(resolution(store, 'abandon')); store.close(); store = new SqliteStore(path);
    assert.equal(store.deliveryRecord(message.id)!.entry.state, 'failed'); assert.equal(store.mailAudits(message.id).length, 1);
    assert.equal(store.deliveryAttempts()[0]!.result?.status, 'unknown');
  } finally { store?.close(); cleanupStorage(root); }
});
test('CLI status redacts message contents; explicit resolution never invokes mail', async () => {
  const root = temporaryStorage(), path = join(root, 'cli.sqlite'), store = new SqliteStore(path, { create: true });
  try {
    const s = setup(store, null); await s.deliver.execute(); const command = resolution(store, 'confirm_sent'); store.close();
    const env = { ...process.env, APP_MODE: 'preview', STORAGE_KIND: 'sqlite', DATABASE_PATH: path,
      SOURCE_PROVIDER: 'x-api-v2', SOURCE_CREDENTIAL_ENV: 'SYNTHETIC_MISSING_TOKEN', SYNTHETIC_MISSING_TOKEN: '',
      ANALYSIS_PROVIDER: 'deferred', ANALYSIS_CREDENTIAL_ENV: '', ANALYSIS_MODEL: '' };
    const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-sqlite','dist/src/cli.js', ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const status = run(['mail:status', message.id]); assert.equal(status.status, 0, status.stderr); assert.doesNotMatch(status.stdout, /reader@|Synthetic body/);
    const resolved = run(['mail:resolve', message.id, command.attemptId, String(command.expectedRevision), 'confirm_sent', 'operator', 'Verified by operator']);
    assert.equal(resolved.status, 0, resolved.stderr); assert.equal(JSON.parse(resolved.stdout).state, 'provider_accepted');
  } finally { try { store.close(); } catch {} cleanupStorage(root); }
});

test('bounced receipt remains distinct from delivered and failed submission', async () => {
  const s = setup(); await s.deliver.execute();
  const observed = await new ReconcileNotification(s.store, s.transport).execute(message.id);
  s.store.resolveDelivery({ ...resolution(s.store, 'apply_receipt'), receipt: { ...observed.receipt, status: 'bounced' } });
  assert.equal(s.store.deliveryRecord(message.id)!.entry.state, 'bounced');
  assert.equal(s.store.deliveryAttempts()[0]!.result?.status, 'accepted');
  await s.deliver.execute(); assert.equal(s.calls(), 1);
});
test('SQLite rolls resolution back when audit insertion fails', async () => {
  const root = temporaryStorage(), path = join(root, 'audit.sqlite'), store = new SqliteStore(path, { create: true });
  try {
    const s = setup(store, null); await s.deliver.execute(); const before = store.deliveryRecord(message.id);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'injected audit failure'); END"); db.close();
    assert.throws(() => store.resolveDelivery(resolution(store, 'confirm_sent')));
    assert.deepEqual(store.deliveryRecord(message.id), before); assert.deepEqual(store.mailAudits(message.id), []);
  } finally { store.close(); cleanupStorage(root); }
});

test('receipt validation rejects extra raw provider data rather than persisting it in audits', async () => {
  const s = setup(); await s.deliver.execute();
  const { receipt } = await new ReconcileNotification(s.store, s.transport).execute(message.id);
  const untrusted = { ...receipt, token: 'synthetic-private' };
  assert.throws(() => s.store.resolveDelivery({ ...resolution(s.store, 'apply_receipt'), receipt: untrusted }));
  assert.equal(s.store.mailAudits(message.id).length, 0);
});
