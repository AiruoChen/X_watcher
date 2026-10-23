import type { Post } from './post.js';
export interface Checkpoint {
  readonly revision: number;
  readonly cursor: string | null;
  readonly observedAt: string | null;
}

export interface PostBatch {
  readonly posts: readonly Post[];
  readonly nextCursor: string | null;
  /** False means pagination or retrieval is incomplete; never advance the checkpoint. */
  readonly complete: boolean;
}

export interface SourceQuery { readonly from: string; readonly to: string }
export interface Coverage extends SourceQuery {
  readonly id: string;
  readonly targetId: string;
  readonly status: 'complete' | 'gap';
  readonly reason: string | null;
}
