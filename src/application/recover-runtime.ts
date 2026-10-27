import type { Clock, RuntimeRecovery, RuntimeState } from '../domain/ports.js';

export class RecoverRuntime implements RuntimeRecovery {
  constructor(private readonly reconcile: (revision: number) => unknown,
    private readonly state: RuntimeState, private readonly clock: Clock) {}
  recover(expectedRevision: number): void {
    // Quarantine abandoned business claims before making stage triggers runnable again.
    this.reconcile(expectedRevision); this.state.recover(this.clock.now().toISOString());
  }
}
