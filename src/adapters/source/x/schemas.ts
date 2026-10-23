import { SourceFailure } from '../../../domain/errors.js';
import { isInstant } from '../../../domain/time.js';

export const invalid = (): never => { throw new SourceFailure('protocol', false); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(); return value;
}
export function id(value: unknown): string {
  const valueText = text(value, 20); if (!/^[1-9]\d{0,19}$/.test(valueText)) return invalid(); return valueText;
}
export function instant(value: unknown): string { if (!isInstant(value)) return invalid(); return value; }
export function array(value: unknown, max = 100): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid(); return value;
}
/** A response containing partial errors is never evidence for complete coverage. */
export function envelope(value: unknown): Record<string, unknown> {
  const data = object(value);
  if (data['errors'] !== undefined && array(data['errors']).length > 0) return invalid(); return data;
}
export function alias(data: Record<string, unknown>, current: string, legacy: string): unknown {
  if (data[current] !== undefined && data[legacy] !== undefined && JSON.stringify(data[current]) !== JSON.stringify(data[legacy])) return invalid();
  return data[current] ?? data[legacy];
}
export interface SearchPage { readonly data: readonly unknown[]; readonly context: readonly unknown[]; readonly next: string | null }
export function searchPage(value: unknown): SearchPage {
  const root = envelope(value), meta = object(root['meta']);
  const data = root['data'] === undefined ? [] : array(root['data']);
  if (!Number.isSafeInteger(meta['result_count']) || meta['result_count'] !== data.length) return invalid();
  const includes = root['includes'] === undefined ? {} : object(root['includes']);
  const refs = alias(includes, 'posts', 'tweets');
  return { data, context: refs === undefined ? [] : array(refs, 1000),
    next: meta['next_token'] === undefined ? null : text(meta['next_token'], 2048) };
}
