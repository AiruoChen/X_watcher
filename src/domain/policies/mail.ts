import type { DeliveryBinding, DeliveryRecord, DeliveryResolution, DeliveryState, MailReceipt } from '../model.js';
import { isInstant } from '../time.js';
import { requireRevision } from './state.js';
const invalid = (): never => { throw new Error('Invalid mail operation or evidence.'); };
export function validateBinding(binding: DeliveryBinding): void {
  if (binding.retryPolicy && (!Number.isSafeInteger(binding.retryPolicy.baseDelayMs) || binding.retryPolicy.baseDelayMs < 1
    || !Number.isSafeInteger(binding.retryPolicy.maxDelayMs) || binding.retryPolicy.maxDelayMs < binding.retryPolicy.baseDelayMs
    || binding.retryPolicy.maxDelayMs > 86400000)) invalid();
  if (![binding.provider, binding.account, binding.idempotencyKey].every(x => typeof x === 'string' && x.trim() && x.length <= 300 && !/[\r\n\0]/.test(x))
    || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(binding.from)
    || !Number.isSafeInteger(binding.maxAttempts) || binding.maxAttempts < 1 || binding.maxAttempts > 100
    || (binding.expiresAt !== null && !isInstant(binding.expiresAt))) invalid();
}
export function validateReceipt(record: DeliveryRecord, receipt: MailReceipt): void {
  const keys = ['provider','account','idempotencyKey','providerId','status','checkedAt'];
  if (!receipt || typeof receipt !== 'object' || Object.keys(receipt).length !== keys.length
    || Object.keys(receipt).some(key => !keys.includes(key))) invalid();
  const binding = record.attempt?.binding;
  if (!binding || receipt.provider !== binding.provider || receipt.account !== binding.account || receipt.idempotencyKey !== binding.idempotencyKey
    || !['accepted','delivered','bounced','not_found','unknown'].includes(receipt.status)
    || !isInstant(receipt.checkedAt) || Date.parse(receipt.checkedAt) < Date.parse(record.attempt!.startedAt)) invalid();
  const accepted = record.entry.result?.status === 'accepted' ? record.entry.result.providerId : null;
  if ((accepted !== null && receipt.providerId !== accepted)
    || (['accepted','delivered','bounced'].includes(receipt.status) && (typeof receipt.providerId !== 'string' || !receipt.providerId.trim() || receipt.providerId.length > 300 || /[\r\n\0]/.test(receipt.providerId)))) invalid();
}
export function resolvedDeliveryState(record: DeliveryRecord, command: DeliveryResolution): DeliveryState {
  requireRevision(record.revision, command.expectedRevision);
  if (record.entry.notification.id !== command.notificationId || !record.attempt || record.attempt.id !== command.attemptId
    || !record.attempt.finishedAt || !isInstant(command.at)
    || Date.parse(command.at) < Date.parse(record.attempt.finishedAt)
    || ![command.actor,command.reason].every(s => typeof s === 'string' && s.trim() && s.length <= 1000 && !/[\r\n\0]/.test(s))) invalid();
  const state = record.entry.state;
  if (command.action === 'apply_receipt') {
    if (!command.receipt || !['needs_attention','provider_accepted'].includes(state)) return invalid();
    validateReceipt(record, command.receipt);
    if (Date.parse(command.receipt.checkedAt) > Date.parse(command.at)) return invalid();
    if (command.receipt.status === 'accepted') return 'provider_accepted';
    if (command.receipt.status === 'delivered') return 'delivered';
    if (command.receipt.status === 'bounced') return 'bounced';
    return invalid(); // not_found never proves a failed send; no mutation from an inconclusive lookup.
  }
  if (command.action === 'abandon' && state === 'retry_wait' && command.receipt === undefined) return 'failed';
  if (!['needs_attention','failed'].includes(state) || command.receipt !== undefined) return invalid();
  if (command.action === 'confirm_sent') return 'provider_accepted'; // Human confirmation is not a delivered receipt.
  if (command.action === 'abandon') return 'failed';
  if (command.action === 'confirm_not_sent_retry') {
    if (record.attempt!.number >= (record.attempt!.binding?.maxAttempts ?? 5)) return invalid();
    return 'pending';
  }
  return invalid();
}
