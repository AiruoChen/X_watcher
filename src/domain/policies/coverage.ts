import { isInstant } from '../time.js';
import type { Coverage, SourceQuery } from '../model.js';
export function covers(ranges: readonly Coverage[], targetId: string, query: SourceQuery): boolean {
  if (!isInstant(query.from) || !isInstant(query.to)) return false;
  let cursor = Date.parse(query.from);
  const end = Date.parse(query.to);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor >= end) return false;
  for (const range of ranges.filter(r => r.targetId === targetId && r.status === 'complete' && isInstant(r.from) && isInstant(r.to))
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    const from = Date.parse(range.from), to = Date.parse(range.to);
    if (from > cursor) break;
    if (to > cursor) cursor = to;
    if (cursor >= end) return true;
  }
  return false;
}
