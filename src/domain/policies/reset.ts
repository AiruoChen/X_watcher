import { isInstant } from '../time.js';
/** Eligibility is separate from semantic classification and exact time normalization. */
export function resetEligible(publishedAt: string, discoveredAt: string, monitorStartedAt: string,
  maxAgeMs: number, normalizedAt: string | null = null): boolean {
  if (![publishedAt, discoveredAt, monitorStartedAt].every(isInstant) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || (normalizedAt !== null && !isInstant(normalizedAt))) return false;
  const published = Date.parse(publishedAt), found = Date.parse(discoveredAt), start = Date.parse(monitorStartedAt);
  const reset = normalizedAt === null ? null : Date.parse(normalizedAt);
  if (![published, found, start].every(Number.isFinite) || (reset !== null && !Number.isFinite(reset))) return false;
  return published >= start && published <= found && found - published <= maxAgeMs && (reset === null || reset > found);
}
