import type { Post } from '../model.js';
export interface ModelRequest {
  readonly model: string;
  readonly promptVersion: string;
  readonly instructions: string;
  readonly input: { readonly postId: string; readonly text: string; readonly publishedAt: string; readonly completeness: string };
  readonly schema: Readonly<Record<string, unknown>>;
}
export interface StructuredModel {
  readonly capability: 'simulated' | 'real';
  complete(request: ModelRequest, signal?: AbortSignal): Promise<{ readonly status: 'complete' | 'refused' | 'incomplete'; readonly output: unknown }>;
}
export interface AnalysisOptions {
  readonly model: string; readonly version: string; readonly promptVersion: string; readonly allowPartial: boolean;
}
export type AnalysisInput = Post;
