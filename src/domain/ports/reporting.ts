import type { DigestWindow, ReportBoundary, ReportCommit, ReportInputs, ReportProgress } from '../model.js';
export interface ReportingStore {
  reportInputs(targetId: string, window: DigestWindow): ReportInputs;
  reportProgress(targetId: string, day: string): ReportProgress | null;
  reportBoundary(targetId: string): ReportBoundary | null;
  recordReportBoundary(boundary: ReportBoundary): void;
  /** Revalidate the input token, then persist progress, immutable report and notifications atomically. */
  commitReport(command: ReportCommit): boolean;
}

export interface ReportRenderer { render(view: import('../model.js').ReportView): string }
