import type { RuntimeConfig } from '../../src/domain/model.js';
import { loadConfig } from '../../src/config.js';
import { ManualClock } from '../../src/adapters/clock.js';
import { XClient, type XTransport } from '../../src/adapters/source/x/client.js';
import { XSource } from '../../src/adapters/source/x/source.js';
import { author, page } from '../fixtures/x.js';

export const previewEnv = { APP_MODE: 'preview', STORAGE_KIND: 'sqlite', SOURCE_PROVIDER: 'x-api-v2',
  SOURCE_CREDENTIAL_ENV: 'SYNTHETIC_X_TOKEN', SYNTHETIC_X_TOKEN: 'synthetic-token-do-not-log', ANALYSIS_PROVIDER: 'deferred' };
export const query = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:30.000Z' };
export function xFixture(responses: readonly unknown[] = [page()], overrides: Partial<RuntimeConfig['x']> = {}) {
  const config = loadConfig(previewEnv), clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
  const requests: { url: URL; init: RequestInit }[] = [], queue = [...responses];
  let user: unknown = author;
  const transport: XTransport = async (url, init) => {
    requests.push({ url, init });
    const value = url.pathname.startsWith('/2/users/') ? user : queue.shift() ?? page();
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const client = new XClient({ token: previewEnv.SYNTHETIC_X_TOKEN, clock, timeoutMs: 100, transport });
  const source = new XSource(client, clock, { ...config.x, ...overrides });
  return { config: { ...config, x: { ...config.x, ...overrides } }, clock, client, source, requests,
    target: config.targets[0]!, changeUser: (value: unknown) => { user = value; } };
}
