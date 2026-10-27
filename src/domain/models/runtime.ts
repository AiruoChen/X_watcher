export interface RuntimeOwnership {
  readonly ownerId: string;
  readonly hostId: string;
  readonly revision: number;
  readonly acquiredAt: string;
  readonly leaseUntil: string;
}
export interface AuditRecord {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly entityId: string;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly createdAt: string;
}

export type RuntimeStage = 'ingest' | 'analysis' | 'delivery' | 'digest';
/** dueAt is nextPollAt for ingestion and nextRetryAt when failures > 0. */
export interface ScheduledTask {
  readonly id: string;
  readonly stage: RuntimeStage;
  readonly targetId: string | null;
  readonly configRevision: string;
  readonly revision: number;
  readonly state: 'idle' | 'running' | 'needs_attention';
  readonly dueAt: string;
  readonly failures: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}
