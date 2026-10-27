import type { VersionedAnalysis } from './analysis.js';
export interface CorrectionLink {
  readonly postKey: string; readonly postId: string; readonly sourcePostId: string; readonly url: string;
  readonly basis: 'same_post' | 'edit_history' | 'explicit_reference';
}
export interface SemanticAnalysis extends VersionedAnalysis {
  readonly schemaVersion: 1;
  readonly correctionLink?: CorrectionLink | null;
  readonly topics: readonly string[];
  readonly inputCompleteness: 'full' | 'partial';
  readonly provenance: { readonly model: string; readonly analyzerVersion: string; readonly promptVersion: string; readonly inputHash: string };
  readonly resetDetails: {
    readonly product: 'chatgpt' | 'codex' | 'api' | 'other';
    readonly certainty: 'confirmed' | 'uncertain';
    readonly audience: string | null;
    readonly previousPostId: string | null;
  } | null;
}
