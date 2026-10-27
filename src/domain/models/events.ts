import type { DeliveryResult } from './notification.js';
export type AppEvent =
  | { readonly type: 'poll.completed'; readonly targetId: string; readonly newPosts: number }
  | { readonly type: 'notification.finished'; readonly id: string; readonly status: DeliveryResult['status'] }
  | { readonly type: 'cycle.failed'; readonly stage: string };
