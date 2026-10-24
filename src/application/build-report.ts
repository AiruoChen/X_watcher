import type { ContentHasher, ReportRenderer, WatchStore } from '../domain/ports.js';
import type { DigestWindow, Notification, ReportProgress, ReportSnapshot, ReportView, RuntimeConfig, WatchTarget } from '../domain/model.js';
import { isInstant } from '../domain/time.js';
import { fullyAnalyzed, hasFreshReportCheck, latestReportDay, progressChanged, reportChanges, reportDueAt } from '../domain/policies/reporting.js';
import { stableId } from '../domain/identifiers.js';
export class BuildReport {
  constructor(private readonly store: WatchStore, private readonly hasher: ContentHasher,
    private readonly renderer: ReportRenderer, private readonly config: RuntimeConfig) {}
  preview(target: WatchTarget, window: DigestWindow, now: string, allowPartial = false): ReportView & { text: string } {
    if (!isInstant(now)) throw new Error('Invalid report time.');
    const input = this.store.reportInputs(target.id, window);
    if (!input.covered && !allowPartial) throw new Error('Source coverage is incomplete; explicit --partial is required.');
    const view: ReportView = { handle: target.handle, window, timeZone: this.config.timeZone, issuedOn: latestReportDay(new Date(now), this.config.timeZone, this.config.dailyDigestAt),
      generatedAt: now, kind: input.covered ? 'daily' : 'partial', sourceComplete: input.covered,
      analysisComplete: input.items.every(fullyAnalyzed), items: input.items, changes: [] };
    return { ...view, text: this.renderer.render(view) };
  }
  execute(target: WatchTarget, window: DigestWindow, now: string, manual = false, enqueue = true): boolean {
    if (!isInstant(now)) throw new Error('Invalid report time.');
    const issuedOn = latestReportDay(new Date(now), this.config.timeZone, this.config.dailyDigestAt);
    if (Date.parse(window.to) > Date.parse(now)) {
      if (manual) throw new Error('Manual generation requires a finished natural-day window.');
      return false;
    }
    if (!manual && window.day > issuedOn) return false;
    const input = this.store.reportInputs(target.id, window), previous = input.previous;
    const changes = previous ? reportChanges(input.previousItems, input.items) : [];
    const previousIssued = previous ? (previous as Partial<ReportSnapshot>).issuedOn
      ?? latestReportDay(new Date(previous.createdAt), this.config.timeZone, this.config.dailyDigestAt) : null;
    if (previous && (!changes.length || (!manual && previousIssued !== null && previousIssued >= issuedOn))) return false;
    if (!manual && input.boundary && window.day < input.boundary.beforeDay) return false;
    if (manual && !input.covered) throw new Error('Manual generation requires complete source coverage; use digest:preview --partial.');
    const fresh = manual || hasFreshReportCheck(input, reportDueAt(issuedOn, this.config.timeZone, this.config.dailyDigestAt));
    const sourceComplete = input.covered && fresh, analysisComplete = input.items.every(fullyAnalyzed);
    const overdue = Date.parse(now) >= Date.parse(reportDueAt(window.day, this.config.timeZone, this.config.dailyDigestAt))
      + this.config.policy.digestGraceMinutes * 60000;
    const progress: ReportProgress = { targetId: target.id, day: window.day, revision: (input.progress?.revision ?? 0) + 1,
      state: sourceComplete ? analysisComplete || overdue || manual ? 'published' : 'awaiting_analysis' : 'awaiting_data',
      incidentOpen: input.progress?.incidentOpen ?? false, incidentClosed: input.progress?.incidentClosed ?? false, updatedAt: now };
    const notifications: Notification[] = [];
    const incident = (recovery: boolean): Notification => ({ id: stableId(recovery ? 'digest_recovery' : 'digest_gap', target.id, window.day),
      targetId: target.id, kind: 'service_alert', originId: stableId('report_progress', target.id, window.day),
      recipient: this.config.recipient, configRevision: this.config.revision, createdAt: now,
      subject: '@' + target.handle + ' 日报' + (recovery ? '来源恢复' : '延迟：来源覆盖未确认') + ' · ' + window.day,
      text: (recovery ? '来源补查已成功，日报按实际完整度生成。' : '完整性补查尚未成功，日报保持 awaiting_data，不能把失败视为没有新帖。')
        + '\n报告日期：' + window.day + '\n范围：' + window.from + ' 至 ' + window.to + '\n记录时间：' + now });
    if (!sourceComplete && overdue && input.progress && !progress.incidentOpen) {
      if (enqueue) notifications.push(incident(false));
      Object.assign(progress, { incidentOpen: true });
    }
    if (sourceComplete && progress.incidentOpen && !progress.incidentClosed) {
      if (enqueue) notifications.push(incident(true));
      Object.assign(progress, { incidentClosed: true });
    }
    let snapshot: ReportSnapshot | null = null;
    if (progress.state === 'published') {
      const revision = (previous?.revision ?? 0) + 1, id = stableId('report', target.id, window.day, String(revision));
      const empty = !previous && input.items.every(x => x.post.deleted);
      const view: ReportView = { handle: target.handle, window, timeZone: this.config.timeZone, issuedOn, generatedAt: now,
        kind: previous ? 'addendum' : 'daily', sourceComplete: true, analysisComplete, items: input.items, changes };
      const text = this.renderer.render(view);
      snapshot = { ...window, id, targetId: target.id, timeZone: this.config.timeZone, revision,
        state: empty ? 'empty' : analysisComplete ? 'ready' : 'partial', postKeys: input.items.map(x => x.post.key),
        contentHash: this.hasher.hash(text), createdAt: now, configRevision: this.config.revision, formatVersion: 1,
        kind: view.kind === 'addendum' ? 'addendum' : 'daily', issuedOn, previousReportId: previous?.id ?? null,
        items: input.items, changes, sourceComplete: true, analysisComplete, text };
      if (enqueue && !empty) notifications.push({ id: stableId('notification', id), originId: id, targetId: target.id,
        recipient: this.config.recipient, configRevision: this.config.revision, kind: 'digest', createdAt: now,
        subject: '@' + target.handle + (previous ? ' 历史补充 · ' : window.day < issuedOn ? ' [补报] 每日摘要 · ' : ' 每日摘要 · ') + window.day
          + (!analysisComplete ? '（部分内容待分析）' : ''), text });
    }
    if (!snapshot && !notifications.length && !progressChanged(input.progress, progress)) return false;
    return this.store.commitReport({ inputs: input, progress, snapshot, notifications, manual });
  }
}
