import type { DigestWindow, ScheduledTask, WatchTarget } from '../model.js';

export interface RuntimeState {
  ensure(task: ScheduledTask): void;
  tasks(): readonly ScheduledTask[];
  claim(id: string, expectedRevision: number, now: string): ScheduledTask | null;
  finish(id: string, expectedRevision: number, dueAt: string, failed: boolean, exhausted: boolean, now: string,
    failure?: { readonly code: string; readonly retryAt: string | null }): void;
  /** Reconcile stage markers only; business claims must be reconciled separately. */
  recover(now: string): number;
}
/** External calls use monotonic deadlines, cooperative cancellation and late-result fencing. */
export interface ExecutionContext {
  readonly signal: AbortSignal;
  canClaim(): boolean;
  call<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T>;
}
export interface RuntimeJobs {
  ingest(target: WatchTarget, context: ExecutionContext): Promise<void>;
  analyze(target: WatchTarget, context: ExecutionContext): Promise<void>;
  deliver(context: ExecutionContext): Promise<void>;
  digest(target: WatchTarget, window: DigestWindow): boolean;
  digestWindows(target: WatchTarget): readonly DigestWindow[];
  /** Necessary daily source check, merged into the existing ingestion task. */
  reportCheckAt?(target: WatchTarget): string | null;
}
export interface RuntimeRecovery { recover(expectedRevision: number): void }
export interface Waiter { wait(ms: number, signal: AbortSignal): Promise<void> }
