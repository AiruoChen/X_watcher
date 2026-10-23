import type { ContentAnalyzer } from '../../domain/ports.js';
import type { Analysis, Post } from '../../domain/model.js';

/** Pre-authored test answers, not an AI model or real reset classifier. */
export class FixtureAnalyzer implements ContentAnalyzer {
  readonly capability = 'simulated';
  constructor(private readonly answers: ReadonlyMap<string, Analysis>) {}
  async analyze(post: Post): Promise<Analysis> {
    const answer = this.answers.get(post.id);
    if (!answer) throw new Error('No fixture analysis for post.');
    return structuredClone(answer);
  }
}
