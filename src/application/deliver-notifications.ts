import type { Clock, ExecutionContext, NotificationChannel, WatchStore } from '../domain/ports.js';
import type { DeliveryResult } from '../domain/model.js';

export class DeliverNotifications {
  constructor(private readonly store: WatchStore, private readonly channel: NotificationChannel, private readonly clock?: Clock) {}

  async execute(context?: ExecutionContext, timeoutMs = 30_000, limit = 100): Promise<readonly { id: string; result: DeliveryResult }[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid delivery batch size.');
    const results: { id: string; result: DeliveryResult }[] = [];
    for (let count = 0; count < limit; count++) {
      if (context && (context.signal.aborted || !context.canClaim())) break;
      // Re-query after every call so newly arrived reset alerts can preempt queued digests.
      const entry = this.store.pendingNotifications(1)[0];
      if (!entry) break;
      if (entry.state !== 'pending') continue;
      const now = (this.clock?.now() ?? new Date()).toISOString();
      const message = this.store.claimDelivery(entry.notification.id, now, this.channel.deliveryBinding?.(entry.notification, now));
      if (!message) continue;
      let result: DeliveryResult;
      try {
        const send = (signal?: AbortSignal) => this.channel.sendClaim ? this.channel.sendClaim(message, signal) : this.channel.send(message.notification, signal);
        result = context ? await context.call(send, timeoutMs) : await send();
      }
      catch { result = { status: 'unknown', reason: 'Provider call failed; verify before retrying.' }; }
      this.store.finishDelivery(message.attemptId, result, (this.clock?.now() ?? new Date()).toISOString());
      results.push({ id: message.notification.id, result });
    }
    return results;
  }
}
