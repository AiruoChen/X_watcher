import type { LegacyWatchStore } from './legacy.js';
import type { AnalysisJob, AnalysisResult, Coverage, DeliveryAttempt, DeliveryClaim, DeliveryResult,
  DigestReport, Notification, PostVersion, RuleEvent, SourceQuery, TargetIdentity } from '../model.js';
export interface IngestionCommit {
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly cursor: string | null;
  readonly observedAt: string;
  readonly coverage: Coverage;
  readonly posts: readonly PostVersion[];
  readonly jobs: readonly AnalysisJob[];
}
export interface AnalysisCommit {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly result: AnalysisResult;
  readonly events: readonly RuleEvent[];
  readonly notifications: readonly Notification[];
}
/** Synchronous transaction contracts; clone inputs/outputs and reject inconsistent identities. */
export interface WorkflowStore {
  registerTarget(target: TargetIdentity): TargetIdentity;
  target(id: string): TargetIdentity | null;
  commitIngestion(commit: IngestionCommit): void;
  recordCoverageGap(gap: Coverage, expectedRevision: number): void;
  coverage(targetId: string): readonly Coverage[];
  isCovered(targetId: string, query: SourceQuery): boolean;
  versions(targetId: string): readonly PostVersion[];
  analysisJobs(targetId: string): readonly AnalysisJob[];
  claimAnalysis(id: string, now: string): AnalysisJob | null;
  failAnalysis(id: string, expectedRevision: number, nextAttemptAt: string | null): void;
  commitAnalysis(commit: AnalysisCommit): void;
  analysisResult(postKey: string): AnalysisResult | null;
  analysisResults(postKey: string): readonly AnalysisResult[];
  ruleEvents(): readonly RuleEvent[];
  createReportWithNotification(report: DigestReport, notification: Notification | null): boolean;
  reports(targetId: string): readonly DigestReport[];
  claimDelivery(id: string, now: string): DeliveryClaim | null;
  finishDelivery(attemptId: string, result: DeliveryResult, now: string): void;
  deliveryAttempts(): readonly DeliveryAttempt[];
}
export interface WatchStore extends LegacyWatchStore, WorkflowStore {}

export interface ContentHasher { hash(text: string): string }
