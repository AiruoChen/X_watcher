import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './adapters/storage/sqlite/connection.js';
import { transaction } from './adapters/storage/sqlite/transaction.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { temporaryStorage, cleanupStorage } from './adapters/storage/temporary-directory.js';
import { stableId } from './domain/identifiers.js';
import type { AnalysisJob, AnalysisResult, PostVersion, TargetIdentity } from './domain/model.js';

const root = temporaryStorage(), path = join(root, 'benchmark.sqlite'), db = openDatabase(path, true);
const targets = 10, perTarget = 10_000, hash = 'a'.repeat(64), started = performance.now();
try {
  const targetInsert = db.prepare('INSERT INTO targets VALUES(?,?,?,?)');
  const postInsert = db.prepare('INSERT INTO post_versions(key,target_id,post_id,published_ms,payload) VALUES(?,?,?,?,?)');
  const jobInsert = db.prepare('INSERT INTO analysis_jobs(id,post_key,target_id,state,revision,next_ms,payload) VALUES(?,?,?,?,?,?,?)');
  const resultInsert = db.prepare('INSERT INTO analysis_results(job_id,post_key,payload) VALUES(?,?,?)');
  transaction(db, () => {
    for (let t = 0; t < targets; t++) {
      const target: TargetIdentity = { id: `target-${t}`, provider: 'fixture', handle: `fixture${t}`, authorId: `author-${t}`,
        enabled: true, monitorStartedAt: '2025-01-01T00:00:00Z', configRevision: 'benchmark' };
      targetInsert.run(target.id, target.provider, target.authorId, JSON.stringify(target));
      for (let i = 0; i < perTarget; i++) {
        const publishedAt = new Date(Date.UTC(2025,0,1) + i * 3_600_000).toISOString();
        const key = stableId('post', target.provider, target.authorId, `p-${i}`, hash);
        const post: PostVersion = { id: `p-${i}`, targetId: target.id, text: 'Synthetic benchmark data.', publishedAt,
          url: 'https://example.invalid/benchmark', key, provider: target.provider, authorId: target.authorId,
          sourceVersion: hash, contentHash: hash, discoveredAt: publishedAt, completeness: 'full', deleted: false };
        const job: AnalysisJob = { id: stableId('analysis', key, 'fixture', 'v1'), postKey: key, targetId: target.id,
          analyzerVersion: 'fixture', promptVersion: 'v1', configRevision: 'benchmark', emitNotifications: false,
          state: 'completed', revision: 2, attempts: 1, nextAttemptAt: null };
        const result: AnalysisResult = { jobId: job.id, postKey: key, analyzerVersion: 'fixture', promptVersion: 'v1',
          completedAt: publishedAt, analysis: { summary: 'Synthetic summary.', chatgptUpdates: [], reset: null } };
        postInsert.run(key, target.id, post.id, Date.parse(publishedAt), JSON.stringify(post));
        jobInsert.run(job.id, key, target.id, job.state, job.revision, null, JSON.stringify(job));
        resultInsert.run(job.id, key, JSON.stringify(result));
      }
    }
  });
  const seedMs = performance.now() - started;
  const query = { day: '2025-01-02', from: '2025-01-02T00:00:00Z', to: '2025-01-03T00:00:00Z' };
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM post_versions WHERE target_id=? AND published_ms>=? AND published_ms<?')
    .all('target-0', Date.parse(query.from), Date.parse(query.to)).map(row => row['detail']);
  const store = new SqliteStore(path);
  try {
    const before = performance.now(); const posts = store.listPosts('target-0', query); const queryMs = performance.now() - before;
    const queueBefore = performance.now(); const pending = store.pendingAnalysisJobs('target-0', '2026-01-02T00:00:00Z', 100);
    console.log(JSON.stringify({ platform: platform(), release: release(), cpu: cpus()[0]?.model, node: process.version,
      targets, postVersions: targets * perTarget, returnedPosts: posts.length, pendingJobs: pending.length,
      seedMs: Math.round(seedMs), queryMs: Number(queryMs.toFixed(3)), queueQueryMs: Number((performance.now() - queueBefore).toFixed(3)), plan }, null, 2));
    if (posts.length !== 24 || pending.length !== 0 || !plan.some(value => String(value).includes('posts_target_time'))) throw new Error('Benchmark invariants failed.');
  } finally { store.close(); }
} finally { db.close(); cleanupStorage(root); }
