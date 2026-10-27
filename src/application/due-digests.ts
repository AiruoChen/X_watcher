import type { Clock, WatchStore } from '../domain/ports.js';
import type { DigestWindow, RuntimeConfig, WatchTarget } from '../domain/model.js';
import { digestWindowForDay, dueDigestWindow, shiftDay } from '../domain/time.js';

/** B03 triggers existing immutable reports. Late-post correction/degraded reports belong to B07. */
export class DueDigests {
  constructor(private readonly store: WatchStore, private readonly clock: Clock, private readonly config: RuntimeConfig) {}
  execute(target: WatchTarget): readonly DigestWindow[] {
    const identity = this.store.target(target.id);
    if (!identity) return [];
    const now = this.clock.now();
    const yesterday = dueDigestWindow(now, this.config.timeZone, '00:00')!.day;
    const latest = dueDigestWindow(now, this.config.timeZone, this.config.dailyDigestAt)?.day ?? shiftDay(yesterday, -1);
    const first = shiftDay(dueDigestWindow(new Date(identity.monitorStartedAt), this.config.timeZone, '00:00')!.day,
      1 - this.config.policy.initialBackfillDays);
    const reported = new Set(this.store.reports(target.id).map(report => report.day));
    const windows: DigestWindow[] = [];
    for (let offset = 1 - this.config.policy.digestCatchUpDays; offset <= 0; offset++) {
      const day = shiftDay(latest, offset);
      if (day >= first && !reported.has(day)) windows.push(digestWindowForDay(day, this.config.timeZone));
    }
    return windows;
  }
}
