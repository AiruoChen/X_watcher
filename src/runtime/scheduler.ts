import type { Clock, EventSink, WatchJobs, WatchStore } from '../domain/ports.js';
import type { AppEvent, RuntimeConfig } from '../domain/model.js';
import { dueDigestWindow } from '../domain/time.js';

/** Host calls tick periodically. This class owns no timer, network client, or provider SDK. */
export class Scheduler {
  private active: Promise<void> | undefined;
  private readonly lastAttempt = new Map<string, number>();
  constructor(private readonly config: RuntimeConfig, private readonly clock: Clock,
    private readonly store: WatchStore, private readonly jobs: WatchJobs, private readonly events: EventSink) {}

  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }
  private record(event: AppEvent): void {
    try { this.events.record(event); } catch { /* Observability must not change delivery state. */ }
  }
  private async run(): Promise<void> {
    for (const target of this.config.targets) {
      const now = this.clock.now();
      const checkpoint = this.store.checkpoint(target.id);
      const last = this.lastAttempt.get(target.id)
        ?? (checkpoint.observedAt ? Date.parse(checkpoint.observedAt) : -Infinity);
      if (now.getTime() - last >= this.config.pollIntervalMs) {
        this.lastAttempt.set(target.id, now.getTime());
        try {
          const newPosts = await this.jobs.poll(target);
          this.record({ type: 'poll.completed', targetId: target.id, newPosts });
        } catch { this.record({ type: 'cycle.failed', stage: `poll:${target.id}` }); }
      }
      // Reset notifications are dispatched before any daily digest work.
      await this.deliver();
      const window = dueDigestWindow(this.clock.now(), this.config.timeZone, this.config.dailyDigestAt);
      if (window) {
        try { this.jobs.digest(target, window); }
        catch { this.record({ type: 'cycle.failed', stage: `digest:${target.id}` }); }
      }
    }
    await this.deliver();
  }
  private async deliver(): Promise<void> {
    try {
      for (const result of await this.jobs.deliver()) {
        this.record({ type: 'notification.finished', id: result.id, status: result.result.status });
      }
    } catch { this.record({ type: 'cycle.failed', stage: 'delivery' }); }
  }
}
