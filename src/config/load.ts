import type { RuntimeConfig } from '../domain/model.js';
import { CONFIG_SCHEMA, ConfigError } from './schema.js';
import { parseConfig } from './validate.js';

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const input = Object.fromEntries(Object.keys(CONFIG_SCHEMA).filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const config = parseConfig(input);
  if (config.mode !== 'demo') {
    const services = config.mode === 'live' ? Object.values(config.services) : [config.services.source, config.services.analysis];
    for (const service of services) {
      if (!service.credentialEnv || !env[service.credentialEnv]?.trim()) throw new ConfigError('credential environment');
    }
  }
  return config;
}
/** Deliberately omit recipients, senders, filesystem paths, and secret references. */
export function describeConfig(config: RuntimeConfig): Readonly<Record<string, unknown>> {
  return { schemaVersion: config.schemaVersion, revision: config.revision, mode: config.mode,
    targets: config.targets.length, timeZone: config.timeZone, dailyDigestAt: config.dailyDigestAt,
    pollIntervalMs: config.pollIntervalMs, storage: config.storage.kind };
}
