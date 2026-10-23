import type { NotificationChannel } from '../../domain/ports.js';
import type { DeliveryResult, Notification } from '../../domain/model.js';

/** In-memory preview only. No network requests and no real email. */
export class PreviewChannel implements NotificationChannel {
  readonly capability = 'simulated';
  private previews: Notification[] = [];
  async send(notification: Notification): Promise<DeliveryResult> {
    this.previews.push(structuredClone(notification));
    return { status: 'accepted', providerId: `preview:${notification.id}` };
  }
  list(): readonly Notification[] { return structuredClone(this.previews); }
}
