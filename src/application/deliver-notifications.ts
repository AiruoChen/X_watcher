import type { NotificationChannel, WatchStore } from '../domain/ports.js';
import type { DeliveryResult } from '../domain/model.js';

export class DeliverNotifications {
  constructor(private readonly store: WatchStore, private readonly channel: NotificationChannel) {}

  async execute(): Promise<readonly { id: string; result: DeliveryResult }[]> {
    const results: { id: string; result: DeliveryResult }[] = [];
    for (const entry of this.store.outbox()) {
      if (entry.state !== 'pending') continue;
      const message = this.store.claim(entry.notification.id);
      if (!message) continue;
      let result: DeliveryResult;
      try { result = await this.channel.send(message); }
      catch { result = { status: 'unknown', reason: 'Provider call failed; verify before retrying.' }; }
      this.store.finish(message.id, result);
      results.push({ id: message.id, result });
    }
    return results;
  }
}
