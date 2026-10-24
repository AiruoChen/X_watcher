import { isInstant } from '../time.js';
const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
type Zone = { offset: number } | { name: string };
function zone(text: string): Zone | null {
  if (['UTC','GMT','Z'].includes(text)) return { offset: 0 };
  if (text === '北京时间') return { offset: 480 };
  const fixed = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (fixed) {
    const hours = Number(fixed[2]), minutes = Number(fixed[3] ?? 0);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
    return { offset: (fixed[1] === '-' ? -1 : 1) * (hours * 60 + minutes) };
  }
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(text)) return null; // PST/CST etc. are ambiguous.
  try { new Intl.DateTimeFormat('en', { timeZone: text }); return { name: text }; } catch { return null; }
}
const pad = (n: string | number, width = 2): string => String(n).padStart(width, '0');
function wallTime(input: string): number | null {
  let year: string, month: string, day: string, clock: string;
  const numeric = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(.+)$/.exec(input);
  const chinese = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(.+)$/.exec(input);
  const english = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\s+(?:at\s+)?(.+)$/i.exec(input);
  const american = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(?:at\s+)?(.+)$/i.exec(input);
  if (numeric || chinese) {
    const m = (numeric ?? chinese)!; year = m[1]!; month = pad(m[2]!); day = pad(m[3]!); clock = m[4]!;
  } else if (english || american) {
    const m = (english ?? american)!;
    const name = english ? m[2]! : m[1]!, index = months.indexOf(name.slice(0, 3).toLowerCase());
    const full = ['january','february','march','april','may','june','july','august','september','october','november','december'][index];
    if (index < 0 || ![months[index], full].includes(name.toLowerCase())) return null;
    year = m[3]!; month = pad(index + 1); day = pad(english ? m[1]! : m[2]!); clock = m[4]!;
  } else return null;
  const t = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:\.(\d{1,3}))?\s*(AM|PM)?$/i.exec(clock);
  const c = /^(上午|下午|晚上|中午)?\s*(\d{1,2})[点时](?:(\d{1,2})分?)?(?:(\d{1,2})秒)?$/.exec(clock);
  if (!t && !c) return null;
  let hour = Number(t ? t[1] : c![2]);
  const minute = Number(t ? t[2] ?? 0 : c![3] ?? 0), second = Number(t ? t[3] ?? 0 : c![4] ?? 0);
  const period = t ? t[5]?.toUpperCase() : c![1] ? c![1] === '上午' ? 'AM' : 'PM' : undefined;
  if (period) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (period === 'PM' ? 12 : 0); }
  const stamp = year + '-' + month + '-' + day + 'T' + pad(hour) + ':' + pad(minute) + ':' + pad(second)
    + (t?.[4] ? '.' + t[4].padEnd(3, '0') : '') + 'Z';
  return isInstant(stamp) ? Date.parse(stamp) : null;
}
function resolve(wall: number, z: Zone): string | null {
  if ('offset' in z) return new Date(wall - z.offset * 60000).toISOString();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: z.name, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const shown = (at: number): number => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(at)).map(x => [x.type, x.value]));
    return Date.parse(pad(p['year']!, 4) + '-' + p['month'] + '-' + p['day'] + 'T' + p['hour'] + ':' + p['minute'] + ':' + p['second'] + 'Z');
  };
  const candidates = new Set<string>();
  for (const hours of [-36,-24,-12,-6,0,6,12,24,36]) {
    const sample = Math.floor((wall + hours * 3600000) / 1000) * 1000;
    const offset = shown(sample) - sample, candidate = wall - offset;
    if (shown(candidate) === Math.floor(wall / 1000) * 1000) candidates.add(new Date(candidate).toISOString());
  }
  return candidates.size === 1 ? [...candidates][0]! : null; // DST folds and gaps remain unknown.
}
/** Deterministic grammar only. Never use host timezone, Date.parse natural language, or model-generated dates. */
export function normalizeResetTime(when: string | null, timeZone: string | null): string | null {
  if (when === null) return null;
  if (isInstant(when)) {
    if (timeZone === null) return new Date(when).toISOString();
    const z = zone(timeZone), wall = wallTime(when.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ''));
    const checked = z && wall !== null ? resolve(wall, z) : null;
    return checked !== null && Date.parse(checked) === Date.parse(when) ? checked : null;
  }
  const suffix = /^(.*?)\s+(UTC(?:[+-]\d{1,2}(?::?\d{2})?)?|GMT(?:[+-]\d{1,2}(?::?\d{2})?)?|Z|[+-]\d{2}:?\d{2}|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|[A-Z]{3,5}|北京时间)$/.exec(when);
  const body = suffix ? suffix[1]! : when, attached = suffix?.[2] ?? null, wall = wallTime(body);
  const labels = [attached, timeZone].filter((value): value is string => value !== null);
  if (wall === null || !labels.length) return null;
  const instants = labels.map(label => { const z = zone(label); return z ? resolve(wall, z) : null; });
  return instants.every(value => value !== null && value === instants[0]) ? instants[0]! : null;
}
