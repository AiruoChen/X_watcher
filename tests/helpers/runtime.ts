import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import type { Waiter } from '../../src/domain/ports.js';
import { loadConfig } from '../../src/config.js';
import { ManualClock } from '../../src/adapters/clock.js';
import { SqliteStore } from '../../src/adapters/storage/sqlite/store.js';
import { Sha256Hasher } from '../../src/adapters/hash.js';
import { FixtureSource } from '../../src/adapters/source/fixture-source.js';
import { FixtureAnalyzer } from '../../src/adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from '../../src/adapters/notification/preview-channel.js';
import { TextDigestRenderer } from '../../src/application/digest-renderer.js';
import { ResetRule } from '../../src/application/rules/reset-rule.js';
import { createRuntimeApplication, type RuntimeDependencies } from '../../src/bootstrap-runtime.js';
import { DeadlineContext } from '../../src/adapters/execution.js';
import { temporaryStorage, cleanupStorage } from './storage.js';

export const flush = async (): Promise<void> => { await immediate(); await immediate(); };
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
export class StepWaiter implements Waiter {
  private pending: (() => void) | undefined;
  constructor(private readonly clock: ManualClock) {}
  wait(_ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = (): void => { signal.removeEventListener('abort', finish); this.pending = undefined; resolve(); };
      this.pending = finish; signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  async step(ms = 1000): Promise<void> { this.clock.advance(ms); this.pending?.(); await flush(); }
}
export function runtimeFixture(env: NodeJS.ProcessEnv = {}) {
  const root = temporaryStorage(), path = join(root, 'runtime.sqlite');
  const config = loadConfig({ STORAGE_KIND: 'sqlite', ...env });
  const clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
  const store = new SqliteStore(path, { create: true, claims: { clock, hostId: 'fixture-host', ownerId: 'first', pid: 111 } });
  const preview = new PreviewChannel(), waiter = new StepWaiter(clock), controller = new AbortController();
  const context = new DeadlineContext(controller.signal);
  const deps: RuntimeDependencies = { store, clock, hasher: new Sha256Hasher(), sources: new Map([['x', new FixtureSource([])]]),
    analyzer: new FixtureAnalyzer(new Map()), notifications: preview, rules: [new ResetRule()],
    digestRenderer: new TextDigestRenderer(), events: { record: () => undefined }, lease: store.runtime, state: store.schedules,
    reconcile: revision => store.recoverAbandonedWork(revision), waiter, random: () => 0.5 };
  const app = (overrides: Partial<RuntimeDependencies> = {}) => createRuntimeApplication(config, { ...deps, ...overrides });
  return { root, path, config, clock, store, preview, waiter, controller, context, deps, app,
    close: () => { store.close(); cleanupStorage(root); } };
}
