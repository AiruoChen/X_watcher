import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CleanupPlan } from '../../../domain/model.js';
import { isInstant } from '../../../domain/time.js';
import { transaction } from './transaction.js';
import { RuntimeClaims } from './claims.js';
type Row = { id: string; seq: number; value: Record<string, unknown> };
const activeMail = new Set(['pending','sending','retry_wait','needs_attention']);
const activeJobs = new Set(['pending','processing','retry_wait','needs_attention']);
const expired = (value: unknown, cutoff: string): boolean => isInstant(value) && Date.parse(value) < Date.parse(cutoff);
export class SqliteRetention {
  constructor(private readonly db: DatabaseSync, private readonly claims: RuntimeClaims) {}
  private rows(table: string, id = 'id'): Row[] {
    return this.db.prepare('SELECT rowid AS sequence,' + id + ' AS identity,payload FROM ' + table + ' ORDER BY rowid').all()
      .map(r => ({ id: String(r['identity']), seq: Number(r['sequence']), value: JSON.parse(String(r['payload'])) as Record<string, unknown> }));
  }
  private select(at: string, postBefore: string, auditBefore: string) {
    const posts = this.rows('post_versions','key'), jobs = this.rows('analysis_jobs'), results = this.rows('analysis_results','job_id');
    const events = this.rows('rule_events'), reports = this.rows('digest_reports'), notes = this.rows('notifications');
    const postMap = new Map(posts.map(r => [r.id,r])), reportMap = new Map(reports.map(r => [r.id,r]));
    const eventMap = new Map(events.map(r => [r.id,r]));
    const keepPosts = new Set(posts.filter(r => !expired(r.value['discoveredAt'], postBefore) || !expired(r.value['publishedAt'], postBefore)).map(r => r.id));
    const keepNotes = new Set(notes.filter(r => activeMail.has(String(this.db.prepare('SELECT state FROM notifications WHERE id=?').get(r.id)!['state']))
      || !expired(r.value['createdAt'], auditBefore)).map(r => r.id));
    for (const r of this.rows('delivery_attempts')) if (!expired(r.value['finishedAt'] ?? r.value['startedAt'],auditBefore)) keepNotes.add(String(r.value['notificationId']));
    for (const r of this.rows('audit_events','seq')) if (r.value['kind'] === 'mail_resolution' && !expired(r.value['at'] ?? r.value['createdAt'],auditBefore)) keepNotes.add(String(r.value['notificationId']));
    for (const r of results) if (!expired(r.value['completedAt'],postBefore)) keepPosts.add(String(r.value['postKey']));
    const keepReports = new Set(reports.filter(r => !expired(r.value['createdAt'], auditBefore)
      || ['awaiting_data','awaiting_analysis','partial'].includes(String(r.value['state']))).map(r => r.id));
    const pendingTargets = new Set(this.db.prepare("SELECT target_id FROM report_progress WHERE json_extract(payload,'$.state')!='published'").all().map(r => String(r['target_id'])));
    for (const r of posts) if (pendingTargets.has(String(r.value['targetId']))) keepPosts.add(r.id);
    for (const r of jobs) if (activeJobs.has(String(r.value['state']))) keepPosts.add(String(r.value['postKey']));
    for (const r of notes) if (keepNotes.has(r.id)) {
      const origin = String(r.value['originId']); if (reportMap.has(origin)) keepReports.add(origin);
      const event = eventMap.get(origin); if (event) { keepPosts.add(String(event.value['postKey'])); if (event.value['supersedesPostKey']) keepPosts.add(String(event.value['supersedesPostKey'])); }
      if (r.value['supersedesPostKey']) keepPosts.add(String(r.value['supersedesPostKey']));
    }
    const protectReports = [...keepReports];
    while (protectReports.length) {
      const r = reportMap.get(protectReports.pop()!); if (!r) continue;
      const parent = r.value['previousReportId'];
      if (typeof parent === 'string' && !keepReports.has(parent)) { keepReports.add(parent); protectReports.push(parent); }
      for (const key of r.value['postKeys'] as string[] ?? []) keepPosts.add(key);
      for (const c of r.value['changes'] as Record<string, unknown>[] ?? []) if (typeof c['previousPostKey'] === 'string') keepPosts.add(c['previousPostKey']);
    }
    for (const r of notes) if (keepReports.has(String(r.value['originId']))) keepNotes.add(r.id);
    // Follow trusted stored correction links, rather than losing evidence for retained records.
    const links = new Map<string,string[]>();
    for (const r of results) {
      const a = r.value['analysis'] as Record<string,unknown> | undefined;
      const c = a?.['correctionLink'] as Record<string,unknown> | null | undefined;
      if (typeof c?.['postKey'] === 'string') {
        const key = String(r.value['postKey']); links.set(key, [...links.get(key) ?? [], c['postKey']]);
      }
    }
    const queue = [...keepPosts]; while (queue.length) {
      for (const key of links.get(queue.pop()!) ?? []) if (!keepPosts.has(key)) { keepPosts.add(key); queue.push(key); }
    }
    const dropPosts = posts.filter(r => !keepPosts.has(r.id));
    const droppedKeys = new Set(dropPosts.map(r => r.id));
    const dropNotes = notes.filter(r => !keepNotes.has(r.id));
    const noteIds = new Set(dropNotes.map(r => r.id));
    const dropReports = reports.filter(r => !keepReports.has(r.id));
    const dropJobs = jobs.filter(r => droppedKeys.has(String(r.value['postKey'])));
    const jobIds = new Set(dropJobs.map(r => r.id));
    const selection: Record<string, Row[]> = {
      notifications: dropNotes, delivery_attempts: this.rows('delivery_attempts').filter(r => noteIds.has(String(r.value['notificationId']))), digest_reports: dropReports, rule_events: events.filter(r => jobIds.has(String(r.value['jobId']))),
      analysis_results: results.filter(r => droppedKeys.has(String(r.value['postKey']))), analysis_jobs: dropJobs, post_versions: dropPosts,
      coverage_ranges: this.rows('coverage_ranges').filter(r => expired(r.value['to'], postBefore) && !pendingTargets.has(String(r.value['targetId']))
        && ![...keepReports].some(id => { const p = reportMap.get(id)!; return p.value['targetId'] === r.value['targetId']
          && Date.parse(String(p.value['from'])) < Date.parse(String(r.value['to'])) && Date.parse(String(p.value['to'])) > Date.parse(String(r.value['from'])); })),
      audit_events: this.rows('audit_events','seq').filter(r => expired(r.value['createdAt'], auditBefore)
        && (!r.value['notificationId'] || noteIds.has(String(r.value['notificationId'])))),
      usage_ledger: this.rows('usage_ledger').filter(r => ['complete','failed','cancelled'].includes(String(r.value['state'])) && expired(r.value['finishedAt'] ?? r.value['createdAt'], auditBefore)),
      operation_commands: this.rows('operation_commands').filter(r => this.db.prepare('SELECT state FROM operation_commands WHERE id=?').get(r.id)!['state'] !== 'pending'
        && expired(r.value['at'], auditBefore)),
    };
    const counts = Object.fromEntries(Object.entries(selection).map(([t,rs]) => [t,rs.length]));
    const token = createHash('sha256').update(JSON.stringify([at,postBefore,auditBefore,
      Object.entries(selection).map(([t,rs]) => [t,rs.map(r => r.id)]), [...keepPosts].sort(), [...keepReports].sort()])).digest('hex');
    return { plan: { at, postBefore, auditBefore, token, counts, pinnedPosts: posts.filter(r => keepPosts.has(r.id)
      && expired(r.value['discoveredAt'],postBefore) && expired(r.value['publishedAt'],postBefore)).length } as CleanupPlan, selection, postMap };
  }
  plan(at: string, postDays: number, auditDays: number): CleanupPlan {
    if (!isInstant(at) || !Number.isSafeInteger(postDays) || postDays < 1 || postDays > 3650 || !Number.isSafeInteger(auditDays)
      || auditDays < postDays || auditDays > 3650 || Date.parse(at) > Date.parse(this.claims.now()) + 1000) throw new Error('Invalid retention policy/time.');
    this.db.exec('BEGIN');
    try { const plan = this.select(at, new Date(Date.parse(at)-postDays*86400000).toISOString(),
      new Date(Date.parse(at)-auditDays*86400000).toISOString()).plan; this.db.exec('COMMIT'); return plan; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  apply(plan: CleanupPlan): Readonly<Record<string, number>> {
    return transaction(this.db, () => {
      if (this.claims.current() !== null || this.db.prepare("SELECT 1 FROM runtime_tasks WHERE state='running' LIMIT 1").get()
        || this.db.prepare("SELECT 1 FROM analysis_jobs WHERE state='processing' LIMIT 1").get()
        || this.db.prepare("SELECT 1 FROM notifications WHERE state='sending' LIMIT 1").get())
        throw new Error('Stop and reconcile in-flight work before cleanup.');
      if (!isInstant(plan.at) || !isInstant(plan.postBefore) || !isInstant(plan.auditBefore)
        || Date.parse(plan.at)>Date.parse(this.claims.now())+1000 || plan.auditBefore>plan.postBefore || plan.postBefore>=plan.at)
        throw new Error('Invalid cleanup window.');
      const current = this.select(plan.at,plan.postBefore,plan.auditBefore);
      if (current.plan.token !== plan.token) throw new Error('Cleanup plan changed; preview again.');
      const save = (kind: string, row: Row): void => {
        const v=row.value, payload = kind === 'post' ? { key: row.id, postId: v['id'], publishedAt: v['publishedAt'], hash: v['contentHash'], sourceVersion: v['sourceVersion'] }
          : kind === 'report' ? { day: v['day'], revision: v['revision'], state: v['state'] }
          : { kind: v['kind'], createdAt: v['createdAt'] };
        this.db.prepare('INSERT INTO retained_keys VALUES(?,?,?,?)').run(kind,row.id,typeof v['targetId']==='string'?v['targetId']:null,JSON.stringify(payload));
      };
      for (const r of current.selection['post_versions']!) save('post',r);
      for (const r of current.selection['digest_reports']!) save('report',r);
      for (const r of current.selection['notifications']!) save('notification',r);
      for (const [table,id] of [['audit_events','seq'],['delivery_attempts','id'],['notifications','id'],['rule_events','id'],['analysis_results','job_id'],
        ['analysis_jobs','id'],['post_versions','key'],['digest_reports','id'],['coverage_ranges','id'],['usage_ledger','id'],['operation_commands','id']] as const)
        for (const r of current.selection[table]!) this.db.prepare('DELETE FROM ' + table + ' WHERE ' + id + '=?').run(id==='seq'?r.seq:r.id);
      this.db.prepare('INSERT INTO audit_events(payload) VALUES(?)').run(JSON.stringify({ kind:'cleanup',createdAt:this.claims.now(),
        plan:plan.token,counts:current.plan.counts }));
      return current.plan.counts;
    });
  }
  archive(from: string, to: string, targetIds: readonly string[]): readonly Readonly<Record<string,unknown>>[] {
    if (!isInstant(from) || !isInstant(to) || Date.parse(from)>=Date.parse(to) || !targetIds.length) throw new Error('Invalid history export window.');
    const ids = new Set(targetIds), rows: Record<string,unknown>[] = [];
    this.db.exec('BEGIN');
    try {
      for (const [table,id,time] of [['post_versions','key','publishedAt'],['digest_reports','id','createdAt'],['notifications','id','createdAt']] as const)
        for (const r of this.rows(table,id)) if (ids.has(String(r.value['targetId'])) && isInstant(r.value[time])
          && Date.parse(String(r.value[time]))>=Date.parse(from) && Date.parse(String(r.value[time]))<Date.parse(to))
          rows.push({ type:table,id:r.id,data:r.value });
      const keys=new Set(rows.filter(r=>r['type']==='post_versions').map(r=>r['id']));
      for (const r of this.rows('analysis_results','job_id')) if (keys.has(String(r.value['postKey']))) rows.push({type:'analysis_results',id:r.id,data:r.value});
      this.db.exec('COMMIT'); return rows;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
}
