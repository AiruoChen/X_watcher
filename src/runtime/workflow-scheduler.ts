import type { Clock, EventSink, ExecutionContext, RuntimeJobs, RuntimeState } from '../domain/ports.js';
import type { RuntimeConfig, ScheduledTask } from '../domain/model.js';
import { stableId } from '../domain/identifiers.js';
import { retryDelay } from '../domain/policies/retry.js';

/** Persistent stages, with a separate concurrency allowance for each stage. No SDKs or timers. */
export class WorkflowScheduler {
  private accepting = true;
  private readonly active = new Map<string, { stage: ScheduledTask['stage']; promise: Promise<void> }>();
  private readonly deadlines = new Map<string, { revision: number; at: number }>();
  private readonly ids = new Set<string>();
  private cursor = 0;
  private digestEmails = 0;
  private failure: unknown;
  constructor(private readonly config: RuntimeConfig, private readonly clock: Clock,
    private readonly state: RuntimeState, private readonly jobs: RuntimeJobs, private readonly events: EventSink,
    private readonly random: () => number = Math.random) {}
  initialize(): void {
    const make = (stage: ScheduledTask['stage'], targetId: string | null): void => {
      const id = stableId('schedule', stage, targetId ?? 'all'); this.ids.add(id);
      this.state.ensure({ id, stage, targetId, configRevision: this.config.revision, revision: 0, state: 'idle',
        dueAt: this.clock.now().toISOString(), failures: 0, startedAt: null, finishedAt: null });
    };
    make('delivery', null);
    for (const target of this.config.targets) {
      make('ingest', target.id); make('analysis', target.id); make('digest', target.id);
    }
  }
  stop(): void { this.accepting = false; }
  get running(): number { return this.active.size; }
  get fatalError(): unknown { return this.failure; }
  async drain(): Promise<void> { await Promise.all([...this.active.values()].map(item => item.promise)); }
  private interval(task: ScheduledTask): number {
    return task.stage === 'ingest' ? this.config.pollIntervalMs : this.config.runtime.wakeMs;
  }
  pulse(context: ExecutionContext): void {
    if (!this.accepting || context.signal.aborted || this.failure) return;
    this.digestEmails = 0;
    const tasks = this.state.tasks().filter(task => this.ids.has(task.id));
    const capacity = Math.max(1, Math.floor(this.config.runtime.maxConcurrent / 4));
    const start = this.cursor;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[(start + i) % tasks.length]!;
      if (task.state !== 'idle' || this.active.has(task.id)
        || [...this.active.values()].filter(item => item.stage === task.stage).length >= capacity) continue;
      let deadline = this.deadlines.get(task.id);
      if (deadline?.revision !== task.revision) {
        // On restart, cap future waits: a backwards wall-clock correction cannot suspend polling for days.
        const wait = Math.min(Math.max(0, Date.parse(task.dueAt) - this.clock.now().getTime()),
          Math.max(this.interval(task), this.config.retry.maxDelayMs));
        deadline = { revision: task.revision, at: this.clock.monotonicMs() + wait }; this.deadlines.set(task.id, deadline);
      }
      if (this.clock.monotonicMs() < deadline.at) continue;
      const claimed = this.state.claim(task.id, task.revision, this.clock.now().toISOString());
      if (!claimed) continue;
      const promise = this.execute(claimed, context).catch(error => { this.failure = error; this.stop(); })
        .finally(() => { this.active.delete(task.id); });
      this.active.set(task.id, { stage: task.stage, promise });
    }
    if (tasks.length) this.cursor = (start + 1) % tasks.length;
  }
  private async execute(task: ScheduledTask, context: ExecutionContext): Promise<void> {
    let failed = false;
    try {
      context.signal.throwIfAborted();
      const target = this.config.targets.find(item => item.id === task.targetId);
      if (task.stage === 'delivery') await this.jobs.deliver(context);
      else if (!target) throw new Error('Missing runtime target.');
      else if (task.stage === 'ingest') await this.jobs.ingest(target, context);
      else if (task.stage === 'analysis') await this.jobs.analyze(target, context);
      else for (const window of this.jobs.digestWindows(target)) {
        if (this.digestEmails >= this.config.policy.maxCatchUpEmailsPerCycle) break;
        if (this.jobs.digest(target, window)) this.digestEmails++;
      }
    } catch {
      failed = true;
      try { this.events.record({ type: 'cycle.failed', stage: task.stage }); } catch { /* State is authoritative. */ }
    }
    const retry = failed ? retryDelay(this.config.retry, task.failures + 1, this.random()) : null;
    // Analysis jobs own their retry exhaustion; their scheduler must continue serving new jobs.
    const exhausted = failed && task.stage === 'ingest' && retry === null;
    const delay = failed && task.stage !== 'analysis' ? retry ?? this.config.retry.maxDelayMs : this.interval(task);
    const now = this.clock.now().toISOString();
    this.state.finish(task.id, task.revision, new Date(Date.parse(now) + delay).toISOString(), failed, exhausted, now);
    this.deadlines.set(task.id, { revision: task.revision + 1, at: this.clock.monotonicMs() + delay });
  }
}
