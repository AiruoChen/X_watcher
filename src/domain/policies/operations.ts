import type { HealthCommand, HealthState, HealthTransition, Incident, MeteredService, RuntimeConfig, UsageTotal } from '../model.js';
import { digestWindowForDay, dueDigestWindow, isInstant, shiftDay } from '../time.js';
import { stableId } from '../identifiers.js';
export const SERVICES: readonly MeteredService[] = ['source','analysis','mail'];
export function localDay(now: Date, zone: string): string { return shiftDay(dueDigestWindow(now, zone, '00:00')!.day, 1); }
export function budgetReset(day: string, zone: string): string { return digestWindowForDay(day, zone).to; }
export function limited(policy: RuntimeConfig['budget']): boolean {
  return policy.maxCallsPerDay !== null || policy.maxCostPerDay !== null || SERVICES.some(s => policy.serviceCalls[s] !== null);
}
export function budgetReason(totals: readonly UsageTotal[], service: MeteredService, policy: RuntimeConfig['budget']):
  'calls' | 'cost' | 'price_unknown' | 'currency_changed' | 'overflow' | null {
  const total = totals.reduce((n, r) => n + r.calls, 0), own = totals.find(r => r.service === service)?.calls ?? 0;
  if ((policy.maxCallsPerDay !== null && total >= policy.maxCallsPerDay)
    || (policy.serviceCalls[service] !== null && own >= policy.serviceCalls[service]!)) return 'calls';
  const price = policy.unitMicros[service], known = totals.reduce((n, r) => n + r.knownMicros, 0);
  if (price !== null && totals.some(r => r.calls > r.unpricedCalls && r.currency !== null && r.currency !== policy.currency)) return 'currency_changed';
  if (price !== null && known > Number.MAX_SAFE_INTEGER - price) return 'overflow';
  if (policy.maxCostPerDay !== null) {
    if (price === null || totals.some(r => r.unpricedCalls > 0)) return 'price_unknown';
    if (known + price > policy.maxCostMicros!) return 'cost';
  }
  return null;
}
export const HEALTH_CODES = ['source_failed','analysis_failed','analysis_deferred','mail_unknown','mail_rejected','stale',
  'budget_exhausted','network','timeout','authentication','permission','not_found','rate_limited','credits_exhausted',
  'protocol','identity_mismatch','coverage_gap','page_limit','cancelled','provider'] as const;
export function evolveHealth(previous: HealthState | null, incident: Incident | null, c: HealthCommand): HealthTransition {
  if (!isInstant(c.at) || !HEALTH_CODES.includes(c.code as typeof HEALTH_CODES[number]) || !Number.isInteger(c.threshold) || c.threshold < 1
    || !['ingest','analysis','delivery','digest','budget'].includes(c.stage) || c.key.length > 300 || /[\r\n\0]/.test(c.key)) throw new Error('Invalid health observation.');
  const at = previous && previous.lastAttemptAt > c.at ? previous.lastAttemptAt : c.at;
  const failures = c.success ? 0 : c.stale ? previous?.failures ?? 0 : (previous?.failures ?? 0) + 1;
  const health: HealthState = { key: c.key, stage: c.stage, targetId: c.targetId, revision: (previous?.revision ?? 0) + 1,
    failures, lastAttemptAt: c.stale ? previous?.lastAttemptAt ?? at : at,
    lastSuccessAt: c.success ? at : previous?.lastSuccessAt ?? null, code: c.success ? null : c.code };
  const opening = !c.success && (c.stale || failures >= c.threshold) && incident?.state !== 'open';
  const resolving = c.success && incident?.state === 'open';
  const next = opening ? { key: c.key, generation: (incident?.generation ?? 0) + 1, state: 'open' as const,
    code: c.code, openedAt: at, resolvedAt: null } : resolving ? { ...incident!, state: 'resolved' as const, resolvedAt: at } : incident;
  const notifications = (opening || resolving) && c.notify ? [{ id: stableId('incident', c.key, String(next!.generation), opening ? 'open' : 'recovered'),
    targetId: c.targetId ?? 'operations', kind: 'service_alert' as const, originId: stableId('incident', c.key, String(next!.generation)),
    recipient: c.recipient, configRevision: c.configRevision, createdAt: at,
    subject: 'X watcher ' + (opening ? '服务异常' : '服务恢复') + ' · ' + c.stage,
    text: '阶段：' + c.stage + '\n原因：' + next!.code + '\n记录时间：' + at
      + '\n请查看本地 status / usage。此状态不代表异常邮件已经送达。' }] : [];
  return { health, incident: next, notifications };
}
