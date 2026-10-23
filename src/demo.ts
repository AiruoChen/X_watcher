import type { Analysis, Post, RuntimeConfig } from './domain/model.js';
import { loadConfig } from './config.js';
import { createApplication } from './bootstrap.js';
import { ManualClock } from './adapters/clock.js';
import { MemoryStore } from './adapters/storage/memory-store.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from './adapters/notification/preview-channel.js';
import { ConsoleEvents } from './adapters/observability/console-events.js';
import { ResetRule } from './application/rules/reset-rule.js';
import { TextDigestRenderer } from './application/digest-renderer.js';

export async function runDemo(config: RuntimeConfig = loadConfig({})): Promise<void> {
  const clock = new ManualClock(new Date('2026-01-02T00:00:00Z'));
  const store = new MemoryStore();
  const channel = new PreviewChannel();
  const posts: Post[] = [];
  const answers = new Map<string, Analysis>();
  for (const target of config.targets) {
    const id = `${target.id}:sample`;
    posts.push({ id, targetId: target.id, publishedAt: '2026-01-01T04:00:00Z',
      text: '[SIMULATED] ChatGPT demo update. Limits reset tomorrow at 09:00 UTC.',
      url: 'https://example.invalid/simulated-post' });
    answers.set(id, { summary: '【模拟】发布了 ChatGPT 功能更新并提及额度重置。',
      chatgptUpdates: ['【模拟】此条仅用于展示摘要格式。'],
      reset: { evidence: 'Limits reset tomorrow at 09:00 UTC.', whenText: 'tomorrow at 09:00', timeZoneText: 'UTC' } });
  }
  const app = createApplication(config, { sources: new Map([['x', new FixtureSource(posts)]]),
    analyzer: new FixtureAnalyzer(answers), notifications: channel, store, clock,
    rules: [new ResetRule()], digestRenderer: new TextDigestRenderer(), events: new ConsoleEvents() });
  console.log('模拟演示：虚构推文、固定时钟、内存存储、邮件预览；没有外部请求。');
  await app.tick();
  await app.tick();
  for (const message of channel.list()) console.log(`\n[预览] ${message.subject}\n${message.text}`);
  console.log(`\n预览数量：${channel.list().length}；再次 tick 不会重复通知。`);
}
