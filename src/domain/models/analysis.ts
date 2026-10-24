import type { Post, PostVersion } from './post.js';
export interface ResetAnnouncement {
  /** Exact quotation from the post; absent time must stay unknown. */
  readonly evidence: string;
  readonly whenText: string | null;
  readonly timeZoneText: string | null;
}

export interface Analysis {
  readonly summary: string;
  readonly chatgptUpdates: readonly string[];
  readonly reset: ResetAnnouncement | null;
}

export interface AnalyzedPost {
  readonly post: Post;
  readonly analysis: Analysis;
}

export type AnalysisJobState = 'pending' | 'processing' | 'retry_wait' | 'completed' | 'needs_attention';
export interface AnalysisJob {
  readonly id: string;
  readonly postKey: string;
  readonly targetId: string;
  readonly analyzerVersion: string;
  readonly promptVersion: string;
  readonly configRevision: string;
  readonly emitNotifications: boolean;
  readonly state: AnalysisJobState;
  readonly revision: number;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
}
export interface AnalysisResult {
  readonly jobId: string;
  readonly postKey: string;
  readonly analyzerVersion: string;
  readonly promptVersion: string;
  readonly completedAt: string;
  readonly analysis: Analysis;
}
export interface RuleEvent {
  readonly supersedesPostKey?: string;
  readonly id: string;
  readonly jobId: string;
  readonly postKey: string;
  readonly targetId: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly createdAt: string;
}
/** Expanded result for adapters; old Analysis remains a compatible rendering input. */
export interface ProductUpdate {
  readonly product: 'chatgpt' | 'api' | 'codex' | 'other';
  readonly status: 'released' | 'rolling_out' | 'planned' | 'speculation' | 'discussion';
  readonly text: string;
  readonly evidence: string;
}
export type ResetFinding = { readonly kind: 'none' } | {
  readonly kind: 'announcement' | 'discussion' | 'correction';
  readonly evidence: string;
  readonly whenText: string | null;
  readonly timeZoneText: string | null;
  readonly normalizedAt: string | null;
  readonly normalizationEvidence: string | null;
};
export interface VersionedAnalysis extends Analysis {
  readonly updates: readonly ProductUpdate[];
  readonly resetFinding: ResetFinding;
}
export interface VersionedAnalyzedPost { readonly post: PostVersion; readonly result: AnalysisResult }
