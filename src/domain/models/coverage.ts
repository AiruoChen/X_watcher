import type { Post } from './post.js';
export interface Checkpoint {
  readonly revision: number;
  readonly cursor: string | null;
  readonly observedAt: string | null;
}

export interface PostBatch {
  readonly posts: readonly Post[];
  readonly nextCursor: string | null;
  /** False means retrieval of this response is incomplete; never advance the checkpoint.
   * A complete feed response may still have unverified temporal coverage. */
  readonly complete: boolean;
  /** Optional earlier start for explicit overlap; end must equal the fixed requested boundary. */
  readonly coverage?: SourceQuery;
  readonly coverageStatus?: 'complete' | 'unverified';
  readonly scope?: 'x_recent_public_index' | 'rsshub_timeline_snapshot';
}

export interface SourceQuery { readonly from: string; readonly to: string }
export interface Coverage extends SourceQuery {
  readonly id: string;
  readonly targetId: string;
  readonly status: 'complete' | 'gap';
  readonly reason: string | null;
  readonly scope?: 'x_recent_public_index' | 'rsshub_timeline_snapshot';
}
