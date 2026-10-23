import type { Clock, ContentAnalyzer, NotificationRule, PostSource, WatchStore } from '../domain/ports.js';
import type { AnalyzedPost, WatchTarget } from '../domain/model.js';
import { IncompleteBatchError } from '../domain/errors.js';
import { validateAnalysis, validatePost } from '../domain/validation.js';

export class PollTarget {
  constructor(private readonly source: PostSource, private readonly analyzer: ContentAnalyzer,
    private readonly store: WatchStore, private readonly rules: readonly NotificationRule[],
    private readonly clock: Clock, private readonly recipient: string) {}

  async execute(target: WatchTarget): Promise<number> {
    const checkpoint = this.store.checkpoint(target.id);
    // Capture query start, not completion, for coverage checks.
    const observedAt = this.clock.now().toISOString();
    const batch = await this.source.fetch(target, checkpoint.cursor);
    if (!batch.complete) throw new IncompleteBatchError();
    const posts: AnalyzedPost[] = [];
    const seen = new Set<string>();
    for (const post of batch.posts) {
      validatePost(post, target);
      if (seen.has(post.id) || this.store.hasPost(target.id, post.id)) continue;
      seen.add(post.id);
      const analysis = await this.analyzer.analyze(post);
      validateAnalysis(post, analysis);
      posts.push({ post, analysis });
    }
    const notifications = posts.flatMap(item => this.rules.flatMap(rule =>
      rule.evaluate(item, this.recipient, observedAt)));
    this.store.commitPoll({ targetId: target.id, expectedRevision: checkpoint.revision,
      cursor: batch.nextCursor, observedAt, posts, notifications });
    return posts.length;
  }
}
