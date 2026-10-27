export interface Post {
  readonly id: string;
  readonly targetId: string;
  readonly text: string;
  readonly publishedAt: string;
  readonly url: string;
  readonly origin?: SourcePostMetadata;
}

export interface SourceReference {
  readonly id: string;
  readonly kind: 'replied_to' | 'quoted' | 'retweeted';
  readonly authorId: string | null;
  readonly text: string | null;
  readonly url: string;
}
/** Author text remains in Post.text; references are untrusted, separately attributed context. */
export interface SourcePostMetadata {
  readonly authorId: string;
  readonly sourcePostId: string;
  readonly sourceVersion: string;
  readonly completeness: 'full' | 'truncated';
  readonly kind: 'original' | 'reply' | 'quote' | 'repost';
  readonly editHistory: readonly string[];
  readonly references: readonly SourceReference[];
}

export interface PostVersion extends Post {
  readonly key: string;
  readonly provider: string;
  readonly authorId: string;
  readonly sourceVersion: string;
  readonly contentHash: string;
  readonly discoveredAt: string;
  readonly completeness: 'full' | 'truncated';
  readonly deleted: boolean;
}
