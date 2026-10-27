import type { RuntimeConfig } from './domain/model.js';
import type { ExecutionContext, RuntimeJobs, RuntimeLeaseControl, RuntimeState, Waiter } from './domain/ports.js';
import { validateDependencies, type Dependencies } from './bootstrap.js';
import { IngestTarget } from './application/ingest-target.js';
import { ProcessAnalysis } from './application/process-analysis.js';
import { DeliverNotifications } from './application/deliver-notifications.js';
import { DailyDigest } from './application/daily-digest.js';
import { DueDigests } from './application/due-digests.js';
import { RecoverRuntime } from './application/recover-runtime.js';
import { WorkflowScheduler } from './runtime/workflow-scheduler.js';
import { RuntimeHost } from './runtime/host.js';
import { DeadlineContext, TimerWaiter } from './adapters/execution.js';

export interface RuntimeDependencies extends Dependencies {
  readonly lease: RuntimeLeaseControl;
  readonly state: RuntimeState;
  readonly reconcile: (revision: number) => unknown;
  readonly waiter?: Waiter;
  readonly context?: (signal: AbortSignal, canClaim: () => boolean) => ExecutionContext;
  readonly random?: () => number;
}
export function createRuntimeApplication(config: RuntimeConfig, deps: RuntimeDependencies): {
  readonly host: RuntimeHost; readonly scheduler: WorkflowScheduler;
} {
  validateDependencies(config, deps);
  if (config.storage.kind !== 'sqlite' || deps.store.durability !== 'persistent') throw new Error('Runtime requires persistent SQLite storage.');
  const analysis = new ProcessAnalysis(deps.analyzer, deps.store, deps.rules, deps.clock, config);
  const delivery = new DeliverNotifications(deps.store, deps.notifications, deps.clock);
  const digest = new DailyDigest(deps.store, deps.digestRenderer, config.recipient, deps.hasher, config.timeZone, config.revision);
  const dueDigests = new DueDigests(deps.store, deps.clock, config);
  const jobs: RuntimeJobs = {
    ingest: async (target, context) => {
      const count = await new IngestTarget(deps.sources.get(target.provider)!, deps.store, deps.clock, config, deps.hasher).execute(target, context);
      try { deps.events.record({ type: 'poll.completed', targetId: target.id, newPosts: count }); } catch { /* Non-authoritative. */ }
    },
    analyze: (target, context) => analysis.execute(target, context, config.runtime.batchSize),
    deliver: async context => {
      for (const item of await delivery.execute(context, config.services.mail.timeoutMs, config.runtime.batchSize)) {
        try { deps.events.record({ type: 'notification.finished', id: item.id, status: item.result.status }); } catch { /* Non-authoritative. */ }
      }
    },
    digest: (target, window) => digest.execute(target, window, deps.clock.now().toISOString()),
    digestWindows: target => dueDigests.execute(target),
  };
  const scheduler = new WorkflowScheduler(config, deps.clock, deps.state, jobs, deps.events, deps.random);
  const recovery = new RecoverRuntime(deps.reconcile, deps.state, deps.clock);
  return { scheduler, host: new RuntimeHost(config, deps.clock, deps.lease, recovery, scheduler,
    deps.waiter ?? new TimerWaiter(), deps.context ?? ((signal, canClaim) => new DeadlineContext(signal, canClaim))) };
}
