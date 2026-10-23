import type { Clock, NotificationChannel, WatchStore } from '../domain/ports.js';
import type { DeliveryResult } from '../domain/model.js';

export class DeliverNotifications {
  constructor(private readonly store: WatchStore, private readonly channel: NotificationChannel, private readonly clock?: Clock) {}

  async execute(): Promise<readonly { id: string; result: DeliveryResult }[]> {
    const results: { id: string; result: DeliveryResult }[] = [];
    for (const entry of this.store.pendingNotifications(100)) {
      if (entry.state !== 'pending') continue;
      const message = this.store.claimDelivery(entry.notification.id, (this.clock?.now() ?? new Date()).toISOString());
      if (!message) continue;
      let result: DeliveryResult;
      try { result = await this.channel.send(message.notification); }
      catch { result = { status: 'unknown', reason: 'Provider call failed; verify before retrying.' }; }
      this.store.finishDelivery(message.attemptId, result, (this.clock?.now() ?? new Date()).toISOString());
      results.push({ id: message.notification.id, result });
    }
    return results;
  }
}
