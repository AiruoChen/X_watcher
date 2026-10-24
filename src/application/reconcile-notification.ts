import type { MailStore, MailTransport } from '../domain/ports/mail.js';
import type { MailReceipt } from '../domain/model.js';
import { validateReceipt } from '../domain/policies/mail.js';
export class ReconcileNotification {
  constructor(private readonly store: MailStore, private readonly provider: MailTransport) {}
  /** Read-only. Applying a receipt is a separate revision-checked operation. */
  async execute(id: string, signal?: AbortSignal): Promise<{ readonly revision: number; readonly attemptId: string; readonly receipt: MailReceipt }> {
    const record = this.store.deliveryRecord(id), binding = record?.attempt?.binding;
    if (!record?.attempt?.finishedAt || !binding || !this.provider.lookup
      || binding.provider !== this.provider.provider || binding.account !== this.provider.account
      || !['needs_attention','provider_accepted'].includes(record.entry.state)) throw new Error('No exact provider context available for reconciliation.');
    const providerId = record.entry.result?.status === 'accepted' ? record.entry.result.providerId : null;
    signal?.throwIfAborted();
    let receipt: MailReceipt;
    try { receipt = await this.provider.lookup(structuredClone(binding), providerId, signal); }
    catch { throw new Error('Mail lookup failed; delivery state is unchanged.'); }
    signal?.throwIfAborted(); validateReceipt(record, receipt);
    return { revision: record.revision, attemptId: record.attempt.id, receipt };
  }
}
