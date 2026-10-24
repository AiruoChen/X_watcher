import type { Post, SemanticAnalysis, ProductUpdate } from '../model.js';
import { isInstant } from '../time.js';
const invalid = (): never => { throw new Error('Invalid structured analysis.'); };
function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(data, k))) return invalid();
  return data;
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0') ? value : invalid();
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : invalid();
}
function evidence(post: Post, value: unknown): string {
  const quote = text(value, 12000); if (!post.text.includes(quote)) return invalid(); return quote;
}
export function inputCompleteness(post: Post): 'full' | 'partial' {
  const version = post as Post & { completeness?: string };
  return (version.completeness !== undefined && version.completeness !== 'full')
    || (post.origin !== undefined && post.origin.completeness !== 'full') ? 'partial' : 'full';
}
/** Only explicit, verbatim ISO with offset is normalized. Relative times/DST abbreviations stay unknown. */
export function parseSemanticAnalysis(post: Post, input: unknown, provenance: SemanticAnalysis['provenance']): SemanticAnalysis {
  const root = obj(input, ['postId','summary','topics','updates','reset']);
  if (root['postId'] !== post.id) return invalid();
  if (!Array.isArray(root['topics']) || root['topics'].length > 20 || !Array.isArray(root['updates']) || root['updates'].length > 100) return invalid();
  const updates: ProductUpdate[] = root['updates'].map(value => {
    const item = obj(value, ['product','status','text','evidence']);
    return { product: choice(item['product'], ['chatgpt','api','codex','other']),
      status: choice(item['status'], ['released','rolling_out','planned','speculation','discussion']),
      text: text(item['text'], 3000), evidence: evidence(post, item['evidence']) };
  });
  const base = { schemaVersion: 1 as const, summary: text(root['summary'], 6000),
    topics: root['topics'].map(value => text(value, 100)), updates,
    chatgptUpdates: updates.filter(u => u.product === 'chatgpt').map(u => '[' + u.status + '] ' + u.text),
    inputCompleteness: inputCompleteness(post), provenance };
  if (root['reset'] === null) return { ...base, reset: null, resetFinding: { kind: 'none' }, resetDetails: null };
  const r = obj(root['reset'], ['kind','product','certainty','evidence','whenText','timeZoneText','audience','previousPostId']);
  const kind = choice(r['kind'], ['announcement','discussion','correction']);
  const nullableQuote = (value: unknown): string | null => value === null ? null : evidence(post, value);
  const quote = evidence(post, r['evidence']), when = nullableQuote(r['whenText']), zone = nullableQuote(r['timeZoneText']);
  // A model's exact timestamp is never trusted; only the supplied evidence can determine it.
  const normalized = when !== null && isInstant(when) ? new Date(when).toISOString() : null;
  const previous = r['previousPostId'] === null ? null : text(r['previousPostId'], 100);
  if (previous !== null && (!/^[a-zA-Z0-9:_-]+$/.test(previous) || !post.text.includes(previous))) return invalid();
  const certainty = choice(r['certainty'], ['confirmed','uncertain']);
  if (kind === 'discussion' && certainty !== 'uncertain') return invalid();
  return { ...base, reset: { evidence: quote, whenText: when, timeZoneText: zone },
    resetFinding: { kind, evidence: quote, whenText: when, timeZoneText: zone,
      normalizedAt: normalized, normalizationEvidence: normalized ? when : null },
    resetDetails: { product: choice(r['product'], ['chatgpt','codex','api','other']), certainty,
      audience: nullableQuote(r['audience']), previousPostId: previous } };
}
