import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { temporaryStorage, cleanupStorage } from './adapters/storage/temporary-directory.js';
import { ManualClock } from './adapters/clock.js';
import { Sha256Hasher } from './adapters/hash.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from './adapters/notification/preview-channel.js';
import { TextDigestRenderer } from './application/digest-renderer.js';
import { ResetRule } from './application/rules/reset-rule.js';
import { createApplication } from './bootstrap.js';
import { loadConfig } from './config.js';
const config = loadConfig({}), target = config.targets[0]!, root = temporaryStorage(), path = join(root, 'demo.sqlite');
const source = new FixtureSource([{ id: 'fixture', targetId: target.id, text: 'Synthetic daily update.',
  publishedAt: '2026-01-01T12:00:00Z', url: 'https://example.invalid/demo' }]);
let store = new SqliteStore(path, { create: true });
try {
  const preview = new PreviewChannel();
  const dependencies = { sources: new Map([['x', source]]), analyzer: new FixtureAnalyzer(new Map([
    ['fixture', { summary: '模拟更新', chatgptUpdates: [], reset: null }],
  ])), notifications: preview, store, clock: new ManualClock(new Date('2026-01-02T00:00:00Z')),
    hasher: new Sha256Hasher(), rules: [new ResetRule()], digestRenderer: new TextDigestRenderer(), events: { record: () => undefined } };
  await createApplication(config, dependencies).tick();
  assert.equal(preview.list().length, 1); assert.equal(store.checkpoint(target.id).revision, 1);
  store.close(); store = new SqliteStore(path);
  await createApplication(config, { ...dependencies, store }).tick();
  assert.equal(preview.list().length, 1); assert.equal(store.reports(target.id).length, 1);
  console.log('SQLite 模拟验证通过：关闭并重新打开后，检查点、分析、日报和通知保留，邮件预览未重复。无真实请求或邮件。');
} finally { store.close(); cleanupStorage(root); }
