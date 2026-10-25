import { UsageFailure } from '../../domain/errors.js';
import type { ContentAnalyzer, ContentHasher } from '../../domain/ports.js';
import type { AnalysisOptions, StructuredModel } from '../../domain/ports/analysis.js';
import type { Post, SemanticAnalysis } from '../../domain/model.js';
import { inputCompleteness, parseSemanticAnalysis } from '../../domain/policies/semantic-analysis.js';
import { validateAnalysis } from '../../domain/validation.js';
import { ANALYSIS_SCHEMA, ANALYSIS_INSTRUCTIONS } from './structured-contract.js';
export class StructuredAnalyzer implements ContentAnalyzer {
  readonly capability: 'simulated' | 'real';
  readonly supportsPartial: boolean;
  readonly version: string;
  readonly promptVersion: string;
  constructor(private readonly client: StructuredModel, private readonly hasher: ContentHasher, private readonly options: AnalysisOptions) {
    if (![options.model, options.version, options.promptVersion].every(x => x.trim())) throw new Error('Analysis identity is required.');
    this.capability = client.capability; this.supportsPartial = options.allowPartial;
    this.version = options.version; this.promptVersion = options.promptVersion;
  }
  async analyze(post: Post, signal?: AbortSignal): Promise<SemanticAnalysis> {
    signal?.throwIfAborted();
    if (post.text.length > 100000 || (inputCompleteness(post) !== 'full' && !this.supportsPartial))
      throw new Error('Analysis input is not allowed.');
    const response = await this.client.complete({ model: this.options.model, promptVersion: this.promptVersion,
      instructions: ANALYSIS_INSTRUCTIONS, schema: structuredClone(ANALYSIS_SCHEMA),
      input: { postId: post.id, text: post.text, publishedAt: post.publishedAt, completeness: inputCompleteness(post) === 'full' ? 'full' : 'unknown' } }, signal);
    signal?.throwIfAborted();
    if (response.usage && (![response.usage.inputTokens,response.usage.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1e9))) throw new Error('Invalid model usage.');
    try {
    if (response.status !== 'complete') throw new Error('Analysis output is unavailable or incomplete.');
    const result = parseSemanticAnalysis(post, response.output, { model: this.options.model, analyzerVersion: this.version,
      promptVersion: this.promptVersion, inputHash: this.hasher.hash(JSON.stringify(post)) });
    validateAnalysis(post, result);
    return response.usage ? { ...result, usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } } : result;
    } catch(error) { if (response.usage) throw new UsageFailure(response.usage); throw error; }
  }
}
