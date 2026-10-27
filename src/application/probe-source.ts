import type { Clock, ExecutionContext, PostSource } from '../domain/ports.js';
import type { RuntimeConfig, WatchTarget } from '../domain/model.js';
import { SourceFailure } from '../domain/errors.js';

/** Network read only. No store, checkpoint, model or notification dependency. */
export class ProbeSource {
  constructor(private readonly source: PostSource, private readonly clock: Clock, private readonly config: RuntimeConfig) {}
  async execute(target: WatchTarget, context: ExecutionContext): Promise<Readonly<Record<string, unknown>>> {
    if (this.source.capability !== 'real' || !this.source.resolve) throw new SourceFailure('protocol', false);
    const author = await context.call(signal => this.source.resolve!(target, signal), this.config.services.source.timeoutMs);
    const end = Math.floor((this.clock.now().getTime() - this.config.x.safetyLagMs) / 1000) * 1000;
    const query = { from: new Date(end - 3_600_000).toISOString(), to: new Date(end).toISOString() };
    const batch = await context.call(signal => this.source.fetch(target, null, query, signal), this.config.services.source.timeoutMs);
    return { targetId: target.id, authorId: author.authorId, status: batch.complete ? 'ok' : 'incomplete',
      posts: batch.posts.length, query, scope: 'public_recent_search_index', model: 'deferred', mail: 'disabled' };
  }
}
