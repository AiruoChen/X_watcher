import { isInstant } from './time.js';
import type { Analysis, Post, WatchTarget } from './model.js';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 12000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text.');
}
export function validatePost(post: Post, target: WatchTarget): void {
  if (!post.id || post.targetId !== target.id || typeof post.text !== 'string' || !post.text.trim()
    || !isInstant(post.publishedAt)) throw new Error('Invalid source post.');
  if (new URL(post.url).protocol !== 'https:') throw new Error('Post URL must be HTTPS.');
}
export function validateAnalysis(post: Post, input: unknown): asserts input is Analysis {
  const analysis = record(input);
  text(analysis['summary'], 6000);
  const updates = analysis['chatgptUpdates'];
  if (!Array.isArray(updates) || updates.length > 100) throw new Error('Invalid update list.');
  updates.forEach(value => text(value, 3000));
  const quote = (value: unknown, nullable: boolean): void => {
    if (value === null && nullable) return;
    text(value);
    if (!post.text.includes(value)) throw new Error('Evidence must be verbatim source text.');
  };
  if (analysis['reset'] !== null) {
    const reset = record(analysis['reset']);
    quote(reset['evidence'], false); quote(reset['whenText'], true); quote(reset['timeZoneText'], true);
  }
  if ('updates' in analysis) {
    if (!Array.isArray(analysis['updates']) || analysis['updates'].length > 100) throw new Error('Invalid product updates.');
    for (const value of analysis['updates']) {
      const update = record(value);
      if (!['chatgpt','api','codex','other'].includes(String(update['product']))
        || !['released','rolling_out','planned','speculation','discussion'].includes(String(update['status']))) throw new Error('Invalid product status.');
      text(update['text'], 3000); quote(update['evidence'], false);
    }
  }
  if ('resetFinding' in analysis) {
    const finding = record(analysis['resetFinding']);
    if (finding['kind'] === 'none') {
      if (analysis['reset'] !== null) throw new Error('Conflicting reset findings.');
    } else {
      if (!['announcement','discussion','correction'].includes(String(finding['kind']))) throw new Error('Invalid reset kind.');
      quote(finding['evidence'], false); quote(finding['whenText'], true); quote(finding['timeZoneText'], true);
      const reset = record(analysis['reset']);
      if (['evidence','whenText','timeZoneText'].some(key => finding[key] !== reset[key])) throw new Error('Conflicting reset evidence.');
      if (finding['normalizedAt'] === null) {
        if (finding['normalizationEvidence'] !== null) throw new Error('Unexpected normalization evidence.');
      } else {
        // B01 supports only a verbatim explicit ISO timestamp; other parsers belong to B05.
        const evidence = finding['normalizationEvidence'], normalized = finding['normalizedAt'];
        quote(evidence, false); text(normalized);
        if (typeof evidence !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(evidence)
          || !isInstant(normalized) || !isInstant(evidence) || Date.parse(evidence) !== Date.parse(normalized)) throw new Error('Unproven normalized time.');
      }
    }
  }
}
