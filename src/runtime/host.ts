import type { Clock, ExecutionContext, RuntimeLeaseControl, RuntimeRecovery, Waiter } from '../domain/ports.js';
import type { RuntimeConfig, RuntimeOwnership } from '../domain/model.js';
import { WorkflowScheduler } from './workflow-scheduler.js';

export interface HostResult {
  readonly exitCode: 0 | 1 | 2;
  readonly reason: 'stopped' | 'already_running' | 'shutdown_timeout' | 'failed';
}
/** One foreground host per database. Waiting and deadlines use monotonic time. */
export class RuntimeHost {
  private readonly wake = new AbortController();
  private readonly cancellation = new AbortController();
  private requested = false;
  private started = false;
  constructor(private readonly config: RuntimeConfig, private readonly clock: Clock,
    private readonly lease: RuntimeLeaseControl, private readonly recovery: RuntimeRecovery,
    private readonly scheduler: WorkflowScheduler, private readonly waiter: Waiter,
    private readonly context: (signal: AbortSignal, canClaim: () => boolean) => ExecutionContext) {}
  stop(): void { this.requested = true; this.scheduler.stop(); this.wake.abort(); }
  async run(): Promise<HostResult> {
    if (this.started) throw new Error('A runtime host can only run once.');
    this.started = true;
    let ownership: RuntimeOwnership | null = null, nextRenewal = -Infinity;
    let result: HostResult = { exitCode: 0, reason: 'stopped' };
    const heartbeat = (): void => {
      if (ownership && this.clock.monotonicMs() >= nextRenewal) {
        ownership = this.lease.renew(ownership.revision, this.config.runtime.leaseMs);
        nextRenewal = this.clock.monotonicMs() + this.config.runtime.leaseMs / 3;
      }
    };
    try {
      ownership = this.lease.acquire(this.config.runtime.leaseMs);
      if (!ownership) return { exitCode: 1, reason: 'already_running' };
      nextRenewal = this.clock.monotonicMs() + this.config.runtime.leaseMs / 3;
      this.recovery.recover(ownership.revision); this.scheduler.initialize();
      const context = this.context(this.cancellation.signal, () => !this.requested);
      while (!this.requested) {
        heartbeat();
        if (this.scheduler.fatalError) throw new Error('Runtime persistence failed.');
        this.scheduler.pulse(context);
        if (this.scheduler.stopRequested) this.stop();
        await this.waiter.wait(this.config.runtime.wakeMs, this.wake.signal);
      }
      const deadline = this.clock.monotonicMs() + this.config.runtime.shutdownMs;
      const draining = new AbortController();
      while (this.scheduler.running) {
        heartbeat();
        if (this.clock.monotonicMs() >= deadline) {
          result = { exitCode: 2, reason: 'shutdown_timeout' }; this.cancellation.abort(); break;
        }
        await this.waiter.wait(Math.min(this.config.runtime.wakeMs, deadline - this.clock.monotonicMs()), draining.signal);
      }
    } catch { result = { exitCode: 1, reason: 'failed' }; this.cancellation.abort(); }
    finally {
      this.scheduler.stop();
      await this.scheduler.drain();
      if (this.scheduler.fatalError) result = { exitCode: 1, reason: 'failed' };
      if (ownership) {
        try { this.lease.release(ownership.revision); }
        catch { result = { exitCode: 1, reason: 'failed' }; } // Retain ownership if unresolved writes remain.
      }
    }
    return result;
  }
}
