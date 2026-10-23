import type { Clock } from './domain/ports.js';
import type { RuntimeConfig } from './domain/model.js';
import { XClient, type XTransport } from './adapters/source/x/client.js';
import { XSource } from './adapters/source/x/source.js';

export function createXSource(config: RuntimeConfig, env: NodeJS.ProcessEnv, clock: Clock, transport?: XTransport): {
  readonly source: XSource; readonly client: XClient;
} {
  if (config.mode !== 'preview' || config.storage.kind !== 'sqlite' || config.services.source.provider !== 'x-api-v2'
    || config.services.analysis.provider !== 'deferred') throw new Error('X read-only access requires preview, SQLite, x-api-v2 and deferred analysis.');
  const token = config.services.source.credentialEnv ? env[config.services.source.credentialEnv] : undefined;
  if (!token) throw new Error('X credential environment variable is missing.');
  const client = new XClient({ token, clock, timeoutMs: config.x.requestTimeoutMs, ...(transport ? { transport } : {}) });
  return { source: new XSource(client, clock, config.x), client };
}
