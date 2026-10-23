import type { RuntimeConfig } from './domain/model.js';
import { SystemClock } from './adapters/clock.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { Sha256Hasher } from './adapters/hash.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from './adapters/notification/preview-channel.js';
import { TextDigestRenderer } from './application/digest-renderer.js';
import { ResetRule } from './application/rules/reset-rule.js';
import { createRuntimeApplication } from './bootstrap-runtime.js';

/** Foreground, persistent, simulated host. No real X, model or email adapters are selected here. */
export async function watch(config: RuntimeConfig, create: boolean): Promise<number> {
  if (config.mode !== 'demo' || config.storage.kind !== 'sqlite') throw new Error('watch requires APP_MODE=demo and STORAGE_KIND=sqlite.');
  const clock = new SystemClock();
  let store: SqliteStore;
  try { store = new SqliteStore(config.storage.path, { create, claims: { clock } }); }
  catch { throw new Error('Cannot open runtime database. For a new database use watch --create; existing invalid data is never replaced.'); }
  try {
    const { host } = createRuntimeApplication(config, { store, clock, hasher: new Sha256Hasher(),
      sources: new Map([['x', new FixtureSource([])]]), analyzer: new FixtureAnalyzer(new Map()), notifications: new PreviewChannel(),
      rules: [new ResetRule()], digestRenderer: new TextDigestRenderer(), events: { record: event => console.log(JSON.stringify(event)) },
      lease: store.runtime, state: store.schedules, reconcile: revision => store.recoverAbandonedWork(revision) });
    const stop = (): void => host.stop();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      console.log('Simulated foreground runtime: persistent SQLite, empty fixture source, preview only. Ctrl+C to stop.');
      const result = await host.run(); console.log(`Runtime stopped: ${result.reason}`); return result.exitCode;
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  } finally { store.close(); }
}
