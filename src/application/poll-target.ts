import type { Clock, ContentAnalyzer, ContentHasher, NotificationRule, PostSource, WatchStore } from '../domain/ports.js';
import type { RuntimeConfig, WatchTarget } from '../domain/model.js';
import { IngestTarget } from './ingest-target.js';
import { ProcessAnalysis } from './process-analysis.js';
/** Compatibility facade; individual stages are reusable independently. */
export class PollTarget {
  private readonly ingest: IngestTarget;
  private readonly analysis: ProcessAnalysis;
  constructor(source: PostSource, analyzer: ContentAnalyzer, store: WatchStore,
    rules: readonly NotificationRule[], clock: Clock, config: RuntimeConfig, hasher: ContentHasher) {
    this.ingest = new IngestTarget(source, store, clock, config, hasher);
    this.analysis = new ProcessAnalysis(analyzer, store, rules, clock, config);
  }
  async execute(target: WatchTarget): Promise<number> {
    const count = await this.ingest.execute(target);
    await this.analysis.execute(target);
    return count;
  }
}
