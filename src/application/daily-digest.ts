import type { DigestRenderer, WatchStore } from '../domain/ports.js';
import type { DigestWindow, WatchTarget } from '../domain/model.js';

export class DailyDigest {
  constructor(private readonly store: WatchStore, private readonly renderer: DigestRenderer,
    private readonly recipient: string) {}

  execute(target: WatchTarget, window: DigestWindow, now: string): boolean {
    const lastPoll = this.store.checkpoint(target.id).observedAt;
    if (!lastPoll || Date.parse(lastPoll) < Date.parse(window.to)) return false;
    const posts = this.store.listPosts(target.id, window);
    // The requested daily email is sent only when there are posts for that day.
    if (posts.length === 0) return false;
    return this.store.enqueue({ id: `digest:${target.id}:${window.day}`, kind: 'digest',
      targetId: target.id, recipient: this.recipient, createdAt: now,
      subject: `@${target.handle} 每日摘要 · ${window.day}`,
      text: this.renderer.render(target, window, posts) });
  }
}
