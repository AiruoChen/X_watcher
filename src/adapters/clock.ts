import type { Clock } from '../domain/ports.js';
export class SystemClock implements Clock { now(): Date { return new Date(); } monotonicMs(): number { return performance.now(); } }
export class ManualClock implements Clock {
  constructor(private instant: Date) { this.instant = new Date(instant); }
  private elapsed = 0;
  now(): Date { return new Date(this.instant); }
  monotonicMs(): number { return this.elapsed; }
  jumpWallClock(ms: number): void { this.instant = new Date(this.instant.getTime() + ms); }
  advance(ms: number): void { this.elapsed += Math.max(ms, 0); this.instant = new Date(this.instant.getTime() + ms); }
}
