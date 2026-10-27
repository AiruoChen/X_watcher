import type { DatabaseSync } from 'node:sqlite';
import { validateHistory } from './migrations.js';
export function inspectDatabase(db: DatabaseSync): number {
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('Database integrity check failed.');
  const version = validateHistory(db);
  for (const table of ['targets','checkpoints','coverage_ranges','post_versions','analysis_jobs','analysis_results',
    'rule_events','digest_reports','notifications','delivery_attempts','runtime_ownership','audit_events','legacy_posts']) {
    db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
  }
  if (version >= 2) {
    db.prepare('SELECT claimed_by FROM analysis_jobs LIMIT 0').all();
    db.prepare('SELECT claimed_by FROM delivery_attempts LIMIT 0').all();
  }
  if (version >= 2) for (const index of ['coverage_target_time','posts_target_time','posts_latest','jobs_target_state','jobs_post',
    'results_post','events_target','notification_state','attempts_notification']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index)) throw new Error('Missing database index.');
  }
  if (!db.prepare('SELECT 1 FROM runtime_ownership WHERE singleton=1').get()) throw new Error('Missing runtime ownership record.');
  if (version >= 3) {
    db.prepare('SELECT revision,state,due_ms,payload FROM runtime_tasks LIMIT 0').all();
    for (const index of ['runtime_task_due', 'notification_priority']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index)) throw new Error('Missing runtime index.');
    }
  }
  if (version >= 4) {
    db.prepare('SELECT revision FROM notifications LIMIT 0').all();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='mail_audit_notification'").get()) throw new Error('Missing mail audit index.');
  }
  if (version >= 5) {
    db.prepare('SELECT next_delivery_ms FROM notifications LIMIT 0').all();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='notification_retry_due'").get()) throw new Error('Missing retry index.');
  }
  if (version >= 6) {
    for (const table of ['source_observations','report_progress','report_boundaries']) db.prepare(`SELECT payload FROM ${table} LIMIT 0`).all();
  }
  if (version >= 7) {
    for (const table of ['usage_ledger','operation_health','operation_incidents','operation_commands','retained_keys']) db.prepare('SELECT payload FROM ' + table + ' LIMIT 0').all();
    db.prepare('SELECT currency,calls,known_micros,unpriced_calls,input_tokens,output_tokens,measured_calls FROM usage_daily LIMIT 0').all();
    if (!db.prepare('SELECT day FROM budget_clock WHERE singleton=1').get()) throw new Error('Missing budget clock.');
    for (const index of ['usage_ledger_day','operation_commands_pending','retained_post_identity']) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index)) throw new Error('Missing operations index.');
  }
  return version;
}
