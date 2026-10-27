import type { WatchTarget } from './target.js';
export interface RuntimeConfig {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly storage: { readonly kind: 'memory' | 'sqlite'; readonly path: string };
  readonly policy: BusinessPolicy;
  readonly retry: RetryPolicy;
  readonly runtime: { readonly wakeMs: number; readonly leaseMs: number; readonly shutdownMs: number;
    readonly maxConcurrent: number; readonly batchSize: number };
  readonly x: { readonly maxPages: number; readonly pageSize: number; readonly requestTimeoutMs: number;
    readonly safetyLagMs: number; readonly overlapMs: number; readonly fieldDialect: 'post' | 'tweet' };
  readonly rsshub: { readonly baseUrl: string; readonly itemLimit: number; readonly requestTimeoutMs: number;
    readonly overlapMs: number; readonly safetyLagMs: number };
  readonly services: {
    readonly source: ServiceConfig;
    readonly analysis: ServiceConfig & { readonly model: string | null; readonly version: string; readonly promptVersion: string };
    readonly mail: ServiceConfig & { readonly from: string | null };
  };
  readonly analysisPolicy: { readonly allowPartial: boolean };
  readonly mailPolicy: { readonly account: string | null; readonly idempotencyTtlMs: number; readonly maxAttempts: number };
  readonly budget: { readonly maxCallsPerDay: number | null; readonly maxCostPerDay: number | null; readonly maxCostMicros: number | null;
    readonly serviceCalls: Readonly<Record<import('./operations.js').MeteredService, number | null>>;
    readonly unitMicros: Readonly<Record<import('./operations.js').MeteredService, number | null>>;
    readonly currency: string | null; readonly priceReference: string | null };
  readonly operations: { readonly retentionTermsReviewed: boolean; readonly autoCleanup: boolean };
  readonly mode: 'demo' | 'preview' | 'live';
  readonly targets: readonly WatchTarget[];
  readonly pollIntervalMs: number;
  readonly timeZone: string;
  readonly dailyDigestAt: string;
  readonly recipient: string;
}
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
export interface BusinessPolicy {
  readonly initialBackfillDays: number;
  readonly resetMaxAgeMs: number;
  readonly digestCatchUpDays: number;
  readonly maxCatchUpEmailsPerCycle: number;
  readonly digestGraceMinutes: number;
  readonly failureThreshold: number;
  readonly staleAfterMs: number;
  readonly postRetentionDays: number;
  readonly auditRetentionDays: number;
}
export interface ServiceConfig {
  readonly provider: string | null;
  readonly credentialEnv: string | null;
  readonly timeoutMs: number;
}
