import type { MailStore } from '../domain/ports/mail.js';
import type { DeliveryResolution } from '../domain/model.js';
export class ResolveNotification {
  constructor(private readonly store: MailStore) {}
  execute(command: DeliveryResolution): void { this.store.resolveDelivery(command); }
}
