export class RevisionConflictError extends Error {
  constructor() { super('Checkpoint revision changed; poll was not committed.'); }
}
export class IncompleteBatchError extends Error {
  constructor() { super('Source retrieval incomplete; checkpoint was not advanced.'); }
}

export type SourceFailureCode = 'authentication' | 'permission' | 'not_found' | 'rate_limited' | 'credits_exhausted'
  | 'network' | 'timeout' | 'cancelled' | 'provider' | 'protocol' | 'identity_mismatch' | 'coverage_gap' | 'page_limit';
/** Only allowlisted codes/times cross into scheduling and logs, never response bodies or secrets. */
export class SourceFailure extends Error {
  constructor(readonly code: SourceFailureCode, readonly retryable: boolean, readonly retryAt: string | null = null) {
    super(`Post source failed: ${code}`);
  }
}
export class SourceCoverageGap extends SourceFailure {
  constructor(readonly range: import('./model.js').SourceQuery) { super('coverage_gap', false); }
}

export class BudgetExceeded extends Error {
  constructor(readonly service: import('./model.js').MeteredService, readonly retryAt: string, readonly reason: string) { super('budget_exhausted'); }
}

export class UsageFailure extends Error {
  constructor(readonly usage: import('./model.js').TokenUsage) { super('Model response was not usable; measured usage was retained.'); }
}
