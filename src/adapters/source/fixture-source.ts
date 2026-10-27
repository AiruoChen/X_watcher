import type { PostSource } from '../../domain/ports.js';
import type { Post, PostBatch, SourceQuery, WatchTarget } from '../../domain/model.js';

/** Cursor belongs to this adapter; application code must never interpret it. */
export class FixtureSource implements PostSource {
  readonly capability = 'simulated';
  constructor(private readonly posts: readonly Post[]) {}
  async fetch(target: WatchTarget, cursor: string | null, query?: SourceQuery): Promise<PostBatch> {
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.posts.length) throw new Error('Invalid fixture cursor.');
    const ordered = this.posts.filter(p => p.targetId === target.id)
      .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id));
    let next = offset;
    const posts: Post[] = [];
    while (next < ordered.length) {
      const post = ordered[next]!;
      if (query && Date.parse(post.publishedAt) >= Date.parse(query.to)) break;
      next++;
      if (!query || Date.parse(post.publishedAt) >= Date.parse(query.from)) posts.push(post);
    }
    return { posts: structuredClone(posts), nextCursor: String(next), complete: true };
  }
}
