/** Compatibility exports. New callers use provider-neutral source-preview.ts. */
import type { RuntimeConfig } from './domain/model.js';
import { probeSource, previewSource } from './source-preview.js';
function official(config: RuntimeConfig): void {
  if (config.services.source.provider !== 'x-api-v2') throw new Error('x:* commands require SOURCE_PROVIDER=x-api-v2.');
}
export async function probeX(config: RuntimeConfig, env: NodeJS.ProcessEnv): Promise<number> {
  official(config); return probeSource(config, env);
}
export async function previewX(config: RuntimeConfig, env: NodeJS.ProcessEnv, create: boolean, once: boolean): Promise<number> {
  official(config); return previewSource(config, env, create, once);
}
