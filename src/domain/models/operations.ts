import type { Notification, RuntimeConfig, RuntimeStage } from '../model.js';
export type MeteredService = 'source' | 'analysis' | 'mail';
export interface TokenUsage { readonly inputTokens: number; readonly outputTokens: number }
export interface UsageRecord { readonly id: string; readonly service: MeteredService; readonly day: string;
  readonly state: 'reserved' | 'started' | 'complete' | 'failed' | 'cancelled'; readonly createdAt: string;
  readonly currency: string | null; readonly priceReference: string | null; readonly configRevision: string;
  readonly estimatedMicros: number | null; readonly usage: TokenUsage | null; readonly finishedAt: string | null }
export interface UsageTotal { readonly day: string; readonly service: MeteredService; readonly calls: number; readonly currency: string | null;
  readonly knownMicros: number; readonly unpricedCalls: number; readonly inputTokens: number; readonly outputTokens: number;
  readonly measuredCalls: number }
export interface BudgetRequest { readonly id: string; readonly service: MeteredService; readonly day: string;
  readonly at: string; readonly configRevision: string; readonly policy: RuntimeConfig['budget'] }
export type BudgetDecision = { readonly allowed: true; readonly record: UsageRecord }
  | { readonly allowed: false; readonly day: string; readonly reason: 'calls' | 'cost' | 'price_unknown' | 'currency_changed' | 'overflow' };
export interface HealthState { readonly key: string; readonly stage: RuntimeStage | 'budget'; readonly targetId: string | null;
  readonly revision: number; readonly failures: number; readonly lastAttemptAt: string;
  readonly lastSuccessAt: string | null; readonly code: string | null }
export interface Incident { readonly key: string; readonly generation: number; readonly state: 'open' | 'resolved';
  readonly code: string; readonly openedAt: string; readonly resolvedAt: string | null }
export interface HealthCommand { readonly key: string; readonly stage: HealthState['stage']; readonly targetId: string | null;
  readonly at: string; readonly success: boolean; readonly code: string; readonly threshold: number;
  readonly notify: boolean; readonly recipient: string; readonly configRevision: string; readonly stale?: boolean }
export interface HealthTransition { readonly health: HealthState; readonly incident: Incident | null; readonly notifications: readonly Notification[] }
export interface ControlCommand { readonly id: string; readonly kind: 'check' | 'stop' | 'resume' | 'retry_analysis';
  readonly targetId: string | null; readonly entityId: string | null; readonly expectedRevision: number | null;
  readonly at: string; readonly reason: string }
export interface ControlResult { readonly id: string; readonly state: 'pending' | 'applied' | 'rejected'; readonly code: string }
export interface CleanupPlan { readonly at: string; readonly postBefore: string; readonly auditBefore: string;
  readonly token: string; readonly counts: Readonly<Record<string, number>>; readonly pinnedPosts: number }
