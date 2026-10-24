import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/adapters/storage/memory-store.js';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { IngestTarget } from '../src/application/ingest-target.js';
import { ProcessAnalysis } from '../src/application/process-analysis.js';
import { FixtureSource } from '../src/adapters/source/fixture-source.js';
import { SemanticResetRule } from '../src/application/rules/semantic-reset-rule.js';
import { analyzer, output, hasher } from './helpers/analysis-mail.js';
import { ManualClock } from '../src/adapters/clock.js';
import { correctionBasis } from '../src/domain/policies/correction.js';
import { seeded } from './contracts/watch-store.contract.js';
import { loadConfig } from '../src/config.js';
import type { Post, SemanticAnalysis } from '../src/domain/model.js';
for (const kind of ['memory','sqlite']) {
  test(kind + ': edit correction links exact prior saved version without an ID in author text', async () => {
    const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    try {
      const config = loadConfig({}), target = config.targets[0]!, clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
      const authorId = 'fixture:' + target.handle.toLowerCase();
      store.registerTarget({ ...target, authorId, enabled: true, monitorStartedAt: '2026-01-01T00:00:00Z', configRevision: config.revision });
      const post = (sourceId: string, text: string, history: string[]): Post => ({
        id: '200', targetId: target.id, text, publishedAt: '2026-01-01T23:00:00Z', url: 'https://example.invalid/' + sourceId,
        origin: { authorId, sourcePostId: sourceId, sourceVersion: sourceId, completeness: 'full', kind: 'original', editHistory: history, references: [] },
      });
      const first = post('200', 'ChatGPT limits reset 2026-01-03T00:00:00Z UTC.', ['200']);
      await new IngestTarget(new FixtureSource([first]), store, clock, config, hasher).execute(target);
      await new ProcessAnalysis(analyzer(output(first)), store, [new SemanticResetRule()], clock, config).execute(target);
      const oldPost = store.versions(target.id)[0]!, oldMail = store.outbox()[0]!;
      clock.advance(1000);
      const second = post('201', 'Correction: ChatGPT limits now reset 2026-01-03T00:00:00Z UTC.', ['200','201']);
      await new IngestTarget({ capability: 'simulated', fetch: async (_target, _cursor, query) => ({
        posts: [second], nextCursor: '2', complete: true, coverage: { from: first.publishedAt, to: query!.to },
      }) }, store, clock, config, hasher).execute(target);
      const value = output(second); value.reset.kind = 'correction';
      await new ProcessAnalysis(analyzer(value), store, [new SemanticResetRule()], clock, config).execute(target);
      const current = store.versions(target.id)[1]!, analysis = store.analysisResult(current.key)!.analysis as SemanticAnalysis;
      assert.equal(analysis.correctionLink?.postKey, oldPost.key);
      assert.equal(analysis.correctionLink?.basis, 'edit_history');
      assert.equal(store.outbox().length, 2); assert.deepEqual(store.outbox()[0], oldMail);
      assert.equal(store.outbox()[1]!.notification.supersedesPostKey, oldPost.key);
      assert.match(store.outbox()[1]!.notification.text, /https:\/\/example.invalid\/200/);
      assert.equal(store.ruleEvents()[1]!.supersedesPostKey, oldPost.key);
      assert.equal(store.previousPostVersion(oldPost.key, null), null); // Never link forward to the later edit.
      assert.equal(store.previousPostVersion(current.key, 'someone-else'), null);
    } finally { if (store instanceof SqliteStore) store.close(); }
  });
}
test('known metadata predecessor may be quoted as an ID but arbitrary guessed IDs are rejected', async () => {
  const config = loadConfig({}), p: Post = { id: '200', targetId: config.targets[0]!.id,
    text: 'Correction: ChatGPT quota schedule has changed.', publishedAt: '2026-01-01T00:00:00Z', url: 'https://example.invalid/201',
    origin: { authorId: 'a', sourcePostId: '201', sourceVersion: '201', completeness: 'full', kind: 'original', editHistory: ['200','201'], references: [] } };
  const value = output(p); value.reset.kind = 'correction'; const withPrior = { ...value, reset: { ...value.reset, previousPostId: '200' } };
  assert.equal((await analyzer(withPrior).analyze(p)).resetDetails?.previousPostId, '200');
  await assert.rejects(analyzer({ ...value, reset: { ...value.reset, previousPostId: '999' } }).analyze(p));
});

for (const kind of ['memory','sqlite']) test(kind + ': fabricated correction links fail before any result or notification is committed', async () => {
  const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
  try {
    const { clock } = await seeded(() => store), config = loadConfig({}), target = config.targets[0]!;
    const p = store.versions(target.id)[0]!, job = store.claimAnalysis(store.analysisJobs(target.id)[0]!.id, clock.now().toISOString())!;
    const value = output(p); value.reset.kind = 'correction';
    const analysis = await analyzer(value).analyze(p);
    const commit = { jobId: job.id, expectedRevision: job.revision, result: { jobId: job.id, postKey: p.key,
      analyzerVersion: job.analyzerVersion, promptVersion: job.promptVersion, completedAt: clock.now().toISOString(),
      analysis: { ...analysis, correctionLink: { postKey: 'forged', postId: p.id, sourcePostId: p.id, url: p.url, basis: 'same_post' as const } } },
      events: [], notifications: [] };
    assert.throws(() => store.commitAnalysis(commit), /correction predecessor/);
    assert.equal(store.analysisResult(p.key), null); assert.equal(store.outbox().length, 0); assert.equal(store.ruleEvents().length, 0);
    assert.equal(store.analysisJobs(target.id)[0]!.state, 'processing');
    const old = { ...p, key: 'prior', sourceVersion: 'old' };
    assert.equal(correctionBasis(p, { ...old, authorId: 'someone-else' }, null), null);
    assert.equal(correctionBasis(p, { ...old, provider: 'foreign' }, null), null);
    assert.equal(correctionBasis(p, { ...old, targetId: 'foreign' }, null), null);
    assert.equal(correctionBasis(p, { ...old, deleted: true }, null), null);
  } finally { if (store instanceof SqliteStore) store.close(); }
});
