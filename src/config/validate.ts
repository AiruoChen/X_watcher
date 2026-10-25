import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../domain/model.js';
import { CONFIG_SCHEMA, ConfigError, type ConfigField } from './schema.js';

export function parseConfig(input: unknown): RuntimeConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new ConfigError('config');
  const data = input as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!Object.hasOwn(CONFIG_SCHEMA, key)) throw new ConfigError('unknown field');
  const text = (key: ConfigField): string => {
    const value = data[key] === undefined ? CONFIG_SCHEMA[key] : data[key];
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new ConfigError(key);
    return value.trim();
  };
  const number = (key: ConfigField, min: number, max: number, integer = true): number => {
    const raw = text(key);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new ConfigError(key);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new ConfigError(key);
    return value;
  };
  const optional = (key: ConfigField): string | null => text(key) || null;
  const ref = (key: ConfigField): string | null => {
    const value = optional(key);
    if (value !== null && !/^[A-Z][A-Z0-9_]*$/.test(value)) throw new ConfigError(key);
    return value;
  };
  if (text('CONFIG_SCHEMA_VERSION') !== '1') throw new ConfigError('CONFIG_SCHEMA_VERSION');
  const mode = text('APP_MODE');
  if (mode !== 'demo' && mode !== 'preview' && mode !== 'live') throw new ConfigError('APP_MODE');
  const handles = text('WATCH_HANDLES').split(',').map(s => s.trim().replace(/^@/, ''));
  if (handles.some(h => !/^[a-zA-Z0-9_]{1,15}$/.test(h)) || new Set(handles.map(h => h.toLowerCase())).size !== handles.length)
    throw new ConfigError('WATCH_HANDLES');
  const zone = text('TIME_ZONE');
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(new Date(0)); } catch { throw new ConfigError('TIME_ZONE'); }
  const at = text('DAILY_DIGEST_AT');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new ConfigError('DAILY_DIGEST_AT');
  const email = (key: ConfigField): string => {
    const value = text(key);
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) throw new ConfigError(key);
    return value;
  };
  const recipient = email('NOTIFICATION_TO');
  const kind = text('STORAGE_KIND');
  if (kind !== 'memory' && kind !== 'sqlite') throw new ConfigError('STORAGE_KIND');
  if (!text('DATABASE_PATH')) throw new ConfigError('DATABASE_PATH');
  const retry = { maxAttempts: number('RETRY_MAX_ATTEMPTS', 1, 100), baseDelayMs: number('RETRY_BASE_SECONDS', 1, 86400) * 1000,
    maxDelayMs: number('RETRY_MAX_SECONDS', 1, 86400) * 1000, jitterRatio: number('RETRY_JITTER', 0, 1, false) };
  if (retry.maxDelayMs < retry.baseDelayMs) throw new ConfigError('RETRY_MAX_SECONDS');
  const runtime = { wakeMs: number('RUNTIME_WAKE_MS', 10, 10000), leaseMs: number('RUNTIME_LEASE_SECONDS', 3, 3600) * 1000,
    shutdownMs: number('RUNTIME_SHUTDOWN_SECONDS', 1, 300) * 1000,
    maxConcurrent: number('RUNTIME_MAX_CONCURRENT', 4, 100), batchSize: number('RUNTIME_BATCH_SIZE', 1, 1000) };
  if (runtime.wakeMs * 3 > runtime.leaseMs) throw new ConfigError('RUNTIME_LEASE_SECONDS');
  const policy = { initialBackfillDays: number('INITIAL_BACKFILL_DAYS', 1, 365), resetMaxAgeMs: number('RESET_MAX_AGE_HOURS', 1, 8760) * 3_600_000,
    digestCatchUpDays: number('DIGEST_CATCH_UP_DAYS', 1, 365), maxCatchUpEmailsPerCycle: number('MAX_CATCH_UP_EMAILS', 1, 100),
    digestGraceMinutes: number('DIGEST_GRACE_MINUTES', 0, 60), failureThreshold: number('FAILURE_THRESHOLD', 1, 100),
    staleAfterMs: number('STALE_AFTER_MINUTES', 1, 10080) * 60_000,
    postRetentionDays: number('POST_RETENTION_DAYS', 1, 3650), auditRetentionDays: number('AUDIT_RETENTION_DAYS', 1, 3650) };
  if (policy.postRetentionDays < Math.max(policy.initialBackfillDays, policy.digestCatchUpDays + 1, policy.resetMaxAgeMs / 86_400_000))
    throw new ConfigError('POST_RETENTION_DAYS');
  if (policy.auditRetentionDays < policy.postRetentionDays) throw new ConfigError('AUDIT_RETENTION_DAYS');
  const services = {
    source: { provider: optional('SOURCE_PROVIDER'), credentialEnv: ref('SOURCE_CREDENTIAL_ENV'), timeoutMs: number('SOURCE_TIMEOUT_SECONDS', 1, 3600) * 1000 },
    analysis: { provider: optional('ANALYSIS_PROVIDER'), credentialEnv: ref('ANALYSIS_CREDENTIAL_ENV'), timeoutMs: number('ANALYSIS_TIMEOUT_SECONDS', 1, 3600) * 1000,
      model: optional('ANALYSIS_MODEL'), version: text('ANALYZER_VERSION'), promptVersion: text('PROMPT_VERSION') },
    mail: { provider: optional('MAIL_PROVIDER'), credentialEnv: ref('MAIL_CREDENTIAL_ENV'), timeoutMs: number('MAIL_TIMEOUT_SECONDS', 1, 3600) * 1000, from: optional('MAIL_FROM') },
  };
  if (!services.analysis.version || !services.analysis.promptVersion) throw new ConfigError('ANALYZER_VERSION/PROMPT_VERSION');
  const dialect = text('X_FIELD_DIALECT');
  if (dialect !== 'post' && dialect !== 'tweet') throw new ConfigError('X_FIELD_DIALECT');
  const x: RuntimeConfig['x'] = { maxPages: number('X_MAX_PAGES', 1, 100), pageSize: number('X_PAGE_SIZE', 10, 100),
    requestTimeoutMs: number('X_REQUEST_TIMEOUT_SECONDS', 1, 300) * 1000,
    safetyLagMs: number('X_SAFETY_LAG_SECONDS', 10, 3600) * 1000, overlapMs: number('X_OVERLAP_SECONDS', 0, 3600) * 1000,
    fieldDialect: dialect };
  let rsshubBase: URL;
  try { rsshubBase = new URL(text('RSSHUB_BASE_URL')); } catch { throw new ConfigError('RSSHUB_BASE_URL'); }
  if (!['http:', 'https:'].includes(rsshubBase.protocol) || rsshubBase.username || rsshubBase.password
    || rsshubBase.search || rsshubBase.hash || /%(?:2f|5c|2e)/i.test(rsshubBase.pathname)
    || (rsshubBase.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(rsshubBase.hostname)))
    throw new ConfigError('RSSHUB_BASE_URL');
  const rsshub: RuntimeConfig['rsshub'] = { baseUrl: rsshubBase.href.replace(/\/$/, ''),
    itemLimit: number('RSSHUB_ITEM_LIMIT', 1, 200), requestTimeoutMs: number('RSSHUB_REQUEST_TIMEOUT_SECONDS', 1, 300) * 1000,
    overlapMs: number('RSSHUB_OVERLAP_HOURS', 1, 2160) * 3_600_000,
    safetyLagMs: number('RSSHUB_SAFETY_LAG_SECONDS', 0, 3600) * 1000 };
  if (services.source.provider === 'rsshub' && services.source.credentialEnv !== null) throw new ConfigError('SOURCE_CREDENTIAL_ENV');
  if (services.source.provider === 'rsshub' && services.source.timeoutMs < rsshub.requestTimeoutMs) throw new ConfigError('SOURCE_TIMEOUT_SECONDS');
  if (services.mail.from !== null) email('MAIL_FROM');
  if (mode !== 'demo') {
    for (const key of ['SOURCE_PROVIDER','ANALYSIS_PROVIDER'] as const)
      if (!optional(key)) throw new ConfigError(key);
    if (services.source.provider !== 'rsshub' && !services.source.credentialEnv) throw new ConfigError('SOURCE_CREDENTIAL_ENV');
    if (!(mode === 'preview' && services.analysis.provider === 'deferred')) {
      for (const key of ['ANALYSIS_CREDENTIAL_ENV','ANALYSIS_MODEL'] as const) if (!optional(key)) throw new ConfigError(key);
    } else if (services.analysis.credentialEnv || services.analysis.model) throw new ConfigError('ANALYSIS_PROVIDER');
    if (kind !== 'sqlite') throw new ConfigError('STORAGE_KIND');
  }
  if (mode === 'live') {
    for (const key of ['MAIL_PROVIDER','MAIL_CREDENTIAL_ENV','MAIL_FROM','NOTIFICATION_TO'] as const)
      if (!data[key] || !optional(key)) throw new ConfigError(key);
    if (recipient.toLowerCase().endsWith('.invalid')) throw new ConfigError('NOTIFICATION_TO');
  }
  if (!['true','false'].includes(text('ANALYSIS_ALLOW_PARTIAL'))) throw new ConfigError('ANALYSIS_ALLOW_PARTIAL');
  const callLimit = (key: ConfigField): number | null => optional(key) === null ? null : number(key, 1, 1e9);
  const unit = (key: ConfigField): number | null => {
    const raw = optional(key); if (raw === null) return null;
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) throw new ConfigError(key);
    const [whole,fraction=''] = raw.split('.');
    const micros = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6,'0'));
    if (micros > 1000000000000000n) throw new ConfigError(key);
    return Number(micros);
  };
  const unitMicros = { source: unit('SOURCE_MAX_COST_PER_CALL'), analysis: unit('ANALYSIS_MAX_COST_PER_CALL'), mail: unit('MAIL_MAX_COST_PER_CALL') };
  const currency = optional('BUDGET_CURRENCY'), priceReference = optional('BUDGET_PRICE_REFERENCE');
  if (Object.values(unitMicros).some(v => v !== null) && (!currency || !/^[A-Z]{3}$/.test(currency) || !priceReference)) throw new ConfigError('BUDGET_PRICE_REFERENCE/CURRENCY');
  if (priceReference && priceReference.length > 500) throw new ConfigError('BUDGET_PRICE_REFERENCE');
  for (const key of ['RETENTION_TERMS_REVIEWED','AUTO_CLEANUP'] as const) if (!['true','false'].includes(text(key))) throw new ConfigError(key);
  if (text('AUTO_CLEANUP') === 'true') throw new ConfigError('AUTO_CLEANUP: only stopped-runtime manual cleanup is supported');
  const config: Omit<RuntimeConfig, 'revision'> = { schemaVersion: 1, mode,
    targets: handles.map(handle => services.source.provider === 'rsshub'
      ? { id: `rsshub-x:${handle.toLowerCase()}`, provider: 'rsshub-x', handle }
      : { id: `x:${handle.toLowerCase()}`, provider: 'x', handle }),
    pollIntervalMs: number('POLL_INTERVAL_MINUTES', 1, 1440) * 60_000, timeZone: zone, dailyDigestAt: at,
    recipient, storage: { kind, path: text('DATABASE_PATH') }, retry, runtime, x, rsshub, policy, services,
    analysisPolicy: { allowPartial: text('ANALYSIS_ALLOW_PARTIAL') === 'true' },
    mailPolicy: { account: optional('MAIL_ACCOUNT'), idempotencyTtlMs: number('MAIL_IDEMPOTENCY_TTL_SECONDS', 0, 604800) * 1000,
      maxAttempts: number('MAIL_MAX_ATTEMPTS', 1, 100) },
    budget: { maxCallsPerDay: optional('MAX_CALLS_PER_DAY') === null ? null : number('MAX_CALLS_PER_DAY', 1, 1e9),
      maxCostPerDay: optional('MAX_COST_PER_DAY') === null ? null : number('MAX_COST_PER_DAY', 0.01, 1e9, false), maxCostMicros: unit('MAX_COST_PER_DAY'),
      serviceCalls: { source: callLimit('MAX_SOURCE_CALLS_PER_DAY'), analysis: callLimit('MAX_ANALYSIS_CALLS_PER_DAY'), mail: callLimit('MAX_MAIL_CALLS_PER_DAY') },
      unitMicros, currency, priceReference },
    operations: { retentionTermsReviewed: text('RETENTION_TERMS_REVIEWED') === 'true', autoCleanup: false } };
  return { ...config, revision: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}
