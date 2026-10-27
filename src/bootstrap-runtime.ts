import { randomUUID } from 'node:crypto';
import { BudgetController } from './application/budget.js';
import { ManageHealth } from './application/health.js';
import { limited } from './domain/policies/operations.js';
import type { RuntimeConfig } from './domain/model.js';
import type { CallGate, ExecutionContext, ReportRenderer, RuntimeJobs, RuntimeLeaseControl, RuntimeState, Waiter } from './domain/ports.js';
import { validateDependencies, type Dependencies } from './bootstrap.js';
import { IngestTarget } from './application/ingest-target.js';
import { ProcessAnalysis } from './application/process-analysis.js';
import { DeliverNotifications } from './application/deliver-notifications.js';
import { BuildReport } from './application/build-report.js';
import { ReportTextRenderer } from './application/report-renderer.js';
import { hasFreshReportCheck, latestReportDay, reportDueAt } from './domain/policies/reporting.js';
import { DueDigests } from './application/due-digests.js';
import { RecoverRuntime } from './application/recover-runtime.js';
import { WorkflowScheduler } from './runtime/workflow-scheduler.js';
import { RuntimeHost } from './runtime/host.js';
import { DeadlineContext, TimerWaiter } from './adapters/execution.js';

export interface RuntimeDependencies extends Dependencies {
  readonly reportRenderer?: ReportRenderer;
  readonly calls?: CallGate;
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
  validateDependencies(config, deps, true);
  if (config.storage.kind !== 'sqlite' || deps.store.durability !== 'persistent') throw new Error('Runtime requires persistent SQLite storage.');
  const ops = deps.store.operations;
  if (limited(config.budget) && (!ops || [...deps.sources.values()].some(source => source.capability === 'real' && !source.budgeted)))
    throw new Error('Configured budgets require persistent metering at each real source request.');
  const health = ops ? new ManageHealth(ops, deps.clock, config) : undefined;
  const calls = deps.calls ?? (ops ? new BudgetController(ops, deps.clock, config, randomUUID, health) : undefined);
  const analysis = new ProcessAnalysis(deps.analyzer, deps.store, deps.rules, deps.clock, config, calls);
  const delivery = new DeliverNotifications(deps.store, deps.notifications, deps.clock, calls);
  const digest = new BuildReport(deps.store, deps.hasher, deps.reportRenderer ?? new ReportTextRenderer(), config);
  const dueDigests = new DueDigests(deps.store, deps.clock, config, true);
  const reportCheckAt = (): string | null => {
    if (config.mode === 'preview') return null;
    return reportDueAt(latestReportDay(deps.clock.now(), config.timeZone, config.dailyDigestAt), config.timeZone, config.dailyDigestAt);
  };
  const jobs: RuntimeJobs = {
    ingest: async (target, context) => {
      const at = reportCheckAt(), windows = at ? dueDigests.execute(target) : [];
      const first = windows[0];
      const recheckFrom = at && first && !hasFreshReportCheck(deps.store.reportInputs(target.id, first), at) ? first.from : undefined;
      const before = deps.store.checkpoint(target.id).revision;
      let count: number;
      try { count = await new IngestTarget(deps.sources.get(target.provider)!, deps.store, deps.clock, config, deps.hasher, calls).execute(target, context, recheckFrom); }
      catch(error) { health?.failure('ingest',target.id,error); throw error; }
      if (deps.store.checkpoint(target.id).revision !== before) health?.observe('ingest',target.id,true,'source_failed');
      try { deps.events.record({ type: 'poll.completed', targetId: target.id, newPosts: count }); } catch { /* Non-authoritative. */ }
    },
    analyze: async (target, context) => {
      if (config.mode === 'preview') return;
      const pending = deps.store.pendingAnalysisJobs(target.id,deps.clock.now().toISOString(),1).length;
      try { await analysis.execute(target,context,config.runtime.batchSize);
        if (pending) { const attention = deps.store.analysisJobs(target.id).some(j => j.state === 'needs_attention');
          health?.observe('analysis',target.id,!attention,'analysis_deferred'); }
      } catch(error) { health?.failure('analysis',target.id,error); throw error; }
    },
    deliver: async context => {
      if (config.mode === 'preview') return;
      let results;
      try { results = await delivery.execute(context, config.services.mail.timeoutMs, config.runtime.batchSize); }
      catch(error) { health?.failure('delivery',null,error); throw error; }
      for (const item of results) {
        health?.observe('delivery',null,item.result.status === 'accepted',item.result.status === 'rejected' ? 'mail_rejected' : 'mail_unknown',1);
        try { deps.events.record({ type: 'notification.finished', id: item.id, status: item.result.status }); } catch { /* Non-authoritative. */ }
      }
    },
    digest: (target, window) => config.mode === 'preview' ? false : digest.execute(target, window, deps.clock.now().toISOString()),
    digestWindows: target => config.mode === 'preview' ? [] : dueDigests.execute(target),
    reportCheckAt,
    beforePulse: () => { const result = ops?.applyControls(deps.clock.now().toISOString()) ?? { stop:false }; if (!result.stop) health?.sweep(); return result; },
  };
  const scheduler = new WorkflowScheduler(config, deps.clock, deps.state, jobs, deps.events, deps.random);
  const recovery = new RecoverRuntime(deps.reconcile, deps.state, deps.clock);
  return { scheduler, host: new RuntimeHost(config, deps.clock, deps.lease, recovery, scheduler,
    deps.waiter ?? new TimerWaiter(), deps.context ?? ((signal, canClaim) => new DeadlineContext(signal, canClaim))) };
}
