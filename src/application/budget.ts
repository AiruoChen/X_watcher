import type { CallGate, CallPermit, Clock, OperationsStore } from '../domain/ports.js';
import type { MeteredService, RuntimeConfig, TokenUsage } from '../domain/model.js';
import { BudgetExceeded, UsageFailure } from '../domain/errors.js';
import { budgetReset, localDay } from '../domain/policies/operations.js';
import { ManageHealth } from './health.js';
/** A durable reservation precedes invocation/claim; crashed reservations remain consumed. */
export class BudgetController implements CallGate {
  private sequence = 0;
  constructor(private readonly store: OperationsStore, private readonly clock: Clock, private readonly config: RuntimeConfig,
    private readonly identity: () => string, private readonly health = new ManageHealth(store, clock, config)) {}
  reserve(service: MeteredService): CallPermit {
    const now = this.clock.now(), id = this.identity() + ':' + ++this.sequence;
    const decision = this.store.reserveUsage({ id, service, day: localDay(now, this.config.timeZone), at: now.toISOString(), configRevision: this.config.revision, policy: this.config.budget });
    if (!decision.allowed) {
      this.health.budget(service, false);
      throw new BudgetExceeded(service, budgetReset(decision.day, this.config.timeZone), decision.reason);
    }
    this.health.budget(service, true);
    let invoked = false, cancelled = false;
    return {
      cancel: () => { if (invoked || cancelled) throw new Error('Only an unstarted call may be cancelled.'); this.store.cancelUsage(id); cancelled = true; },
      run: async <T>(operation: () => Promise<T>, usage?: (value: T) => TokenUsage | undefined): Promise<T> => {
        if (invoked || cancelled) throw new Error('Usage permit is single-use.');
        invoked = true; this.store.startUsage(id);
        let completed = false;
        try { const result = await operation(); completed = true; this.store.finishUsage(id, true, usage?.(result)); return result; }
        catch (error) { if (!completed) this.store.finishUsage(id, false, error instanceof UsageFailure ? error.usage : undefined); throw error; }
      },
    };
  }
}
