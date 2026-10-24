import type { Post } from '../../src/domain/model.js';
import { Sha256Hasher } from '../../src/adapters/hash.js';
import { StructuredAnalyzer } from '../../src/adapters/analysis/structured-analyzer.js';
export const hasher = new Sha256Hasher();
export const post: Post = { id: 'p', targetId: 'x:thsottiaux', text: 'ChatGPT Plus limits reset at 2026-01-03T00:00:00Z UTC. See previous post 123456.',
  publishedAt: '2026-01-01T12:00:00Z', url: 'https://example.invalid/post/p' };
export function output(p: Post = post) {
  return { postId: p.id, summary: '作者说明 ChatGPT 额度重置。', topics: ['额度'],
    updates: [{ product: 'chatgpt', status: 'planned', text: '计划重置额度', evidence: p.text }],
    reset: { kind: 'announcement', product: 'chatgpt', certainty: 'confirmed', evidence: p.text,
      whenText: p.text.includes('2026-01-03T00:00:00Z') ? '2026-01-03T00:00:00Z' : null,
      timeZoneText: p.text.includes('UTC') ? 'UTC' : null, audience: null, previousPostId: null } };
}
export function analyzer(value: unknown = output(), allowPartial = false, version = 'fixture-v1') {
  return new StructuredAnalyzer({ capability: 'simulated', complete: async () => ({ status: 'complete', output: value }) },
    hasher, { model: 'synthetic', version, promptVersion: 'v1', allowPartial });
}
