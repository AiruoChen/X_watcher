import type { DeliveryAttempt, OutboxEntry, DeliveryState } from './notification.js';
export interface DeliveryBinding {
  readonly retryPolicy?: { readonly baseDelayMs: number; readonly maxDelayMs: number };
  readonly provider: string; readonly account: string; readonly from: string;
  readonly idempotencyKey: string; readonly expiresAt: string | null; readonly maxAttempts: number;
}
export interface DeliveryRecord { readonly entry: OutboxEntry; readonly revision: number; readonly attempt: DeliveryAttempt | null }
export interface MailReceipt {
  readonly provider: string; readonly account: string; readonly idempotencyKey: string;
  readonly providerId: string | null; readonly status: 'accepted' | 'delivered' | 'bounced' | 'not_found' | 'unknown';
  readonly checkedAt: string;
}
export interface DeliveryResolution {
  readonly notificationId: string; readonly attemptId: string; readonly expectedRevision: number;
  readonly action: 'apply_receipt' | 'confirm_sent' | 'confirm_not_sent_retry' | 'abandon';
  readonly actor: string; readonly reason: string; readonly at: string; readonly receipt?: MailReceipt;
}
export interface MailAudit extends DeliveryResolution { readonly kind: 'mail_resolution'; readonly resultingState: DeliveryState }
