import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { temporaryStorage, cleanupStorage } from './adapters/storage/temporary-directory.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { ManualClock } from './adapters/clock.js';
import { Sha256Hasher } from './adapters/hash.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from './adapters/notification/preview-channel.js';
import { TextDigestRenderer } from './application/digest-renderer.js';
import { ResetRule } from './application/rules/reset-rule.js';
import { createRuntimeApplication } from './bootstrap-runtime.js';
import { loadConfig } from './config.js';

const root = temporaryStorage(), path = join(root, 'runtime-demo.sqlite');
const config = loadConfig({ STORAGE_KIND: 'sqlite' }), clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
const target = config.targets[0]!, preview = new PreviewChannel();
const sample = { id: 'synthetic', targetId: target.id, publishedAt: '2026-01-01T12:00:00Z', text: 'Synthetic ChatGPT update.', url: 'https://example.invalid/fixture' };
let store: SqliteStore | undefined;
try {
  for (let pass = 0; pass < 2; pass++) {
    store = new SqliteStore(path, { create: pass === 0, claims: { clock } });
    let ticks = 0, stop = (): void => undefined;
    const app = createRuntimeApplication(config, { store, clock, hasher: new Sha256Hasher(),
      sources: new Map([['x', new FixtureSource([sample])]]),
      analyzer: new FixtureAnalyzer(new Map([[sample.id, { summary: 'Synthetic summary', chatgptUpdates: ['Synthetic update'], reset: null }]])),
      notifications: preview, rules: [new ResetRule()], digestRenderer: new TextDigestRenderer(), events: { record: () => undefined },
      lease: store.runtime, state: store.schedules, reconcile: revision => store!.recoverAbandonedWork(revision),
      waiter: { wait: async ms => { await immediate(); clock.advance(ms); if (++ticks === 6) stop(); } } });
    stop = () => app.host.stop(); assert.equal((await app.host.run()).exitCode, 0);
    assert.equal(store.runtime.current(), null); assert.equal(store.reports(target.id).length, 1);
    store.close(); store = undefined;
  }
  assert.equal(preview.list().length, 1);
  console.log('Runtime demo passed: start/stop/reopen, persistent schedules and one digest preview. No real requests or mail.');
} finally { store?.close(); cleanupStorage(root); }
