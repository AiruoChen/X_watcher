export interface WatchTarget {
  readonly id: string;
  readonly provider: string;
  readonly handle: string;
}

export interface TargetIdentity extends WatchTarget {
  readonly authorId: string;
  readonly enabled: boolean;
  readonly monitorStartedAt: string;
  readonly configRevision: string;
}
export interface ResolvedAuthor { readonly authorId: string; readonly handle: string }
