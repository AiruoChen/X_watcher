import type { DigestWindow } from './model.js';

function localParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
}
function dayString(parts: Record<string, string>): string {
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}
export function shiftDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
/** Resolve local midnight. Fail closed for unsupported historical midnight transitions. */
function midnight(day: string, timeZone: string): string {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let instant = wall;
  for (let i = 0; i < 5; i++) {
    const p = localParts(new Date(instant), timeZone);
    const shown = Date.parse(`${dayString(p)}T${p['hour']}:${p['minute']}:${p['second']}Z`);
    const delta = wall - shown;
    if (delta === 0) return new Date(instant).toISOString();
    instant += delta;
  }
  throw new Error('Cannot resolve local midnight for configured time zone.');
}
/** A digest is due only after the configured local time; it covers yesterday in full. */
export function dueDigestWindow(now: Date, timeZone: string, at: string): DigestWindow | null {
  const p = localParts(now, timeZone);
  if (`${p['hour']}:${p['minute']}` < at) return null;
  const today = dayString(p);
  const yesterday = shiftDay(today, -1);
  return { day: yesterday, from: midnight(yesterday, timeZone), to: midnight(today, timeZone) };
}

export function digestWindowForDay(day: string, timeZone: string): DigestWindow {
  return { day, from: midnight(day, timeZone), to: midnight(shiftDay(day, 1), timeZone) };
}

/** Calendar-valid ISO instants only; Date.parse alone normalizes impossible dates. */
export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60
    && (match[7] === 'Z' || (Number(match[8]) <= 23 && Number(match[9]) < 60))
    && Number.isFinite(Date.parse(value));
}
