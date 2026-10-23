import type { RuntimeConfig } from './domain/model.js';
import type { Clock, ContentAnalyzer, DigestRenderer, EventSink, NotificationChannel,
  NotificationRule, PostSource, WatchJobs, WatchStore } from './domain/ports.js';
import { PollTarget } from './application/poll-target.js';
import { DailyDigest } from './application/daily-digest.js';
import { DeliverNotifications } from './application/deliver-notifications.js';
import { Scheduler } from './runtime/scheduler.js';

export interface Dependencies {
  readonly sources: ReadonlyMap<string, PostSource>;
  readonly analyzer: ContentAnalyzer;
  readonly notifications: NotificationChannel;
  readonly store: WatchStore;
  readonly clock: Clock;
  readonly rules: readonly NotificationRule[];
  readonly digestRenderer: DigestRenderer;
  readonly events: EventSink;
}
/** Composition root: this is the only place that selects and connects implementations. */
export function createApplication(config: RuntimeConfig, deps: Dependencies): Scheduler {
  if (config.mode === 'live') throw new Error('Live mode is not implemented in the framework release.');
  if (deps.analyzer.capability !== 'simulated' || deps.notifications.capability !== 'simulated'
    || [...deps.sources.values()].some(source => source.capability !== 'simulated')) {
    throw new Error('Demo mode cannot use real adapters.');
  }
  for (const target of config.targets) {
    if (!deps.sources.has(target.provider)) throw new Error(`Missing source provider: ${target.provider}`);
  }
  if (new Set(deps.rules.map(rule => rule.id)).size !== deps.rules.length) throw new Error('Duplicate rule ID.');
  const digest = new DailyDigest(deps.store, deps.digestRenderer, config.recipient);
  const delivery = new DeliverNotifications(deps.store, deps.notifications);
  const jobs: WatchJobs = {
    poll: target => {
      const source = deps.sources.get(target.provider);
      if (!source) throw new Error('Missing source provider.');
      return new PollTarget(source, deps.analyzer, deps.store, deps.rules, deps.clock, config.recipient).execute(target);
    },
    digest: (target, window) => digest.execute(target, window, deps.clock.now().toISOString()),
    deliver: () => delivery.execute(),
  };
  return new Scheduler(config, deps.clock, deps.store, jobs, deps.events);
}
