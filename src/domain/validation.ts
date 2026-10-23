import type { Analysis, Post, WatchTarget } from './model.js';

export function validatePost(post: Post, target: WatchTarget): void {
  if (!post.id || post.targetId !== target.id || !post.text.trim()
    || !Number.isFinite(Date.parse(post.publishedAt))) {
    throw new Error('Invalid source post.');
  }
  if (new URL(post.url).protocol !== 'https:') throw new Error('Post URL must be HTTPS.');
}

export function validateAnalysis(post: Post, analysis: Analysis): void {
  if (!analysis.summary.trim() || analysis.chatgptUpdates.some(text => !text.trim())) {
    throw new Error('Invalid analysis.');
  }
  const reset = analysis.reset;
  if (!reset) return;
  // Adapters must also validate unknown JSON at the protocol boundary.
  for (const quote of [reset.evidence, reset.whenText, reset.timeZoneText]) {
    if (quote !== null && (!quote.trim() || !post.text.includes(quote))) {
      throw new Error('Reset evidence and time must be verbatim source text.');
    }
  }
}
