import type { DeliveryAttempt, DeliveryResult, DeliveryState } from '../model.js';
import { isInstant } from '../time.js';
import { retryDelay } from './retry.js';
/** Only adapter-proven temporary non-acceptance may schedule another send. */
export function deliveryOutcome(attempt: DeliveryAttempt, result: DeliveryResult, now: string): { state: DeliveryState; nextAttemptAt?: string } {
  if (!isInstant(now) || Date.parse(now) < Date.parse(attempt.startedAt)) throw new Error('Invalid delivery completion time.');
  if (result.status === 'accepted') return { state: 'provider_accepted' };
  if (result.status === 'unknown') return { state: 'needs_attention' };
  const binding = attempt.binding, policy = binding?.retryPolicy;
  if (!result.retry || !binding || !policy) return { state: 'failed' };
  if (result.retry.notBefore !== null && !isInstant(result.retry.notBefore)) throw new Error('Invalid provider retry deadline.');
  const delay = retryDelay({ ...policy, maxAttempts: binding.maxAttempts, jitterRatio: 0 }, attempt.number, 0.5);
  if (delay === null) return { state: 'failed' };
  const at = Math.max(Date.parse(now) + delay, result.retry.notBefore === null ? 0 : Date.parse(result.retry.notBefore));
  if (!Number.isFinite(at) || (binding.expiresAt !== null && at >= Date.parse(binding.expiresAt))) return { state: 'failed' };
  return { state: 'retry_wait', nextAttemptAt: new Date(at).toISOString() };
}
