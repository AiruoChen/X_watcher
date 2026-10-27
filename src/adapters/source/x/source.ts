import type { Clock, PostSource } from '../../../domain/ports.js';
import type { Post, PostBatch, ResolvedAuthor, RuntimeConfig, SourceQuery, WatchTarget } from '../../../domain/model.js';
import { SourceCoverageGap, SourceFailure } from '../../../domain/errors.js';
import { isInstant } from '../../../domain/time.js';
import { XClient } from './client.js';
import { envelope, id, invalid, object, searchPage, text } from './schemas.js';
import { mapPosts } from './mapper.js';

const RECENT_MS = 7 * 86_400_000;
const RETENTION_MARGIN_MS = 60_000;
/** Complete means this fixed query exhausted the public Recent Search index, not all X content. */
export class XSource implements PostSource {
  readonly capability = 'real';
  get budgeted(): boolean { return this.client.budgeted; }
  private readonly bindings = new Map<string, ResolvedAuthor>();
  constructor(private readonly client: XClient, private readonly clock: Clock, private readonly config: RuntimeConfig['x']) {}
  async resolve(target: WatchTarget, signal?: AbortSignal): Promise<ResolvedAuthor> {
    if (target.provider !== 'x' || !/^[a-zA-Z0-9_]{1,15}$/.test(target.handle)) throw new SourceFailure('identity_mismatch', false);
    this.bindings.delete(target.id);
    const root = envelope(await this.client.get(`/2/users/by/username/${target.handle}`, { 'user.fields': 'id,username,protected,withheld' }, signal));
    const data = object(root['data']), handle = text(data['username'], 15);
    if (handle.toLowerCase() !== target.handle.toLowerCase()) throw new SourceFailure('identity_mismatch', false);
    if (data['protected'] !== false || data['withheld'] !== undefined) throw new SourceFailure('permission', false);
    const author = { authorId: id(data['id']), handle }; this.bindings.set(target.id, author); return author;
  }
  async fetch(target: WatchTarget, cursor: string | null, query?: SourceQuery, signal?: AbortSignal): Promise<PostBatch> {
    const author = this.bindings.get(target.id);
    if (!author || author.handle.toLowerCase() !== target.handle.toLowerCase()) throw new SourceFailure('identity_mismatch', false);
    if (!query || !isInstant(query.from) || !isInstant(query.to) || Date.parse(query.from) >= Date.parse(query.to)) return invalid();
    if (cursor !== null) {
      let saved: Record<string, unknown>;
      try { saved = object(JSON.parse(cursor)); } catch { return invalid(); }
      if (saved['v'] !== 1 || saved['authorId'] !== author.authorId || !isInstant(saved['endAt'])
        || Date.parse(saved['endAt']) !== Date.parse(query.from)) return invalid();
    }
    const now = this.clock.now().getTime(), end = Date.parse(query.to);
    if (end > now - this.config.safetyLagMs + 1000) throw new SourceFailure('protocol', false);
    const earliest = now - RECENT_MS + RETENTION_MARGIN_MS;
    if (Date.parse(query.from) < earliest) throw new SourceCoverageGap(query);
    const fromMs = Math.floor(Math.max(Date.parse(query.from) - this.config.overlapMs, earliest) / 1000) * 1000;
    const start = new Date(fromMs).toISOString(), finish = new Date(Math.ceil(end / 1000) * 1000).toISOString();
    const current = this.config.fieldDialect === 'post';
    const fields = current ? 'id,text,created_at,note_post,withheld,entities,display_text_range,article'
      : 'id,text,created_at,author_id,note_tweet,referenced_tweets,edit_history_tweet_ids,withheld,entities,display_text_range,article';
    const params: Record<string, string> = { query: `from:${author.authorId} -is:retweet`, start_time: start, end_time: finish,
      max_results: String(this.config.pageSize), sort_order: 'recency', [current ? 'post.fields' : 'tweet.fields']: fields,
      expansions: current ? 'author_id,referenced_posts,edit_history_post_ids' : 'author_id,referenced_tweets.id,referenced_tweets.id.author_id' };
    const posts = new Map<string, Post>(), tokens = new Set<string>(); let next: string | null = null;
    for (let page = 0; page < this.config.maxPages; page++) {
      if (fromMs < this.clock.now().getTime() - RECENT_MS) throw new SourceCoverageGap(query);
      if (next !== null) params['next_token'] = next;
      const result = searchPage(await this.client.get('/2/tweets/search/recent', params, signal));
      const mapped = mapPosts(result.data, result.context, target, author.authorId);
      let added = 0;
      for (const post of mapped) {
        const time = Date.parse(post.publishedAt);
        if (time < fromMs || time > Date.parse(finish)) return invalid();
        if (time >= end) continue; // Preserve the domain's half-open interval at second precision.
        const key = post.origin!.sourcePostId, old = posts.get(key);
        if (old && JSON.stringify(old) !== JSON.stringify(post)) return invalid();
        if (!old) { posts.set(key, post); added++; }
      }
      if (page > 0 && added === 0 && mapped.length > 0) return invalid();
      if (result.next === null) return { posts: [...posts.values()], nextCursor: JSON.stringify({ v: 1, authorId: author.authorId, endAt: query.to }),
        complete: true, coverage: { from: start, to: query.to }, scope: 'x_recent_public_index' };
      if (tokens.has(result.next) || !result.data.length || (page > 0 && added === 0 && mapped.length > 0)) return invalid();
      tokens.add(result.next); next = result.next;
    }
    throw new SourceFailure('page_limit', true);
  }
}
