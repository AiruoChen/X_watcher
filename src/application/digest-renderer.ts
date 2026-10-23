import type { DigestRenderer } from '../domain/ports.js';
import type { AnalyzedPost, DigestWindow, WatchTarget } from '../domain/model.js';

export class TextDigestRenderer implements DigestRenderer {
  render(target: WatchTarget, window: DigestWindow, posts: readonly AnalyzedPost[]): string {
    const summary = posts.map(item => `- ${item.analysis.summary}\n  ${item.post.url}`);
    const updates = posts.flatMap(item => item.analysis.chatgptUpdates.map(update =>
      `- ${update}\n  ${item.post.url}`));
    return [`@${target.handle} · ${window.day}`, '今天说了什么', ...summary,
      '', 'ChatGPT 更新（据推文整理，未独立核实）',
      ...(updates.length ? updates : ['未发现明确的 ChatGPT 更新。'])].join('\n');
  }
}
