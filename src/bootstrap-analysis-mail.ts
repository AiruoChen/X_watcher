import type { RuntimeConfig } from './domain/model.js';
import type { Clock, ContentHasher, StructuredModel } from './domain/ports.js';
import type { MailTransport } from './domain/ports/mail.js';
import { StructuredAnalyzer } from './adapters/analysis/structured-analyzer.js';
import { EmailChannel } from './adapters/notification/email/channel.js';
export function createAnalysisModule(config: RuntimeConfig, client: StructuredModel, hasher: ContentHasher): StructuredAnalyzer {
  if (config.mode === 'demo' && client.capability !== 'simulated') throw new Error('Demo requires simulated analysis.');
  if (!config.services.analysis.model || !config.services.analysis.provider || config.services.analysis.provider === 'deferred') throw new Error('Explicit analysis model and provider required.');
  return new StructuredAnalyzer(client, hasher, { model: config.services.analysis.model, version: config.services.analysis.version,
    promptVersion: config.services.analysis.promptVersion, allowPartial: config.analysisPolicy.allowPartial });
}
export function createMailModule(config: RuntimeConfig, client: MailTransport, clock: Clock, hasher: ContentHasher): EmailChannel {
  if (client.capability === 'real' && config.mode !== 'live') throw new Error('Demo/preview cannot send real mail.');
  if (!config.services.mail.from || config.services.mail.provider !== client.provider || config.mailPolicy.account !== client.account)
    throw new Error('Mail provider/account/from must match the configured transport.');
  return new EmailChannel(client, clock, hasher, { from: config.services.mail.from,
    idempotencyTtlMs: config.mailPolicy.idempotencyTtlMs, maxAttempts: config.mailPolicy.maxAttempts });
}
