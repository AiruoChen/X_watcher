import { Parser } from 'htmlparser2';
import type { Post, SourceReference, WatchTarget } from '../../../domain/model.js';
import { SourceFailure } from '../../../domain/errors.js';
import { isInstant } from '../../../domain/time.js';

const invalid = (): never => { throw new SourceFailure('protocol', false); };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
function text(value: unknown, max = 200_000): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') ? value : invalid();
}
function xUrl(value: unknown): URL {
  let url: URL; try { url = new URL(text(value, 2000)); } catch { return invalid(); }
  if (url.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(url.hostname) || url.port
    || url.username || url.password || url.search || url.hash) return invalid();
  return url;
}
function postLink(value: unknown): { id: string; handle: string; url: string } {
  const url = xUrl(value), match = /^\/([a-zA-Z0-9_]{1,15})\/status\/([1-9]\d{0,31})\/?$/.exec(url.pathname);
  if (!match) return invalid();
  return { handle: match[1]!.toLowerCase(), id: match[2]!, url: 'https://x.com/' + match[1]!.toLowerCase() + '/status/' + match[2]! };
}
/** Parse inert HTML as text; quoted/reply authors never become the monitored author's words. */
export function authorText(html: string): string {
  const blocks = new Set(['p', 'div', 'br', 'li', 'section', 'article', 'pre', 'hr']);
  const discarded = new Set(['script', 'style', 'iframe', 'object', 'template', 'blockquote', 'video', 'audio']);
  const hidden: boolean[] = []; let value = '';
  const parser = new Parser({
    onopentag: (name, attrs) => {
      const skip = Boolean(hidden.at(-1)) || discarded.has(name)
        || (attrs['class'] ?? '').split(/\s+/).some(c => c === 'rsshub-quote' || c === 'rsshub-reply-context');
      hidden.push(skip);
      if (!skip && blocks.has(name)) value += '\n';
    },
    ontext: chunk => { if (!hidden.at(-1)) value += chunk; },
    onclosetag: name => { if (!hidden.pop() && blocks.has(name) && name !== 'br' && name !== 'hr') value += '\n'; },
  }, { decodeEntities: true });
  parser.end(html);
  return value.replace(/\r\n?/g, '\n').replace(/[\t\f\v \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function rsshubAuthorId(handle: string): string { return 'rsshub-handle:' + handle.toLowerCase(); }
export function mapFeed(input: unknown, target: WatchTarget, itemLimit: number): readonly Post[] {
  const root = object(input);
  if (!['https://jsonfeed.org/version/1', 'https://jsonfeed.org/version/1.1'].includes(String(root['version']))) return invalid();
  const profile = xUrl(root['home_page_url']);
  if (profile.pathname.replace(/\/$/, '').toLowerCase() !== '/' + target.handle.toLowerCase())
    throw new SourceFailure('identity_mismatch', false);
  if (root['next_url'] !== undefined) throw new SourceFailure('page_limit', false);
  if (root['expired'] === true || !Array.isArray(root['items']) || root['items'].length > itemLimit) return invalid();
  const posts = new Map<string, Post>();
  for (const entry of root['items']) {
    const item = object(entry), link = postLink(item['url']);
    if (link.handle !== target.handle.toLowerCase()) throw new SourceFailure('identity_mismatch', false);
    if (postLink(item['id']).url !== link.url) return invalid();
    if (item['authors'] !== undefined) {
      if (!Array.isArray(item['authors']) || item['authors'].length !== 1) return invalid();
      const author = object(item['authors'][0]);
      if (author['url'] !== undefined && xUrl(author['url']).pathname.replace(/\/$/, '').toLowerCase() !== '/' + link.handle)
        throw new SourceFailure('identity_mismatch', false);
    }
    const rawDate = text(item['date_published'], 100);
    // Current RSSHub emits ISO; older JSON feeds can contain canonical RFC 1123 dates.
    const published = Date.parse(rawDate);
    if (!Number.isFinite(published) || (!isInstant(rawDate) && new Date(published).toUTCString() !== rawDate)) return invalid();
    const references: SourceReference[] = [];
    if (item['_extra'] !== undefined) {
      const extra = object(item['_extra']);
      if (extra['links'] !== undefined) {
        if (!Array.isArray(extra['links']) || extra['links'].length > 20) return invalid();
        for (const raw of extra['links']) {
          const ref = object(raw), parsed = postLink(ref['url']);
          const kind = ref['type'] === 'quote' ? 'quoted' : ref['type'] === 'reply' ? 'replied_to'
            : ref['type'] === 'repost' ? 'retweeted' : invalid();
          references.push({ id: parsed.id, kind, authorId: null, text: null, url: parsed.url });
        }
      }
    }
    if (references.some(ref => ref.kind === 'retweeted')) continue;
    if (typeof item['content_html'] !== 'string' && references.some(ref => ref.kind === 'quoted')) return invalid();
    const body = typeof item['content_html'] === 'string' ? authorText(item['content_html'] === '' ? '' : text(item['content_html'])) : text(item['content_text']);
    const post: Post = { id: link.id, targetId: target.id, text: body || '[RSSHub 条目无可提取文本；媒体未分析]',
      publishedAt: new Date(published).toISOString(), url: link.url,
      origin: { authorId: rsshubAuthorId(target.handle), sourcePostId: link.id, sourceVersion: 'rsshub-json-v1',
        completeness: 'unknown', kind: references.some(ref => ref.kind === 'quoted') ? 'quote'
          : references.some(ref => ref.kind === 'replied_to') ? 'reply' : 'unknown', editHistory: [], references } };
    const old = posts.get(post.id);
    if (old && JSON.stringify(old) !== JSON.stringify(post)) return invalid();
    posts.set(post.id, post);
  }
  return [...posts.values()];
}
