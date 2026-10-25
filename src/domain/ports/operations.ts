import type { BudgetDecision, BudgetRequest, CleanupPlan, ControlCommand, ControlResult,
  HealthCommand, HealthState, Incident, MeteredService, TokenUsage, UsageRecord, UsageTotal } from '../model.js';
export interface CallPermit {
  run<T>(operation: () => Promise<T>, usage?: (value: T) => TokenUsage | undefined): Promise<T>;
  /** Only before invocation; a started/unknown call cannot be refunded automatically. */
  cancel(): void;
}
export interface CallGate {
  reserve(service: MeteredService): CallPermit;
}
export interface OperationsStore {
  reserveUsage(request: BudgetRequest): BudgetDecision;
  startUsage(id: string): void;
  finishUsage(id: string, success: boolean, usage?: TokenUsage): void;
  cancelUsage(id: string): void;
  usage(day?: string): readonly UsageTotal[];
  usageRecord(id: string): UsageRecord | null;
  budgetDay(day: string): string;
  health(): readonly HealthState[];
  incidents(): readonly Incident[];
  recordHealth(command: HealthCommand): void;
  requestControl(command: ControlCommand): ControlResult;
  control(id: string): ControlResult | null;
  applyControls(now: string): { readonly stop: boolean };
  summary(): Readonly<Record<string, unknown>>;
  analysisJobs(limit: number): readonly Readonly<Record<string, unknown>>[];
  notifications(limit: number): readonly Readonly<Record<string, unknown>>[];
  cleanupPlan(at: string, postDays: number, auditDays: number): CleanupPlan;
  cleanup(plan: CleanupPlan): Readonly<Record<string, number>>;
  archiveRows(from: string, to: string, targetIds: readonly string[]): readonly Readonly<Record<string, unknown>>[];
}
