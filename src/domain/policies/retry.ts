import type { RetryPolicy } from '../model.js';
/** attempt is one-based; null means automatic attempts are exhausted. */
export function retryDelay(policy: RetryPolicy, attempt: number, random: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isFinite(random) || random < 0 || random > 1)
    throw new Error('Invalid retry inputs.');
  if (attempt >= policy.maxAttempts) return null;
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt - 1, 52));
  return Math.min(policy.maxDelayMs, Math.round(capped * (1 - policy.jitterRatio + 2 * policy.jitterRatio * random)));
}
