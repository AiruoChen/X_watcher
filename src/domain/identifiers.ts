/** Length-prefixed tuples avoid delimiter collisions and nested JSON escaping. */
export function stableId(kind: string, ...parts: readonly string[]): string {
  if (!kind.trim() || parts.some(part => !part.trim())) throw new Error('Empty identity component.');
  return [kind, ...parts].map(part => `${part.length}#${part}`).join('');
}
