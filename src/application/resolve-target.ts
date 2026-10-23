import type { Clock, ExecutionContext, PostSource, WatchStore } from '../domain/ports.js';
import type { RuntimeConfig, TargetIdentity, WatchTarget } from '../domain/model.js';
import { SourceFailure } from '../domain/errors.js';

export class ResolveTarget {
  constructor(private readonly source: PostSource, private readonly store: WatchStore,
    private readonly clock: Clock, private readonly config: RuntimeConfig) {}
  async execute(target: WatchTarget, context?: ExecutionContext): Promise<TargetIdentity> {
    if (!this.source.resolve) throw new SourceFailure('identity_mismatch', false);
    const resolve = (signal?: AbortSignal) => this.source.resolve!(target, signal);
    const author = context ? await context.call(resolve, this.config.services.source.timeoutMs) : await resolve();
    context?.signal.throwIfAborted();
    const old = this.store.target(target.id);
    if (old && (!old.enabled || old.provider !== target.provider || old.authorId !== author.authorId
      || old.handle.toLowerCase() !== target.handle.toLowerCase())) throw new SourceFailure('identity_mismatch', false);
    return old ?? this.store.registerTarget({ ...target, handle: author.handle, authorId: author.authorId,
      enabled: true, monitorStartedAt: this.clock.now().toISOString(), configRevision: this.config.revision });
  }
}
