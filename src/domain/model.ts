export interface WatchTarget {
  readonly id: string;
  readonly provider: string;
  readonly handle: string;
}

export interface Post {
  readonly id: string;
  readonly targetId: string;
  readonly text: string;
  readonly publishedAt: string;
  readonly url: string;
}

export interface ResetAnnouncement {
  /** Exact quotation from the post; absent time must stay unknown. */
  readonly evidence: string;
  readonly whenText: string | null;
  readonly timeZoneText: string | null;
}

export interface Analysis {
  readonly summary: string;
  readonly chatgptUpdates: readonly string[];
  readonly reset: ResetAnnouncement | null;
}

export interface AnalyzedPost {
  readonly post: Post;
  readonly analysis: Analysis;
}

export interface Checkpoint {
  readonly revision: number;
  readonly cursor: string | null;
  readonly observedAt: string | null;
}

export interface PostBatch {
  readonly posts: readonly Post[];
  readonly nextCursor: string | null;
  /** False means pagination or retrieval is incomplete; never advance the checkpoint. */
  readonly complete: boolean;
}

export interface Notification {
  readonly id: string;
  readonly kind: 'reset' | 'digest';
  readonly targetId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly createdAt: string;
}

export type DeliveryResult =
  | { readonly status: 'accepted'; readonly providerId: string }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string };
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'needs_attention';
export interface OutboxEntry {
  readonly notification: Notification;
  readonly state: DeliveryState;
  readonly result: DeliveryResult | null;
}
export interface DigestWindow {
  readonly day: string;
  readonly from: string;
  readonly to: string;
}
export interface RuntimeConfig {
  readonly mode: 'demo' | 'live';
  readonly targets: readonly WatchTarget[];
  readonly pollIntervalMs: number;
  readonly timeZone: string;
  readonly dailyDigestAt: string;
  readonly recipient: string;
}
export type AppEvent =
  | { readonly type: 'poll.completed'; readonly targetId: string; readonly newPosts: number }
  | { readonly type: 'notification.finished'; readonly id: string; readonly status: DeliveryResult['status'] }
  | { readonly type: 'cycle.failed'; readonly stage: string };
