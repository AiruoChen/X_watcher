import type { ReportBoundary, ReportChange, ReportCommit, ReportInputs, ReportItem, ReportProgress, SemanticAnalysis } from '../model.js';
import { digestWindowForDay, dueDigestWindow, isInstant, shiftDay } from '../time.js';
import { normalizeResetTime } from './reset-time.js';
import { stableId } from '../identifiers.js';
import { RevisionConflictError } from '../errors.js';
import { covers } from './coverage.js';
const dueCache = new Map<string, string>();
export function hasFreshReportCheck(input: ReportInputs, at: string): boolean {
  return covers(input.coverage.filter(c => c.observation && Date.parse(c.observation.startedAt) >= Date.parse(at)), input.targetId, input.window);
}
export function fullyAnalyzed(item: ReportItem): boolean {
  return item.post.deleted || item.result !== null && item.post.completeness === 'full'
    && (item.result.analysis as Partial<SemanticAnalysis>).inputCompleteness !== 'partial';
}
export function validDay(day: string): boolean { return isInstant(day + 'T00:00:00Z'); }
export function reportDueAt(day: string, zone: string, at: string): string {
  if (!validDay(day) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error('Invalid report calendar.');
  const key = JSON.stringify([day, zone, at]), cached = dueCache.get(key);
  if (cached) return cached;
  const save = (value: string): string => { if (dueCache.size > 128) dueCache.clear(); dueCache.set(key, value); return value; };
  const date = shiftDay(day, 1), resolved = normalizeResetTime(date + ' ' + at, zone);
  if (resolved) return save(resolved);
  // On a folded clock use its first occurrence; on a skipped clock use the first later local minute.
  const window = digestWindowForDay(date, zone), format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  for (let t = Date.parse(window.from); t < Date.parse(window.to); t += 60000) if (format.format(new Date(t)) >= at) return save(new Date(t).toISOString());
  throw new Error('Report time cannot be resolved.');
}
export function latestReportDay(now: Date, zone: string, at: string): string {
  const yesterday = dueDigestWindow(now, zone, '00:00')!.day;
  return now.getTime() >= Date.parse(reportDueAt(yesterday, zone, at)) ? yesterday : shiftDay(yesterday, -1);
}
export function reportItemsToken(items: readonly ReportItem[]): string {
  return JSON.stringify(items.map(x => [x.post.key, x.post.contentHash, x.post.deleted, x.result?.jobId ?? null]));
}
export function reportInputToken(input: Omit<ReportInputs, 'token'>): string {
  return JSON.stringify([input.targetId, input.window, input.checkpoint.revision, input.observation,
    input.boundary, input.coverage.map(c => c.id).sort(), input.covered, input.progress?.revision ?? 0, input.previous?.id ?? null, reportItemsToken(input.items)]);
}
export function reportChanges(before: readonly ReportItem[], after: readonly ReportItem[]): readonly ReportChange[] {
  const old = new Map(before.map(x => [x.post.id, x])), current = new Map(after.map(x => [x.post.id, x]));
  const changes: ReportChange[] = [];
  for (const [id, item] of current) {
    const previous = old.get(id);
    const kind = item.post.deleted ? previous && !previous.post.deleted ? 'deleted' : null
      : !previous ? 'late' : previous.post.key !== item.post.key ? 'edited'
      : previous.result?.jobId !== item.result?.jobId ? 'analysis_updated' : null;
    if (kind) changes.push({ postId: id, kind, previousPostKey: previous?.post.key ?? null, postKey: item.post.key });
  }
  for (const [id, item] of old) if (!current.has(id)) changes.push({ postId: id, kind: 'removed', previousPostKey: item.post.key, postKey: null });
  return changes;
}
export function validBoundary(next: ReportBoundary, previous: ReportBoundary | null): void {
  if (!validDay(next.firstDay) || !validDay(next.beforeDay) || next.beforeDay < next.firstDay
    || (previous && (next.firstDay !== previous.firstDay || next.beforeDay < previous.beforeDay))) throw new Error('Invalid report skip boundary.');
}
export function progressChanged(old: ReportProgress | null, next: ReportProgress): boolean {
  return !old || old.state !== next.state || old.incidentOpen !== next.incidentOpen || old.incidentClosed !== next.incidentClosed;
}
export function validateReportCommit(current: ReportInputs, command: ReportCommit): void {
  const { progress, snapshot, notifications } = command;
  if (command.inputs.token !== current.token || progress.revision !== (current.progress?.revision ?? 0) + 1) throw new RevisionConflictError();
  if (progress.targetId !== current.targetId || progress.day !== current.window.day || !isInstant(progress.updatedAt)
    || !['awaiting_data','awaiting_analysis','published'].includes(progress.state)
    || (current.progress?.incidentOpen && !progress.incidentOpen) || (current.progress?.incidentClosed && !progress.incidentClosed))
    throw new Error('Invalid report progress.');
  if ((progress.incidentClosed && !progress.incidentOpen) || (progress.state === 'published' && !snapshot && !current.previous)
    || (progress.state === 'awaiting_analysis' && !current.covered)) throw new Error('Invalid report phase.');
  if (!command.manual && current.boundary && current.window.day < current.boundary.beforeDay) throw new Error('Report skipped by policy.');
  if (snapshot) {
    if (!['daily','addendum'].includes(snapshot.kind) || snapshot.id !== stableId('report', current.targetId, current.window.day, String(snapshot.revision))
      || snapshot.targetId !== current.targetId || snapshot.day !== current.window.day
      || snapshot.from !== current.window.from || snapshot.to !== current.window.to
      || snapshot.revision !== (current.previous?.revision ?? 0) + 1
      || snapshot.previousReportId !== (current.previous?.id ?? null)
      || (snapshot.kind === 'daily') !== (current.previous === null)
      || snapshot.formatVersion !== 1 || !current.covered || !snapshot.sourceComplete || !isInstant(snapshot.createdAt) || !validDay(snapshot.issuedOn)
      || snapshot.postKeys.join('\0') !== current.items.map(x => x.post.key).join('\0')
      || JSON.stringify(snapshot.items) !== JSON.stringify(current.items)
      || !snapshot.text || snapshot.text.length > 90000 || !/^[a-f0-9]{64}$/.test(snapshot.contentHash))
      throw new Error('Invalid report snapshot.');
    const calendar = digestWindowForDay(snapshot.day, snapshot.timeZone);
    if (calendar.from !== snapshot.from || calendar.to !== snapshot.to) throw new Error('Invalid report calendar window.');
    if (progress.state !== 'published' || (snapshot.kind === 'daily' && snapshot.changes.length)) throw new Error('Invalid report phase.');
    const incomplete = current.items.some(x => !fullyAnalyzed(x));
    if (snapshot.analysisComplete === incomplete || (snapshot.state === 'empty') !== (snapshot.kind === 'daily' && current.items.every(x => x.post.deleted))
      || (!snapshot.analysisComplete && snapshot.state !== 'partial') || !['ready','empty','partial'].includes(snapshot.state))
      throw new Error('Invalid report completeness.');
    if (snapshot.kind === 'addendum' && (!snapshot.changes.length || JSON.stringify(snapshot.changes) !== JSON.stringify(reportChanges(current.previousItems, current.items))))
      throw new Error('Invalid report addendum.');
  }
  const allowed = new Set([
    ...(snapshot ? [stableId('notification', snapshot.id)] : []),
    stableId('digest_gap', current.targetId, current.window.day),
    stableId('digest_recovery', current.targetId, current.window.day),
  ]);
  if (new Set(notifications.map(n => n.id)).size !== notifications.length || notifications.some(n => !allowed.has(n.id) || n.targetId !== current.targetId))
    throw new Error('Invalid report notification.');
  const mail = snapshot ? notifications.find(n => n.id === stableId('notification', snapshot.id)) : undefined;
  if (mail && (!snapshot || mail.originId !== snapshot.id || mail.text !== snapshot.text || mail.kind !== 'digest' || snapshot.state === 'empty'))
    throw new Error('Invalid report mail snapshot.');
}
