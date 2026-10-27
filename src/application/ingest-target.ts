import type { CallGate, Clock, ContentHasher, ExecutionContext, PostSource, WatchStore } from '../domain/ports.js';
import type { AnalysisJob, PostVersion, RuntimeConfig, WatchTarget } from '../domain/model.js';
import { stableId } from '../domain/identifiers.js';
import { IncompleteBatchError, SourceCoverageGap } from '../domain/errors.js';
import { ResolveTarget } from './resolve-target.js';
import { validatePost } from '../domain/validation.js';
import { digestWindowForDay, dueDigestWindow, isInstant, shiftDay } from '../domain/time.js';

export class IngestTarget {
  constructor(private readonly source: PostSource, private readonly store: WatchStore,
    private readonly clock: Clock, private readonly config: RuntimeConfig, private readonly hasher: ContentHasher, private readonly calls?: CallGate) {}
  async execute(target: WatchTarget, context?: ExecutionContext, recheckFrom?: string): Promise<number> {
    if (recheckFrom && !isInstant(recheckFrom)) throw new Error('Invalid report recheck boundary.');
    context?.signal.throwIfAborted();
    if (this.source.capability === 'real' && this.config.mode === 'demo') throw new Error('Demo cannot call a real source.');
    if (this.source.capability === 'real') await new ResolveTarget(this.source, this.store, this.clock, this.config).execute(target, context);
    let identity = this.store.target(target.id);
    const discoveredAt = this.clock.now().toISOString();
    const safetyLagMs = this.config.services.source.provider === 'rsshub' ? this.config.rsshub.safetyLagMs : this.config.x.safetyLagMs;
    const now = this.source.capability === 'real'
      ? new Date(Math.floor((Date.parse(discoveredAt) - safetyLagMs) / 1000) * 1000).toISOString() : discoveredAt;
    if (!identity) {
      if (this.source.capability !== 'simulated') throw new Error('A real source requires a resolved author identity.');
      identity = this.store.registerTarget({ ...target, authorId: `fixture:${target.handle.toLowerCase()}`,
        enabled: true, monitorStartedAt: discoveredAt, configRevision: this.config.revision });
    }
    const checkpoint = this.store.checkpoint(target.id);
    if (checkpoint.observedAt !== null && Date.parse(checkpoint.observedAt) >= Date.parse(now)) return 0;
    const yesterday = dueDigestWindow(new Date(discoveredAt), this.config.timeZone, '00:00')!;
    const query = { from: checkpoint.observedAt ?? digestWindowForDay(
      shiftDay(yesterday.day, 1 - this.config.policy.initialBackfillDays), this.config.timeZone).from, to: now };
    if (recheckFrom && Date.parse(recheckFrom) < Date.parse(query.from)) query.from = recheckFrom;
    const cursor = recheckFrom ? null : checkpoint.cursor;
    let batch;
    try {
      const permit = this.source.capability === 'simulated' ? this.calls?.reserve('source') : undefined;
      const fetch = (signal?: AbortSignal) => permit ? permit.run(() => this.source.fetch(target, cursor, query, signal)) : this.source.fetch(target, cursor, query, signal);
      batch = context ? await context.call(fetch, this.config.services.source.timeoutMs) : await fetch();
    } catch (error) {
      if (error instanceof SourceCoverageGap) this.store.recordCoverageGap({ ...error.range,
        id: stableId('gap', target.id, error.range.from, error.range.to, error.code), targetId: target.id, status: 'gap', reason: error.code,
        scope: 'x_recent_public_index' }, checkpoint.revision);
      throw error;
    }
    context?.signal.throwIfAborted();
    if (!batch.complete) throw new IncompleteBatchError();
    const unverified = batch.coverageStatus === 'unverified';
    if (unverified !== (batch.scope === 'rsshub_timeline_snapshot') || unverified !== (target.provider === 'rsshub-x')) throw new IncompleteBatchError();
    const coverage = batch.coverage ?? query;
    if (coverage.to !== query.to || Date.parse(coverage.from) > Date.parse(query.from)) throw new IncompleteBatchError();
    const posts = new Map<string, PostVersion>(), jobs = new Map<string, AnalysisJob>();
    for (const post of batch.posts) {
      validatePost(post, target);
      if (Date.parse(post.publishedAt) < Date.parse(coverage.from) || Date.parse(post.publishedAt) >= Date.parse(coverage.to))
        throw new Error('Source returned a post outside the requested interval.');
      if (post.origin && post.origin.authorId !== identity.authorId) throw new Error('Source author differs from registered identity.');
      const hash = this.hasher.hash(JSON.stringify(post.origin ? [post.text, post.publishedAt, post.url, post.origin] : [post.text, post.publishedAt, post.url]));
      const versionId = post.origin ? `${post.origin.sourceVersion}:${hash}` : hash;
      const key = stableId('post', target.provider, identity.authorId, post.id, versionId);
      if (this.store.hasPostVersion(key) || posts.has(key)) continue;
      posts.set(key, { ...post, key, provider: target.provider, authorId: identity.authorId, sourceVersion: versionId,
        contentHash: hash, discoveredAt, completeness: post.origin?.completeness ?? 'full', deleted: false });
      const version = this.config.services.analysis.version, prompt = this.config.services.analysis.promptVersion;
      const id = stableId('analysis', key, version, prompt);
      jobs.set(id, { id, postKey: key, targetId: target.id, analyzerVersion: version, promptVersion: prompt,
        configRevision: this.config.revision, emitNotifications: this.config.mode !== 'preview' && (post.origin?.completeness ?? 'full') === 'full',
        state: 'pending', revision: 0, attempts: 0, nextAttemptAt: null });
    }
    const completedAt = this.clock.now().toISOString();
    const observation = Date.parse(completedAt) >= Date.parse(discoveredAt) ? { startedAt: discoveredAt, completedAt } : undefined;
    this.store.commitIngestion({ targetId: target.id, expectedRevision: checkpoint.revision,
      cursor: batch.nextCursor, observedAt: now, coverage: { ...coverage, id: stableId('coverage', target.id, coverage.from, coverage.to, batch.scope ?? 'default'),
        targetId: target.id, ...(observation ? { observation } : {}), status: unverified ? 'gap' : 'complete', reason: unverified ? 'rsshub_snapshot_unverified' : null, ...(batch.scope ? { scope: batch.scope } : {}) },
      posts: [...posts.values()], jobs: [...jobs.values()],
      ...(observation ? { observation } : {}) });
    return posts.size;
  }
}
