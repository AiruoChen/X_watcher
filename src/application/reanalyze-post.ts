import type { WatchStore } from '../domain/ports.js';
import type { AnalysisJob, RuntimeConfig } from '../domain/model.js';
import { stableId } from '../domain/identifiers.js';
export class ReanalyzePost {
  constructor(private readonly store: WatchStore, private readonly config: RuntimeConfig) {}
  /** Explicit new version only; reanalysis never authorizes historical mail. */
  execute(postKey: string): AnalysisJob {
    const post = this.store.postVersion(postKey);
    if (!post) throw new Error('Unknown post version.');
    const analyzerVersion = this.config.services.analysis.version, promptVersion = this.config.services.analysis.promptVersion;
    return this.store.queueAnalysis({ id: stableId('analysis', postKey, analyzerVersion, promptVersion), postKey,
      targetId: post.targetId, analyzerVersion, promptVersion, configRevision: this.config.revision,
      emitNotifications: false, state: 'pending', revision: 0, attempts: 0, nextAttemptAt: null });
  }
}
