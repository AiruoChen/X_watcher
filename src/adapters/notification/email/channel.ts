import type { Clock, ContentHasher, NotificationChannel } from '../../../domain/ports.js';
import type { MailTransport } from '../../../domain/ports/mail.js';
import type { DeliveryBinding, DeliveryClaim, DeliveryResult, Notification } from '../../../domain/model.js';
import { validateBinding } from '../../../domain/policies/mail.js';
export class EmailChannel implements NotificationChannel {
  readonly capability: 'simulated' | 'real';
  constructor(private readonly transport: MailTransport, private readonly clock: Clock, private readonly hasher: ContentHasher,
    private readonly options: { readonly from: string; readonly idempotencyTtlMs: number; readonly maxAttempts: number }) {
    this.capability = transport.capability;
    if (!Number.isSafeInteger(options.idempotencyTtlMs) || options.idempotencyTtlMs < 0 || options.idempotencyTtlMs > 604800000)
      throw new Error('Invalid mail idempotency duration.');
  }
  deliveryBinding(notification: Notification, now: string): DeliveryBinding {
    const binding: DeliveryBinding = { provider: this.transport.provider, account: this.transport.account, from: this.options.from,
      idempotencyKey: this.hasher.hash(notification.id),
      expiresAt: this.options.idempotencyTtlMs ? new Date(Date.parse(now) + this.options.idempotencyTtlMs).toISOString() : null,
      maxAttempts: this.options.maxAttempts };
    validateBinding(binding); return binding;
  }
  async send(_notification: Notification): Promise<DeliveryResult> { throw new Error('A persisted delivery claim is required.'); }
  async sendClaim(claim: DeliveryClaim, signal?: AbortSignal): Promise<DeliveryResult> {
    const binding = claim.binding, n = claim.notification;
    if (!binding) throw new Error('Missing persisted mail binding.');
    validateBinding(binding);
    if (binding.provider !== this.transport.provider || binding.account !== this.transport.account || binding.from !== this.options.from)
      return { status: 'unknown', reason: 'mail_context_changed' };
    if (binding.expiresAt !== null && Date.parse(binding.expiresAt) <= this.clock.now().getTime())
      return { status: 'unknown', reason: 'idempotency_window_expired' };
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(n.recipient) || /[\r\n\0]/.test(n.subject) || !n.subject.trim()
      || n.subject.length > 500 || !n.text.trim() || n.text.length > 100000)
      return { status: 'rejected', reason: 'invalid_mail_snapshot' };
    try {
      signal?.throwIfAborted();
      const result = await this.transport.send(structuredClone(n), structuredClone(binding), signal);
      signal?.throwIfAborted();
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (r['status'] === 'accepted' && typeof r['providerId'] === 'string' && r['providerId'].trim() && r['providerId'].length <= 300 && !/[\r\n\0]/.test(r['providerId']))
          return { status: 'accepted', providerId: r['providerId'] };
        if (r['status'] === 'rejected' && r['definitelyNotAccepted'] === true)
          return { status: 'rejected', reason: 'provider_confirmed_rejection' };
      }
    } catch { /* Transport errors may contain credentials. Never propagate them or infer non-acceptance. */ }
    return { status: 'unknown', reason: 'provider_result_unknown' };
  }
}
