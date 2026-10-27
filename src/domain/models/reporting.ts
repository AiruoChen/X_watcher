import type { AnalysisResult, Checkpoint, Coverage, DigestReport, DigestWindow, Notification, PostVersion } from '../model.js';
export interface ReportItem { readonly post: PostVersion; readonly result: AnalysisResult | null }
export interface SourceObservation { readonly startedAt: string; readonly completedAt: string; readonly checkpointRevision: number }
export interface ReportProgress {
  readonly targetId: string; readonly day: string; readonly revision: number;
  readonly state: 'awaiting_data' | 'awaiting_analysis' | 'published';
  readonly incidentOpen: boolean; readonly incidentClosed: boolean; readonly updatedAt: string;
}
export interface ReportBoundary { readonly targetId: string; readonly firstDay: string; readonly beforeDay: string }
export interface ReportChange {
  readonly postId: string; readonly kind: 'late' | 'edited' | 'deleted' | 'analysis_updated' | 'removed';
  readonly previousPostKey: string | null; readonly postKey: string | null;
}
export interface ReportSnapshot extends DigestReport {
  readonly formatVersion: 1; readonly kind: 'daily' | 'addendum';
  readonly issuedOn: string; readonly previousReportId: string | null;
  readonly items: readonly ReportItem[]; readonly changes: readonly ReportChange[];
  readonly sourceComplete: boolean; readonly analysisComplete: boolean;
  readonly text: string;
}
export interface ReportInputs {
  readonly targetId: string; readonly window: DigestWindow; readonly checkpoint: Checkpoint;
  readonly observation: SourceObservation | null; readonly boundary: ReportBoundary | null; readonly coverage: readonly Coverage[]; readonly covered: boolean;
  readonly progress: ReportProgress | null; readonly previous: DigestReport | null; readonly previousItems: readonly ReportItem[];
  readonly items: readonly ReportItem[]; readonly token: string;
}
export interface ReportCommit {
  readonly manual: boolean;
  readonly inputs: ReportInputs; readonly progress: ReportProgress;
  readonly snapshot: ReportSnapshot | null; readonly notifications: readonly Notification[];
}

export interface ReportView {
  readonly handle: string; readonly window: DigestWindow; readonly timeZone: string; readonly issuedOn: string;
  readonly generatedAt: string; readonly kind: 'daily' | 'addendum' | 'partial';
  readonly sourceComplete: boolean; readonly analysisComplete: boolean;
  readonly items: readonly ReportItem[]; readonly changes: readonly ReportChange[];
}
