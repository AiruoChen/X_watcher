import type {
  Analysis, AnalyzedPost, AppEvent, Checkpoint, DeliveryResult, DigestWindow,
  Notification, OutboxEntry, Post, PostBatch, WatchTarget,
  SourceQuery,
} from '../model.js';

export interface Clock { now(): Date; monotonicMs(): number }
export interface PostSource {
  readonly capability: 'simulated' | 'real';
  readonly budgeted?: boolean;
  resolve?(target: WatchTarget, signal?: AbortSignal): Promise<import('../model.js').ResolvedAuthor>;
  fetch(target: WatchTarget, cursor: string | null, query?: SourceQuery, signal?: AbortSignal): Promise<PostBatch>;
}
export interface ContentAnalyzer {
  readonly supportsPartial?: boolean;
  readonly version?: string;
  readonly promptVersion?: string;
  readonly capability: 'simulated' | 'real';
  analyze(post: Post, signal?: AbortSignal): Promise<Analysis>;
}
export interface NotificationChannel {
  deliveryBinding?(notification: Notification, now: string): import('../model.js').DeliveryBinding;
  sendClaim?(claim: import('../model.js').DeliveryClaim, signal?: AbortSignal): Promise<DeliveryResult>;
  readonly capability: 'simulated' | 'real';
  /** Use notification.id as provider idempotency key, when supported. */
  send(notification: Notification, signal?: AbortSignal): Promise<DeliveryResult>;
}
export interface NotificationRule {
  readonly id: string;
  readonly version?: string;
  evaluate(item: AnalyzedPost, recipient: string, now: string): readonly Notification[];
}
export interface DigestRenderer {
  render(target: WatchTarget, window: DigestWindow, posts: readonly AnalyzedPost[]): string;
}
export interface EventSink { record(event: AppEvent): void }
export interface PollCommit {
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly cursor: string | null;
  readonly observedAt: string;
  readonly posts: readonly AnalyzedPost[];
  readonly notifications: readonly Notification[];
}
/** Synchronous atomic operations. Implementations must never await inside a DB transaction. */
export interface LegacyWatchStore {
  readonly durability: 'memory' | 'persistent';
  checkpoint(targetId: string): Checkpoint;
  hasPost(targetId: string, postId: string): boolean;
  /** Atomically save posts, checkpoint, and deduplicated outbox entries; compare revision. */
  /** @deprecated Use commitIngestion and commitAnalysis. */
  commitPoll(commit: PollCommit): void;
  listPosts(targetId: string, window: DigestWindow): readonly AnalyzedPost[];
  /** Returns false if this immutable notification already exists. */
  enqueue(notification: Notification): boolean;
  outbox(): readonly OutboxEntry[];
  /** Atomic pending -> sending; null means another worker already claimed it. */
  claim(id: string): Notification | null;
  finish(id: string, result: DeliveryResult): void;
  /** Explicit startup reconciliation: in-flight delivery is never automatically resent. */
  recoverInFlight(): number;
}

export interface WatchJobs {
  poll(target: WatchTarget): Promise<number>;
  digest(target: WatchTarget, window: DigestWindow): boolean;
  deliver(): Promise<readonly { id: string; result: DeliveryResult }[]>;
}
