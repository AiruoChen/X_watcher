import type { RuntimeConfig } from './domain/model.js';
import { SourceFailure } from './domain/errors.js';
import { SystemClock } from './adapters/clock.js';
import { DeadlineContext, TimerWaiter } from './adapters/execution.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { Sha256Hasher } from './adapters/hash.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from './adapters/notification/preview-channel.js';
import { TextDigestRenderer } from './application/digest-renderer.js';
import { ProbeSource } from './application/probe-source.js';
import { createRuntimeApplication } from './bootstrap-runtime.js';
import { createXSource } from './bootstrap-x.js';

export async function probeX(config: RuntimeConfig, env: NodeJS.ProcessEnv): Promise<number> {
  const clock = new SystemClock();
  // At most one search page per target; failure cannot be mistaken for a completed query.
  const { source, client } = createXSource({ ...config, x: { ...config.x, maxPages: 1, pageSize: 10 } }, env, clock);
  console.log('Real X API read: charges may apply. Probe only; no database, model or mail operations.');
  let failed = false;
  const cancellation = new AbortController(), stop = (): void => cancellation.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    for (const target of config.targets) {
      if (cancellation.signal.aborted) { failed = true; break; }
      try { console.log(JSON.stringify(await new ProbeSource(source, clock, config).execute(target, new DeadlineContext(cancellation.signal)))); }
      catch (error) { failed = true; console.log(JSON.stringify({ targetId: target.id, status: 'failed', code: error instanceof SourceFailure ? error.code : 'source_failed' })); }
    }
    console.log(JSON.stringify({ requests: client.requestCount, mail: 'disabled', model: 'deferred' }));
    return failed ? 1 : 0;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

export async function previewX(config: RuntimeConfig, env: NodeJS.ProcessEnv, create: boolean, once: boolean): Promise<number> {
  const clock = new SystemClock(), { source, client } = createXSource(config, env, clock);
  let store: SqliteStore;
  try { store = new SqliteStore(config.storage.path, { create, claims: { clock } }); }
  catch { throw new Error('Cannot open preview database; create a separate new preview database explicitly with --create.'); }
  try {
    const waiter = new TimerWaiter(); let stop = (): void => undefined;
    const { host } = createRuntimeApplication(config, { store, clock, hasher: new Sha256Hasher(), sources: new Map([['x', source]]),
      analyzer: new FixtureAnalyzer(new Map()), notifications: new PreviewChannel(), rules: [], digestRenderer: new TextDigestRenderer(),
      events: { record: event => console.log(JSON.stringify(event)) }, lease: store.runtime, state: store.schedules,
      reconcile: revision => store.recoverAbandonedWork(revision),
      waiter: { wait: async (ms, signal) => {
        await waiter.wait(ms, signal);
        if (once && store.schedules.tasks().filter(task => task.stage === 'ingest' && config.targets.some(t => t.id === task.targetId))
          .every(task => task.state === 'needs_attention' || (task.state === 'idle' && task.finishedAt !== null))) stop();
      } } });
    stop = () => host.stop(); process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      console.log('Real X API preview: charges may apply. Persistent reads only; analysis deferred, mail/digest disabled. Ctrl+C to stop.');
      const result = await host.run();
      const tasks = store.schedules.tasks().filter(task => task.stage === 'ingest' && config.targets.some(t => t.id === task.targetId));
      console.log(JSON.stringify({ status: result.reason, requests: client.requestCount, mail: 'disabled', model: 'deferred',
        targets: tasks.map(task => ({ targetId: task.targetId, state: task.state, nextPollAt: task.dueAt, failureCode: task.failureCode ?? null })) }));
      return result.exitCode || (once && tasks.some(task => task.failures > 0 || task.state === 'needs_attention') ? 1 : 0);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  } finally { store.close(); }
}
