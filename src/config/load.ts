import type { RuntimeConfig } from '../domain/model.js';
import { CONFIG_SCHEMA, ConfigError } from './schema.js';
import { parseConfig } from './validate.js';

/** Local DB operations validate configuration without requiring online service secrets. */
export function loadLocalConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const input = Object.fromEntries(Object.keys(CONFIG_SCHEMA).filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  return parseConfig(input);
}
export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const config = loadLocalConfig(env);
  if (config.mode !== 'demo') {
    const services = config.mode === 'live' ? Object.values(config.services)
      : config.services.analysis.provider === 'deferred' ? [config.services.source] : [config.services.source, config.services.analysis];
    for (const service of services) {
      if (service === config.services.source && service.provider === 'rsshub') continue;
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
