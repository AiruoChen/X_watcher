import assert from 'node:assert/strict';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { ManualClock } from './adapters/clock.js';
import { Sha256Hasher } from './adapters/hash.js';
import { loadConfig } from './config.js';
import { IngestTarget } from './application/ingest-target.js';
import { ProcessAnalysis } from './application/process-analysis.js';
import { BuildReport } from './application/build-report.js';
import { ReportTextRenderer } from './application/report-renderer.js';
import { digestWindowForDay } from './domain/time.js';
import type { Post, ReportSnapshot } from './domain/model.js';

const config = loadConfig({}), target = config.targets[0]!;
const clock = new ManualClock(new Date('2026-01-02T00:00:00Z')), hash = new Sha256Hasher();
const store = new SqliteStore(':memory:', { claims: { clock } });
const window = digestWindowForDay('2026-01-01', config.timeZone);
const sample: Post = { id: 'synthetic-day', targetId: target.id, text: 'Synthetic product discussion.',
  publishedAt: '2026-01-01T12:00:00Z', url: 'https://example.invalid/synthetic-day' };
const answer = { summary: '合成产品讨论，未经独立核验。', chatgptUpdates: [], reset: null };
try {
  const build = new BuildReport(store, hash, new ReportTextRenderer(), config);
  await new IngestTarget(new FixtureSource([sample]), store, clock, config, hash).execute(target);
  build.execute(target, window, clock.now().toISOString());
  assert.equal(store.reportProgress(target.id, window.day)!.state, 'awaiting_analysis');
  clock.advance(15 * 60000); build.execute(target, window, clock.now().toISOString());
  const first = store.reports(target.id)[0] as ReportSnapshot;
  assert.equal(first.state, 'partial');
  await new ProcessAnalysis(new FixtureAnalyzer(new Map([[sample.id, answer]])), store, [], clock, config).execute(target);
  assert.equal(build.execute(target, window, clock.now().toISOString()), false);
  clock.advance(86400000);
  await new IngestTarget(new FixtureSource([sample]), store, clock, config, hash).execute(target, undefined, window.from);
  build.execute(target, window, clock.now().toISOString());
  const addon = store.reports(target.id)[1] as ReportSnapshot;
  assert.equal(addon.previousReportId, first.id); assert.equal(addon.kind, 'addendum');
  assert.deepEqual(store.reports(target.id)[0], first);
  assert.equal(store.deliveryAttempts().length, 0);
  console.log('Offline reporting demo: awaiting_analysis → partial → next-day addendum; immutable snapshots and 2 local outbox entries.');
  console.log('No source network, model API or email transport was used.');
} finally { store.close(); }
