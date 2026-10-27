import type { Clock, ContentAnalyzer, NotificationRule, WatchStore } from '../domain/ports.js';
import type { Notification, RuleEvent, RuntimeConfig, VersionedAnalysis, WatchTarget } from '../domain/model.js';
import { stableId } from '../domain/identifiers.js';
import { resetEligible } from '../domain/policies/reset.js';
import { retryDelay } from '../domain/policies/retry.js';
import { validateAnalysis } from '../domain/validation.js';

export class ProcessAnalysis {
  constructor(private readonly analyzer: ContentAnalyzer, private readonly store: WatchStore,
    private readonly rules: readonly NotificationRule[], private readonly clock: Clock, private readonly config: RuntimeConfig) {}
  async execute(target: WatchTarget): Promise<void> {
    let failed = false;
    for (const candidate of this.store.pendingAnalysisJobs(target.id, this.clock.now().toISOString(), 100)) {
      const job = this.store.claimAnalysis(candidate.id, this.clock.now().toISOString());
      if (!job) continue;
      try {
        const post = this.store.postVersion(job.postKey)!;
        const analysis = await this.analyzer.analyze(post);
        validateAnalysis(post, analysis);
        const now = this.clock.now().toISOString();
        const events: RuleEvent[] = [], notifications: Notification[] = [];
        const identity = this.store.target(target.id)!;
        for (const rule of this.rules) {
          const output = rule.evaluate({ post, analysis }, this.config.recipient, now);
          if (!output.length) continue;
          const eventId = stableId('event', post.key, rule.id, rule.version ?? 'v1');
          events.push({ id: eventId, jobId: job.id, postKey: post.key, targetId: target.id,
            ruleId: rule.id, ruleVersion: rule.version ?? 'v1', createdAt: now });
          const finding = (analysis as Partial<VersionedAnalysis>).resetFinding;
          const normalized = finding && finding.kind !== 'none' ? finding.normalizedAt : null;
          const eligible = resetEligible(post.publishedAt, post.discoveredAt, identity.monitorStartedAt, this.config.policy.resetMaxAgeMs, normalized);
          if (job.emitNotifications && eligible) output.forEach((message, index) => notifications.push({ ...message,
            id: stableId('notification', eventId, String(index)), originId: eventId, configRevision: this.config.revision }));
        }
        this.store.commitAnalysis({ jobId: job.id, expectedRevision: job.revision,
          result: { jobId: job.id, postKey: post.key, analyzerVersion: job.analyzerVersion, promptVersion: job.promptVersion,
            completedAt: now, analysis }, events, notifications });
      } catch {
        const delay = retryDelay(this.config.retry, job.attempts, 0.5);
        this.store.failAnalysis(job.id, job.revision, delay === null ? null : new Date(this.clock.now().getTime() + delay).toISOString());
        failed = true;
      }
    }
    if (failed) throw new Error('Analysis jobs deferred; ingested posts and checkpoint remain saved.');
  }
}
