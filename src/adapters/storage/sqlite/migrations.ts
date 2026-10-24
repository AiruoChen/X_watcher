import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './transaction.js';
export interface Migration { readonly version: number; readonly sql: string }
export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: `
CREATE TABLE targets(id TEXT PRIMARY KEY, provider TEXT NOT NULL, author_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(provider,author_id)) STRICT;
CREATE TABLE checkpoints(target_id TEXT PRIMARY KEY REFERENCES targets(id), revision INTEGER NOT NULL CHECK(revision>=0), cursor TEXT, observed_at TEXT) STRICT;
CREATE TABLE coverage_ranges(id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES targets(id), start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL CHECK(end_ms>start_ms), status TEXT NOT NULL CHECK(status IN ('complete','gap')), payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE post_versions(seq INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, target_id TEXT NOT NULL REFERENCES targets(id), post_id TEXT NOT NULL, published_ms INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE analysis_jobs(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, post_key TEXT NOT NULL REFERENCES post_versions(key), target_id TEXT NOT NULL REFERENCES targets(id), state TEXT NOT NULL CHECK(state IN ('pending','processing','retry_wait','completed','needs_attention')), revision INTEGER NOT NULL CHECK(revision>=0), next_ms INTEGER, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE analysis_results(seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES analysis_jobs(id), post_key TEXT NOT NULL REFERENCES post_versions(key), payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE rule_events(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL REFERENCES analysis_jobs(id), target_id TEXT NOT NULL REFERENCES targets(id), payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE digest_reports(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, target_id TEXT NOT NULL REFERENCES targets(id), day TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(target_id,day,revision)) STRICT;
CREATE TABLE notifications(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('pending','sending','provider_accepted','delivered','bounced','retry_wait','failed','needs_attention')), payload TEXT NOT NULL CHECK(json_valid(payload)), result TEXT CHECK(result IS NULL OR json_valid(result))) STRICT;
CREATE TABLE delivery_attempts(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, notification_id TEXT NOT NULL REFERENCES notifications(id), number INTEGER NOT NULL CHECK(number>=1), payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(notification_id,number)) STRICT;
CREATE TABLE runtime_ownership(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, payload TEXT) STRICT;
INSERT INTO runtime_ownership VALUES(1,0,NULL);
CREATE TABLE audit_events(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE legacy_posts(target_id TEXT NOT NULL REFERENCES targets(id), post_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(target_id,post_id)) STRICT;
` }, { version: 2, sql: `
ALTER TABLE analysis_jobs ADD COLUMN claimed_by TEXT;
ALTER TABLE delivery_attempts ADD COLUMN claimed_by TEXT;
CREATE INDEX coverage_target_time ON coverage_ranges(target_id,status,start_ms,end_ms);
CREATE INDEX posts_target_time ON post_versions(target_id,published_ms,seq);
CREATE INDEX posts_latest ON post_versions(target_id,post_id,seq DESC);
CREATE INDEX jobs_target_state ON analysis_jobs(target_id,state,next_ms);
CREATE INDEX jobs_post ON analysis_jobs(post_key);
CREATE INDEX results_post ON analysis_results(post_key,seq DESC);
CREATE INDEX events_target ON rule_events(target_id,seq);
CREATE INDEX notification_state ON notifications(state,seq);
CREATE INDEX attempts_notification ON delivery_attempts(notification_id,seq);
` }, { version: 3, sql: `
CREATE TABLE runtime_tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL CHECK(state IN ('idle','running','needs_attention')), due_ms INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE INDEX runtime_task_due ON runtime_tasks(state,due_ms);
CREATE INDEX notification_priority ON notifications(state,(CASE WHEN json_extract(payload,'$.kind') IN ('reset','correction') THEN 0 ELSE 1 END),seq);
` }, { version: 4, sql: `
ALTER TABLE notifications ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0);
CREATE INDEX mail_audit_notification ON audit_events(json_extract(payload,'$.notificationId'),seq) WHERE json_extract(payload,'$.kind')='mail_resolution';
` }];
export const SCHEMA_VERSION = MIGRATIONS.length;
const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');
export function validateHistory(db: DatabaseSync, steps: readonly Migration[] = MIGRATIONS): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!['user_version']);
  if (version < 1 || version > steps.length) throw new Error('Unknown or unsupported database schema.');
  const history = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
  if (history.length !== version || history.some((row, i) => row['version'] !== i + 1 || row['checksum'] !== checksum(steps[i]!.sql)))
    throw new Error('Migration history mismatch.');
  return version;
}
export function migrate(db: DatabaseSync, initialize = false, steps: readonly Migration[] = MIGRATIONS): void {
  transaction(db, () => {
    const before = initialize ? 0 : validateHistory(db, steps);
    if (initialize) db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT');
    for (const step of steps.slice(before)) {
      db.exec(step.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(step.version, checksum(step.sql));
      db.exec(`PRAGMA user_version=${step.version}`);
    }
  });
}
