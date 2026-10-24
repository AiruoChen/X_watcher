import type { Clock, WatchStore } from '../domain/ports.js';
import type { DigestWindow, RuntimeConfig, WatchTarget } from '../domain/model.js';
import { digestWindowForDay, dueDigestWindow, shiftDay } from '../domain/time.js';
import { latestReportDay } from '../domain/policies/reporting.js';

/** Persist a compact skipped range; published days remain eligible for later addenda. */
export class DueDigests {
  constructor(private readonly store: WatchStore, private readonly clock: Clock,
    private readonly config: RuntimeConfig, private readonly includePublished = false) {}
  execute(target: WatchTarget): readonly DigestWindow[] {
    const identity = this.store.target(target.id);
    if (!identity) return [];
    const latest = latestReportDay(this.clock.now(), this.config.timeZone, this.config.dailyDigestAt);
    const previous = this.store.reportBoundary(target.id);
    const first = previous?.firstDay ?? shiftDay(dueDigestWindow(new Date(identity.monitorStartedAt), this.config.timeZone, '00:00')!.day,
      1 - this.config.policy.initialBackfillDays);
    const cutoff = shiftDay(latest, 1 - this.config.policy.digestCatchUpDays);
    const beforeDay = [first, cutoff, previous?.beforeDay ?? first].sort().at(-1)!;
    if (!previous || beforeDay !== previous.beforeDay)
      this.store.recordReportBoundary({ targetId: target.id, firstDay: first, beforeDay });
    const reported = this.includePublished ? new Set<string>() : new Set(this.store.reports(target.id).map(report => report.day));
    const windows: DigestWindow[] = [];
    for (let offset = 1 - this.config.policy.digestCatchUpDays; offset <= 0; offset++) {
      const day = shiftDay(latest, offset);
      if (day >= beforeDay && !reported.has(day)) windows.push(digestWindowForDay(day, this.config.timeZone));
    }
    return windows;
  }
}
