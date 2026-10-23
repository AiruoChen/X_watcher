import type { PostSource } from '../../domain/ports.js';
import type { Post, PostBatch, WatchTarget } from '../../domain/model.js';

/** Cursor belongs to this adapter; application code must never interpret it. */
export class FixtureSource implements PostSource {
  readonly capability = 'simulated';
  constructor(private readonly posts: readonly Post[]) {}
  async fetch(target: WatchTarget, cursor: string | null): Promise<PostBatch> {
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.posts.length) throw new Error('Invalid fixture cursor.');
    return { posts: structuredClone(this.posts.slice(offset).filter(post => post.targetId === target.id)),
      nextCursor: String(this.posts.length), complete: true };
  }
}
