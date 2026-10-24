import type { Clock, PostSource } from './domain/ports.js';
import type { RuntimeConfig } from './domain/model.js';
import { createXSource } from './bootstrap-x.js';
import { RsshubClient } from './adapters/source/rsshub/client.js';
import { RsshubSource } from './adapters/source/rsshub/source.js';

export type SourceTransport = (url: URL, init: RequestInit) => Promise<Response>;
export interface ReadonlySource { readonly source: PostSource; readonly client: { readonly requestCount: number } }
export function createReadonlySource(config: RuntimeConfig, env: NodeJS.ProcessEnv, clock: Clock, transport?: SourceTransport): ReadonlySource {
  if (config.services.source.provider !== 'rsshub') return createXSource(config, env, clock, transport);
  if (config.mode !== 'preview' || config.storage.kind !== 'sqlite' || config.services.analysis.provider !== 'deferred')
    throw new Error('RSSHub read-only access requires preview, SQLite and deferred analysis.');
  const client = new RsshubClient(config.rsshub, clock, transport);
  return { source: new RsshubSource(client, clock, config.rsshub), client };
}
