export interface Post {
  readonly id: string;
  readonly targetId: string;
  readonly text: string;
  readonly publishedAt: string;
  readonly url: string;
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
