import type { Clock, ContentHasher, PostSource, WatchStore } from '../domain/ports.js';
import type { AnalysisJob, PostVersion, RuntimeConfig, WatchTarget } from '../domain/model.js';
import { stableId } from '../domain/identifiers.js';
import { IncompleteBatchError } from '../domain/errors.js';
import { validatePost } from '../domain/validation.js';
import { digestWindowForDay, dueDigestWindow, shiftDay } from '../domain/time.js';

export class IngestTarget {
  constructor(private readonly source: PostSource, private readonly store: WatchStore,
    private readonly clock: Clock, private readonly config: RuntimeConfig, private readonly hasher: ContentHasher) {}
  async execute(target: WatchTarget): Promise<number> {
    let identity = this.store.target(target.id);
    const now = this.clock.now().toISOString();
    if (!identity) {
      if (this.source.capability !== 'simulated') throw new Error('A real source requires a resolved author identity.');
      identity = this.store.registerTarget({ ...target, authorId: `fixture:${target.handle.toLowerCase()}`,
        enabled: true, monitorStartedAt: now, configRevision: this.config.revision });
    }
    const checkpoint = this.store.checkpoint(target.id);
    if (checkpoint.observedAt !== null && Date.parse(checkpoint.observedAt) >= Date.parse(now)) return 0;
    const yesterday = dueDigestWindow(new Date(now), this.config.timeZone, '00:00')!;
    const query = { from: checkpoint.observedAt ?? digestWindowForDay(
      shiftDay(yesterday.day, 1 - this.config.policy.initialBackfillDays), this.config.timeZone).from, to: now };
    const batch = await this.source.fetch(target, checkpoint.cursor, query);
    if (!batch.complete) throw new IncompleteBatchError();
    const posts = new Map<string, PostVersion>(), jobs = new Map<string, AnalysisJob>();
    const oldKeys = new Set(this.store.versions(target.id).map(p => p.key));
    for (const post of batch.posts) {
      validatePost(post, target);
      if (Date.parse(post.publishedAt) < Date.parse(query.from) || Date.parse(post.publishedAt) >= Date.parse(query.to))
        throw new Error('Source returned a post outside the requested interval.');
      const hash = this.hasher.hash(JSON.stringify([post.text, post.publishedAt, post.url]));
      const key = stableId('post', target.provider, identity.authorId, post.id, hash);
      if (oldKeys.has(key) || posts.has(key)) continue;
      posts.set(key, { ...post, key, provider: target.provider, authorId: identity.authorId, sourceVersion: hash,
        contentHash: hash, discoveredAt: now, completeness: 'full', deleted: false });
      const version = this.config.services.analysis.version, prompt = this.config.services.analysis.promptVersion;
      const id = stableId('analysis', key, version, prompt);
      jobs.set(id, { id, postKey: key, targetId: target.id, analyzerVersion: version, promptVersion: prompt,
        configRevision: this.config.revision, emitNotifications: true, state: 'pending', revision: 0, attempts: 0, nextAttemptAt: null });
    }
    this.store.commitIngestion({ targetId: target.id, expectedRevision: checkpoint.revision,
      cursor: batch.nextCursor, observedAt: now, coverage: { ...query, id: stableId('coverage', target.id, query.from, query.to),
        targetId: target.id, status: 'complete', reason: null }, posts: [...posts.values()], jobs: [...jobs.values()] });
    return posts.size;
  }
}
