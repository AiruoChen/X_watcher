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
