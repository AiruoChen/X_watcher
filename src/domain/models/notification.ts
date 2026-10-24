export interface Notification {
  readonly id: string;
  readonly kind: 'reset' | 'digest' | 'correction' | 'service_alert';
  readonly targetId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly text: string;
  readonly createdAt: string;
  readonly configRevision?: string;
  readonly originId?: string;
}

export type DeliveryResult =
  | { readonly status: 'accepted'; readonly providerId: string }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string };
export type DeliveryState = 'pending' | 'sending' | 'provider_accepted' | 'delivered' | 'bounced' | 'retry_wait' | 'failed' | 'needs_attention';
export interface OutboxEntry {
  readonly notification: Notification;
  readonly state: DeliveryState;
  readonly result: DeliveryResult | null;
}
export interface DeliveryAttempt {
  readonly binding?: import('./mail.js').DeliveryBinding;
  readonly id: string;
  readonly notificationId: string;
  readonly number: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: DeliveryResult | null;
}
export interface DeliveryClaim {
  readonly binding?: import('./mail.js').DeliveryBinding;
  readonly attemptId: string;
  readonly notification: Notification;
}
