import type { Clock, PostSource } from '../../../domain/ports.js';
import type { Post, PostBatch, ResolvedAuthor, RuntimeConfig, SourceQuery, WatchTarget } from '../../../domain/model.js';
import { SourceFailure } from '../../../domain/errors.js';
import { isInstant } from '../../../domain/time.js';
import { RsshubClient } from './client.js';
import { mapFeed, rsshubAuthorId } from './mapper.js';

/** Finite snapshots, not exhaustive X queries. Identity is handle-bound, never a claimed numeric X ID. */
export class RsshubSource implements PostSource {
  readonly capability = 'real';
  get budgeted(): boolean { return this.client.budgeted; }
  private readonly bindings = new Map<string, ResolvedAuthor>();
  private readonly pending = new Map<string, readonly Post[]>();
  constructor(private readonly client: RsshubClient, private readonly clock: Clock, private readonly config: RuntimeConfig['rsshub']) {}
  async resolve(target: WatchTarget, signal?: AbortSignal): Promise<ResolvedAuthor> {
    this.bindings.delete(target.id); this.pending.delete(target.id);
    if (target.provider !== 'rsshub-x' || !/^[a-zA-Z0-9_]{1,15}$/.test(target.handle)) throw new SourceFailure('identity_mismatch', false);
    const posts = mapFeed(await this.client.timeline(target.handle, signal), target, this.config.itemLimit);
    const author = { authorId: rsshubAuthorId(target.handle), handle: target.handle.toLowerCase() };
    this.bindings.set(target.id, author); this.pending.set(target.id, posts); return author;
  }
  async fetch(target: WatchTarget, cursor: string | null, query?: SourceQuery, signal?: AbortSignal): Promise<PostBatch> {
    signal?.throwIfAborted();
    const author = this.bindings.get(target.id);
    if (!author || target.provider !== 'rsshub-x' || author.handle !== target.handle.toLowerCase()) throw new SourceFailure('identity_mismatch', false);
    if (!query || !isInstant(query.from) || !isInstant(query.to) || Date.parse(query.from) >= Date.parse(query.to)
      || Date.parse(query.to) > this.clock.now().getTime() - this.config.safetyLagMs + 1000) throw new SourceFailure('protocol', false);
    if (cursor !== null) {
      let saved: Record<string, unknown>;
      try { saved = JSON.parse(cursor) as Record<string, unknown>; } catch { throw new SourceFailure('protocol', false); }
      if (!saved || saved['v'] !== 1 || saved['provider'] !== 'rsshub' || saved['authorId'] !== author.authorId
        || saved['endAt'] !== query.from) throw new SourceFailure('protocol', false);
    }
    const posts = this.pending.get(target.id) ?? mapFeed(await this.client.timeline(target.handle, signal), target, this.config.itemLimit);
    this.pending.delete(target.id);
    const from = new Date(Math.max(0, Date.parse(query.from) - this.config.overlapMs)).toISOString();
    return { posts: posts.filter(post => Date.parse(post.publishedAt) >= Date.parse(from) && Date.parse(post.publishedAt) < Date.parse(query.to)),
      nextCursor: JSON.stringify({ v: 1, provider: 'rsshub', authorId: author.authorId, endAt: query.to }),
      complete: true, coverageStatus: 'unverified', scope: 'rsshub_timeline_snapshot', coverage: { from, to: query.to } };
  }
}
