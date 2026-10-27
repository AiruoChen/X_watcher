import type { Clock, OperationsStore } from '../domain/ports.js';
import type { MeteredService, RuntimeConfig, RuntimeStage } from '../domain/model.js';
import { HEALTH_CODES } from '../domain/policies/operations.js';
import { BudgetExceeded, SourceFailure } from '../domain/errors.js';
export class ManageHealth {
  constructor(private readonly store: OperationsStore, private readonly clock: Clock, private readonly config: RuntimeConfig) {}
  observe(stage: RuntimeStage | 'budget', targetId: string | null, success: boolean, code: string, threshold = this.config.policy.failureThreshold, stale = false): void {
    this.store.recordHealth({ key: stage + ':' + (targetId ?? 'all'), stage, targetId, success, code, threshold, stale,
      at: this.clock.now().toISOString(), notify: this.config.mode !== 'preview', recipient: this.config.recipient, configRevision: this.config.revision });
  }
  failure(stage: RuntimeStage, targetId: string | null, error: unknown): void {
    if (error instanceof BudgetExceeded) return;
    this.observe(stage, targetId, false, error instanceof SourceFailure && HEALTH_CODES.includes(error.code) ? error.code
      : stage === 'analysis' ? 'analysis_failed' : stage === 'delivery' ? 'mail_unknown' : 'source_failed',
      error instanceof SourceFailure && !error.retryable ? 1 : this.config.policy.failureThreshold);
  }
  budget(service: MeteredService, success: boolean): void {
    const old = this.store.health().find(h => h.key === 'budget:' + service);
    if (success && (!old || old.code === null)) return;
    this.store.recordHealth({ key: 'budget:' + service, stage: 'budget', targetId: null, success, code: 'budget_exhausted', threshold: 1,
      at: this.clock.now().toISOString(), notify: this.config.mode !== 'preview', recipient: this.config.recipient, configRevision: this.config.revision });
  }
  sweep(): void {
    const health = this.store.health();
    for (const target of this.config.targets) {
      const old = health.find(h => h.key === 'ingest:' + target.id);
      if (old && this.clock.now().getTime() - Date.parse(old.lastSuccessAt ?? old.lastAttemptAt) >= this.config.policy.staleAfterMs && old.code !== 'stale')
        this.observe('ingest', target.id, false, 'stale', this.config.policy.failureThreshold, true);
    }
  }
}
