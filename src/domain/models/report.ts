export interface DigestWindow {
  readonly day: string;
  readonly from: string;
  readonly to: string;
}
export type ReportState = 'awaiting_data' | 'awaiting_analysis' | 'ready' | 'empty' | 'superseded';
export interface DigestReport extends DigestWindow {
  readonly id: string;
  readonly targetId: string;
  readonly timeZone: string;
  readonly revision: number;
  readonly state: ReportState;
  readonly postKeys: readonly string[];
  readonly contentHash: string;
  readonly createdAt: string;
  readonly configRevision: string;
}
