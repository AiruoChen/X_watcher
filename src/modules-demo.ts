import { loadConfig } from './config.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { ManualClock } from './adapters/clock.js';
import { Sha256Hasher } from './adapters/hash.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { createAnalysisModule, createMailModule } from './bootstrap-analysis-mail.js';
import { IngestTarget } from './application/ingest-target.js';
import { ProcessAnalysis } from './application/process-analysis.js';
import { SemanticResetRule } from './application/rules/semantic-reset-rule.js';
import { DeliverNotifications } from './application/deliver-notifications.js';
import { ReconcileNotification } from './application/reconcile-notification.js';
import { ResolveNotification } from './application/resolve-notification.js';
import type { MailTransport, StructuredModel } from './domain/ports.js';
const config = loadConfig({ ANALYSIS_PROVIDER: 'synthetic', ANALYSIS_MODEL: 'synthetic', ANALYZER_VERSION: 'semantic-v1',
  MAIL_PROVIDER: 'synthetic', MAIL_ACCOUNT: 'synthetic-account', MAIL_FROM: 'sender@example.invalid', MAIL_IDEMPOTENCY_TTL_SECONDS: '60' });
const clock = new ManualClock(new Date('2026-01-02T00:00:00Z')), hasher = new Sha256Hasher(), store = new SqliteStore(':memory:');
const target = config.targets[0]!, text = 'Synthetic: ChatGPT Plus limits reset at 2026-01-03T00:00:00Z UTC.';
const model: StructuredModel = { capability: 'simulated', complete: async request => ({ status: 'complete',
  output: { postId: request.input.postId, summary: '合成示例：作者宣布 ChatGPT Plus 额度重置。', topics: ['额度'], updates: [],
    reset: { kind: 'announcement', product: 'chatgpt', certainty: 'confirmed', evidence: text, whenText: '2026-01-03T00:00:00Z',
      timeZoneText: 'UTC', audience: 'ChatGPT Plus', previousPostId: null } } }) };
let calls = 0;
const mail: MailTransport = { capability: 'simulated', provider: 'synthetic', account: 'synthetic-account',
  send: async () => { calls++; throw Error('Synthetic lost response'); },
  lookup: async binding => ({ provider: binding.provider, account: binding.account, idempotencyKey: binding.idempotencyKey,
    providerId: 'synthetic-message', status: 'delivered', checkedAt: clock.now().toISOString() }) };
try {
  store.registerTarget({ ...target, authorId: 'fixture:' + target.handle.toLowerCase(), enabled: true,
    monitorStartedAt: '2026-01-01T00:00:00Z', configRevision: config.revision });
  await new IngestTarget(new FixtureSource([{ id: 'synthetic', targetId: target.id, text,
    publishedAt: '2026-01-01T23:00:00Z', url: 'https://example.invalid/post/synthetic' }]), store, clock, config, hasher).execute(target);
  await new ProcessAnalysis(createAnalysisModule(config, model, hasher), store, [new SemanticResetRule()], clock, config).execute(target);
  const deliver = new DeliverNotifications(store, createMailModule(config, mail, clock, hasher), clock);
  await deliver.execute(); await deliver.execute();
  const n = store.outbox()[0]!;
  if (!n || n.state !== 'needs_attention' || calls !== 1) throw Error('Unknown delivery isolation failed.');
  const observation = await new ReconcileNotification(store, mail).execute(n.notification.id);
  new ResolveNotification(store).execute({ notificationId: n.notification.id, attemptId: observation.attemptId,
    expectedRevision: observation.revision, action: 'apply_receipt', actor: 'synthetic-operator',
    reason: 'Apply exact synthetic receipt', receipt: observation.receipt, at: clock.now().toISOString() });
  console.log(JSON.stringify({ mode: 'fully_simulated', analysis: 'validated', before: n.state,
    after: store.outbox()[0]!.state, sendCalls: calls, audits: store.mailAudits(n.notification.id).length, networkCalls: 0 }));
} finally { store.close(); }
