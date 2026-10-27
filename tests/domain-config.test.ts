import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseConfig, describeConfig, ConfigError } from '../src/config.js';
import { stableId } from '../src/domain/identifiers.js';
import { transitionJob, transitionDelivery, transitionReport } from '../src/domain/policies/state.js';
import { covers } from '../src/domain/policies/coverage.js';
import { resetEligible } from '../src/domain/policies/reset.js';
import { retryDelay } from '../src/domain/policies/retry.js';
import { FixtureSource } from '../src/adapters/source/fixture-source.js';
import { ManualClock } from '../src/adapters/clock.js';
import { isInstant } from '../src/domain/time.js';
import { validateAnalysis } from '../src/domain/validation.js';

const config = loadConfig({});
const external = { APP_MODE: 'preview', STORAGE_KIND: 'sqlite', SOURCE_PROVIDER: 'test', SOURCE_CREDENTIAL_ENV: 'X_KEY',
  ANALYSIS_PROVIDER: 'test', ANALYSIS_CREDENTIAL_ENV: 'AI_KEY', ANALYSIS_MODEL: 'configured-model' };

test('configuration defaults implement business policies without fixing model or provider', () => {
  assert.equal(config.schemaVersion, 1); assert.equal(config.mode, 'demo');
  assert.equal(config.policy.digestCatchUpDays, 7); assert.equal(config.policy.resetMaxAgeMs, 86_400_000);
  assert.equal(config.policy.postRetentionDays, 90); assert.equal(config.policy.auditRetentionDays, 180);
  assert.equal(config.services.analysis.model, null); assert.equal(config.services.mail.provider, null);
});
test('unknown schema, malformed values, nulls, and unknown JSON fields fail closed', () => {
  for (const input of [null, [], 'text', { CONFIG_SCHEMA_VERSION: '2' }, { NOTIFICATION_TO: null },
    { POLL_INTERVAL_MINUTES: '0x10' }, { POLL_INTERVAL_MINUTES: '1e3' }, { RETRY_JITTER: 'NaN' },
    { TIME_ZONE: '' }, { UNKNOWN_FIELD: 'value' }, { MAIL_FROM: 'a@example.invalid\nBcc: other@example.invalid' }]) {
    assert.throws(() => parseConfig(input), ConfigError);
  }
});
test('configuration rejects contradictory retry and retention policies', () => {
  for (const input of [{ RETRY_BASE_SECONDS: '40', RETRY_MAX_SECONDS: '30' }, { DIGEST_CATCH_UP_DAYS: '90' },
    { AUDIT_RETENTION_DAYS: '89' }, { RESET_MAX_AGE_HOURS: '3000' }, { MAX_CALLS_PER_DAY: '0' }]) assert.throws(() => parseConfig(input));
});
test('preview/live require explicit services, credentials, durable storage and live recipient', () => {
  assert.throws(() => loadConfig(external));
  const preview = loadConfig({ ...external, X_KEY: 'private-one', AI_KEY: 'private-two' });
  assert.equal(preview.mode, 'preview'); assert.equal(preview.services.mail.credentialEnv, null);
  assert.throws(() => parseConfig({ ...external, STORAGE_KIND: 'memory' }));
  assert.throws(() => parseConfig({ ...external, APP_MODE: 'live' }));
  const live = loadConfig({ ...external, APP_MODE: 'live', X_KEY: 'private-one', AI_KEY: 'private-two', MAIL_KEY: 'private-three',
    MAIL_PROVIDER: 'test', MAIL_CREDENTIAL_ENV: 'MAIL_KEY', MAIL_FROM: 'sender@example.test', NOTIFICATION_TO: 'receiver@example.test' });
  assert.equal(live.mode, 'live');
});
test('secrets never enter config, fingerprint or diagnostic errors', () => {
  const first = loadConfig({ ...external, X_KEY: 'secret-A', AI_KEY: 'secret-B' });
  const second = loadConfig({ ...external, X_KEY: 'rotated-A', AI_KEY: 'rotated-B' });
  assert.equal(first.revision, second.revision);
  assert.doesNotMatch(JSON.stringify(first), /secret-A|secret-B/);
  assert.doesNotMatch(JSON.stringify(describeConfig(first)), /reader@|data\/|X_KEY|AI_KEY/);
  assert.throws(() => parseConfig({ ANALYSIS_CREDENTIAL_ENV: 'secret-key-value' }), error =>
    error instanceof ConfigError && !error.message.includes('secret-key-value'));
  assert.notEqual(loadConfig({ NOTIFICATION_TO: 'changed@example.invalid' }).revision, config.revision);
});
test('demo ignores existing credentials and config instances have independent mutable graphs', () => {
  assert.equal(loadConfig({ X_KEY: 'present', AI_KEY: 'present' }).mode, 'demo');
  const first = loadConfig({}); Object.assign(first.policy, { postRetentionDays: 1 });
  assert.equal(loadConfig({}).policy.postRetentionDays, 90);
});
test('stable identifiers cannot collide on embedded delimiters', () => {
  assert.notEqual(stableId('post', 'a:b', 'c'), stableId('post', 'a', 'b:c'));
  assert.equal(stableId('post', 'abc', 'def'), stableId('post', 'abc', 'def'));
  assert.throws(() => stableId('post', ''));
});
test('state machines reject invalid transitions, retries after success, and unknown resend', () => {
  assert.equal(transitionJob('pending', 'processing'), 'processing');
  assert.equal(transitionDelivery('sending', 'provider_accepted'), 'provider_accepted');
  assert.equal(transitionDelivery('provider_accepted', 'delivered'), 'delivered');
  assert.equal(transitionReport('awaiting_data', 'ready'), 'ready');
  assert.throws(() => transitionJob('completed', 'processing'));
  assert.throws(() => transitionDelivery('needs_attention', 'sending'));
  assert.throws(() => transitionDelivery('sending', 'delivered'));
  assert.throws(() => transitionReport('ready', 'empty'));
});
test('complete coverage must be contiguous, and gap does not count as evidence', () => {
  const base = { targetId: 'target', status: 'complete' as const, reason: null };
  const ranges = [{ ...base, id: '1', from: '2026-01-01T00:00:00Z', to: '2026-01-01T12:00:00Z' },
    { ...base, id: '2', from: '2026-01-01T12:00:00Z', to: '2026-01-02T00:00:00Z' }];
  const query = { from: ranges[0]!.from, to: ranges[1]!.to };
  assert.equal(covers(ranges, 'target', query), true);
  assert.equal(covers([{ ...ranges[0]!, status: 'gap' }, ranges[1]!], 'target', query), false);
  assert.equal(covers(ranges, 'other', query), false);
});
test('first-run history, stale notices and expired resets cannot become fresh alerts', () => {
  const start = '2026-01-01T00:00:00Z', found = '2026-01-02T00:00:00Z';
  assert.equal(resetEligible('2025-12-31T23:59:00Z', found, start, 86_400_000), false);
  assert.equal(resetEligible(start, found, start, 86_400_000), true);
  assert.equal(resetEligible(start, found, start, 1), false);
  assert.equal(resetEligible(start, found, start, 86_400_000, start), false);
  assert.equal(resetEligible(start, found, start, 86_400_000, null), true);
});
test('retry policy is bounded, injectable and stops automatically at configured attempt limit', () => {
  assert.equal(retryDelay(config.retry, 1, 0.5), 30_000);
  assert.equal(retryDelay(config.retry, 5, 0.5), null);
  assert.throws(() => retryDelay(config.retry, 1, 1.1));
  assert.ok(retryDelay({ ...config.retry, maxDelayMs: 30_000 }, 4, 1)! <= 30_000);
});
test('wall-clock jumps do not move the monotonic clock backward', () => {
  const clock = new ManualClock(new Date('2026-01-01T00:00:00Z'));
  clock.advance(1000); clock.jumpWallClock(-10000);
  assert.equal(clock.monotonicMs(), 1000); assert.equal(clock.now().toISOString(), '2025-12-31T23:59:51.000Z');
});
test('runtime analysis validation rejects untyped malformed and fabricated exact-time output', () => {
  const post = { id: '1', targetId: 't', text: 'Limits reset tomorrow.', publishedAt: '2026-01-01T00:00:00Z', url: 'https://example.invalid' };
  const base = { summary: 'test', chatgptUpdates: [], reset: { evidence: post.text, whenText: 'tomorrow', timeZoneText: null } };
  for (const value of [null, { ...base, chatgptUpdates: [42] }, { ...base, reset: {} },
    { ...base, resetFinding: { kind: 'announcement', ...base.reset, normalizedAt: '2026-01-02T00:00:00Z', normalizationEvidence: 'tomorrow' } }])
    assert.throws(() => validateAnalysis(post, value));
});

test('timestamp validation rejects normalized impossible dates and timezone-less wall time', () => {
  assert.equal(isInstant('2026-02-31T00:00:00Z'), false);
  assert.equal(isInstant('2026-01-01T00:00:00'), false);
  assert.equal(isInstant('2024-02-29T00:00:00+08:00'), true);
  assert.equal(isInstant('2026-01-01T25:00:00Z'), false);
});

test('fixture pagination does not consume posts beyond the query boundary', async () => {
  const target = config.targets[0]!;
  const post = { id: 'future', targetId: target.id, text: 'future post', publishedAt: '2026-01-02T01:00:00Z', url: 'https://example.invalid/future' };
  const source = new FixtureSource([post]);
  const first = await source.fetch(target, null, { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
  assert.equal(first.posts.length, 0); assert.equal(first.nextCursor, '0');
  const second = await source.fetch(target, first.nextCursor, { from: '2026-01-02T00:00:00Z', to: '2026-01-02T02:00:00Z' });
  assert.equal(second.posts.length, 1);
});
