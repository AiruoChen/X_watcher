import type { PollCommit, WatchStore } from '../../domain/ports.js';
import type { AnalyzedPost, Checkpoint, DeliveryResult, DigestWindow, Notification, OutboxEntry } from '../../domain/model.js';
import { RevisionConflictError } from '../../domain/errors.js';

const key = (targetId: string, postId: string): string => JSON.stringify([targetId, postId]);
/** Demo/reference implementation; every returned object is detached from internal state. */
export class MemoryStore implements WatchStore {
  readonly durability = 'memory';
  private checkpoints = new Map<string, Checkpoint>();
  private posts = new Map<string, AnalyzedPost>();
  private messages = new Map<string, OutboxEntry>();

  checkpoint(targetId: string): Checkpoint {
    return structuredClone(this.checkpoints.get(targetId) ?? { revision: 0, cursor: null, observedAt: null });
  }
  hasPost(targetId: string, postId: string): boolean { return this.posts.has(key(targetId, postId)); }
  commitPoll(commit: PollCommit): void {
    if (this.checkpoint(commit.targetId).revision !== commit.expectedRevision) throw new RevisionConflictError();
    if (commit.posts.some(item => item.post.targetId !== commit.targetId)
      || commit.notifications.some(item => item.targetId !== commit.targetId)) throw new Error('Target mismatch.');
    // Prepare a complete copy before publishing any mutation: all-or-nothing semantics.
    const posts = structuredClone(this.posts);
    const messages = structuredClone(this.messages);
    const checkpoints = structuredClone(this.checkpoints);
    for (const item of commit.posts) {
      const id = key(commit.targetId, item.post.id);
      if (!posts.has(id)) posts.set(id, structuredClone(item));
    }
    for (const notification of commit.notifications) {
      if (!messages.has(notification.id)) messages.set(notification.id,
        { notification: structuredClone(notification), state: 'pending', result: null });
    }
    checkpoints.set(commit.targetId, { revision: commit.expectedRevision + 1,
      cursor: commit.cursor, observedAt: commit.observedAt });
    this.posts = posts;
    this.messages = messages;
    this.checkpoints = checkpoints;
  }
  listPosts(targetId: string, window: DigestWindow): readonly AnalyzedPost[] {
    return structuredClone([...this.posts.values()].filter(item => item.post.targetId === targetId
      && Date.parse(item.post.publishedAt) >= Date.parse(window.from)
      && Date.parse(item.post.publishedAt) < Date.parse(window.to))
      .sort((a, b) => Date.parse(a.post.publishedAt) - Date.parse(b.post.publishedAt)
        || a.post.id.localeCompare(b.post.id)));
  }
  enqueue(notification: Notification): boolean {
    if (this.messages.has(notification.id)) return false;
    this.messages.set(notification.id, { notification: structuredClone(notification), state: 'pending', result: null });
    return true;
  }
  outbox(): readonly OutboxEntry[] { return structuredClone([...this.messages.values()]); }
  claim(id: string): Notification | null {
    const entry = this.messages.get(id);
    if (!entry || entry.state !== 'pending') return null;
    this.messages.set(id, { ...entry, state: 'sending' });
    return structuredClone(entry.notification);
  }
  finish(id: string, result: DeliveryResult): void {
    const entry = this.messages.get(id);
    if (!entry || entry.state !== 'sending') throw new Error('Notification was not claimed.');
    const state = result.status === 'accepted' ? 'sent' : result.status === 'rejected' ? 'failed' : 'needs_attention';
    this.messages.set(id, { ...entry, state, result: structuredClone(result) });
  }
  recoverInFlight(): number {
    let count = 0;
    for (const [id, entry] of this.messages) {
      if (entry.state !== 'sending') continue;
      this.messages.set(id, { ...entry, state: 'needs_attention',
        result: { status: 'unknown', reason: 'Interrupted delivery; manual verification required.' } });
      count++;
    }
    return count;
  }
}
