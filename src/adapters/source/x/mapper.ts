import type { Post, SourcePostMetadata, SourceReference, WatchTarget } from '../../../domain/model.js';
import { SourceFailure } from '../../../domain/errors.js';
import { alias, array, id, instant, invalid, object, text } from './schemas.js';

interface ParsedPost {
  readonly id: string; readonly authorId: string; readonly text: string; readonly createdAt: string;
  readonly full: boolean; readonly history: readonly string[];
  readonly references: readonly { id: string; kind: SourceReference['kind'] }[];
}
function parse(value: unknown): ParsedPost {
  const raw = object(value), postId = id(raw['id']), authorId = id(raw['author_id']);
  const short = text(raw['text']), noteRaw = alias(raw, 'note_post', 'note_tweet');
  const body = noteRaw === undefined ? short : text(object(noteRaw)['text']);
  const historyRaw = alias(raw, 'edit_history_post_ids', 'edit_history_tweet_ids');
  const history = historyRaw === undefined ? [postId] : array(historyRaw, 10).map(id);
  if (!history.length || !history.includes(postId) || new Set(history).size !== history.length) return invalid();
  const refsRaw = alias(raw, 'referenced_posts', 'referenced_tweets');
  const references = refsRaw === undefined ? [] : array(refsRaw, 10).map(value => {
    const ref = object(value), kind = ref['type'];
    if (kind !== 'quoted' && kind !== 'replied_to' && kind !== 'retweeted') return invalid();
    return { id: id(ref['id']), kind: kind as SourceReference['kind'] };
  });
  if (raw['withheld'] !== undefined) throw new SourceFailure('permission', false);
  // A link/title or a shortened body cannot become the author's full statement.
  const full = noteRaw !== undefined || (!raw['article'] && !/(?:…|\.\.\.)\s*(?:https:\/\/t\.co\/\S+)?\s*$/u.test(body));
  return { id: postId, authorId, text: body, createdAt: instant(raw['created_at']), full, history, references };
}
const url = (postId: string): string => `https://x.com/i/status/${postId}`;
export function mapPosts(values: readonly unknown[], context: readonly unknown[], target: WatchTarget, authorId: string): readonly Post[] {
  const expanded = new Map<string, ParsedPost>();
  for (const value of context) {
    const item = parse(value), old = expanded.get(item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) return invalid(); expanded.set(item.id, item);
  }
  return values.flatMap(value => {
    const item = parse(value);
    if (item.authorId !== authorId) throw new SourceFailure('identity_mismatch', false);
    if (item.references.some(ref => ref.kind === 'retweeted')) return []; // Reposts never become author announcements.
    const references: SourceReference[] = item.references.map(ref => {
      const original = expanded.get(ref.id);
      return { ...ref, authorId: original?.authorId ?? null, text: original?.text ?? null, url: url(ref.id) };
    });
    const missing = item.references.some(ref => !expanded.get(ref.id)?.full);
    const origin: SourcePostMetadata = { authorId, sourcePostId: item.id, sourceVersion: item.id,
      completeness: item.full && !missing ? 'full' : 'truncated',
      kind: item.references.some(ref => ref.kind === 'quoted') ? 'quote' : item.references.length ? 'reply' : 'original',
      editHistory: item.history, references };
    return [{ id: item.history[0]!, targetId: target.id, text: item.text, publishedAt: item.createdAt,
      url: url(item.id), origin }];
  });
}
