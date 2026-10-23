import type { Clock } from '../domain/ports.js';
export class SystemClock implements Clock { now(): Date { return new Date(); } }
export class ManualClock implements Clock {
  constructor(private instant: Date) { this.instant = new Date(instant); }
  now(): Date { return new Date(this.instant); }
  advance(ms: number): void { this.instant = new Date(this.instant.getTime() + ms); }
}
