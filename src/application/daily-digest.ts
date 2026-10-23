import type { ContentHasher, DigestRenderer, WatchStore } from '../domain/ports.js';
import type { DigestWindow, WatchTarget } from '../domain/model.js';
import { stableId } from '../domain/identifiers.js';

export class DailyDigest {
  constructor(private readonly store: WatchStore, private readonly renderer: DigestRenderer,
    private readonly recipient: string, private readonly hasher: ContentHasher,
    private readonly timeZone: string, private readonly configRevision: string) {}
  execute(target: WatchTarget, window: DigestWindow, now: string): boolean {
    if (!this.store.isCovered(target.id, window)) return false;
    const latest = new Map<string, typeof versions[number]>();
    const versions = this.store.versions(target.id);
    for (const post of versions) latest.set(post.id, post);
    const source = [...latest.values()].filter(p => !p.deleted && Date.parse(p.publishedAt) >= Date.parse(window.from) && Date.parse(p.publishedAt) < Date.parse(window.to));
    if (source.some(p => !this.store.analysisResult(p.key))) return false;
    const id = stableId('report', target.id, window.day, '1');
    const posts = this.store.listPosts(target.id, window);
    const text = this.renderer.render(target, window, posts);
    const empty = source.length === 0;
    const created = this.store.createReportWithNotification({ ...window, id, targetId: target.id, revision: 1,
      timeZone: this.timeZone, state: empty ? 'empty' : 'ready', postKeys: source.map(p => p.key),
      contentHash: this.hasher.hash(text), createdAt: now, configRevision: this.configRevision }, empty ? null : {
      id: stableId('notification', id), kind: 'digest', originId: id, targetId: target.id,
      recipient: this.recipient, configRevision: this.configRevision, createdAt: now,
      subject: `@${target.handle} 每日摘要 · ${window.day}`, text });
    return created && !empty;
  }
}
