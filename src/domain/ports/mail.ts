import type { Notification, DeliveryBinding, DeliveryRecord, DeliveryResolution, MailAudit, MailReceipt } from '../model.js';
export interface MailTransport {
  readonly capability: 'simulated' | 'real'; readonly provider: string; readonly account: string;
  /** Return accepted only with a provider ID; rejected only with protocol proof of non-acceptance. */
  send(notification: Notification, binding: DeliveryBinding, signal?: AbortSignal): Promise<unknown>;
  /** Exact provider ID or exact idempotency key lookup; no fuzzy/latest-message search. */
  lookup?(binding: DeliveryBinding, providerId: string | null, signal?: AbortSignal): Promise<MailReceipt>;
}
export interface MailStore {
  deliveryRecord(id: string): DeliveryRecord | null;
  resolveDelivery(command: DeliveryResolution): DeliveryRecord;
  mailAudits(id: string): readonly MailAudit[];
}
