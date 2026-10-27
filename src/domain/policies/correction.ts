import type { Analysis, CorrectionLink, PostVersion, SemanticAnalysis } from '../model.js';
const sourceId = (p: PostVersion): string => p.origin?.sourcePostId ?? p.id;
/** Identity and lineage must come from saved source data, never a model-generated local key. */
export function correctionBasis(current: PostVersion, previous: PostVersion, explicitId: string | null): CorrectionLink['basis'] | null {
  if (current.key === previous.key || previous.deleted || current.provider !== previous.provider
    || current.targetId !== previous.targetId || current.authorId !== previous.authorId) return null;
  const oldId = sourceId(previous);
  if (explicitId !== null) return [previous.id, oldId].includes(explicitId) ? 'explicit_reference' : null;
  const history = current.origin?.editHistory ?? [], currentIndex = history.indexOf(sourceId(current)), oldIndex = history.indexOf(oldId);
  if (oldIndex >= 0 && currentIndex > oldIndex) return 'edit_history';
  if (current.id !== previous.id) return null;
  if (current.origin && previous.origin && sourceId(current) !== oldId) return null;
  return 'same_post';
}
export function correctionLink(current: PostVersion, previous: PostVersion | null, explicitId: string | null): CorrectionLink | null {
  if (!previous) return null;
  const basis = correctionBasis(current, previous, explicitId);
  return basis ? { postKey: previous.key, postId: previous.id, sourcePostId: sourceId(previous), url: previous.url, basis } : null;
}
export function withCorrectionLink(post: PostVersion, analysis: Analysis, previous: PostVersion | null): Analysis {
  const a = analysis as Partial<SemanticAnalysis>;
  if (a.schemaVersion !== 1 || a.resetFinding?.kind !== 'correction' || !a.resetDetails) return analysis;
  return { ...analysis, correctionLink: correctionLink(post, previous, a.resetDetails.previousPostId) } as SemanticAnalysis;
}
export function validateCorrectionLink(post: PostVersion, analysis: Analysis, previous: PostVersion | null): void {
  const a = analysis as Partial<SemanticAnalysis>;
  if (!Object.hasOwn(a, 'correctionLink')) return; // Old immutable results remain readable.
  const expected = a.schemaVersion === 1 && a.resetFinding?.kind === 'correction' && a.resetDetails
    ? correctionLink(post, previous, a.resetDetails.previousPostId) : null;
  if (expected === null ? a.correctionLink !== null : !a.correctionLink || Object.keys(a.correctionLink).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => a.correctionLink?.[key as keyof CorrectionLink] !== value))
    throw new Error('Invalid correction predecessor.');
}
