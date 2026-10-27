import { parseSemanticAnalysis } from '../../dist/src/domain/policies/semantic-analysis.js';
const products = ['chatgpt','codex','api'];
const ratio = (n, d) => d ? n / d : null;
export function datasetSummary(cases) {
  if (!Array.isArray(cases) || new Set(cases.map(c => c.id)).size !== cases.length
    || cases.some(c => typeof c.id !== 'string' || typeof c.text !== 'string'
      || !['none','announcement','discussion','correction'].includes(c.expected?.kind)
      || (c.expected.kind === 'none' ? c.expected.certainty !== null
        : !products.includes(c.expected.product) || !['confirmed','uncertain'].includes(c.expected.certainty))
      || (c.expected.kind === 'discussion' && c.expected.certainty !== 'uncertain'))) throw Error('Invalid labelled evaluation dataset.');
  return { cases: cases.length, positives: cases.filter(c => c.expected.kind !== 'none').length,
    hardNegatives: cases.filter(c => c.expected.kind === 'none').length,
    confirmedAnnouncements: cases.filter(c => c.expected.kind === 'announcement' && c.expected.certainty === 'confirmed').length };
}
export function evaluate(cases, outputs) {
  const summary = datasetSummary(cases);
  if (!Array.isArray(outputs) || outputs.length !== cases.length || new Set(outputs.map(o => o?.id)).size !== cases.length
    || outputs.some(o => !cases.some(c => c.id === o?.id))) throw Error('Exactly one output per evaluation case is required.');
  let tp = 0, fp = 0, fn = 0, relatedTp = 0, relatedFp = 0, relatedFn = 0;
  let invalid = 0, kindErrors = 0, productErrors = 0, certaintyErrors = 0, timeErrors = 0, inventedExactTimes = 0;
  for (const c of cases) {
    let result;
    try {
      result = parseSemanticAnalysis({ id: c.id, targetId: 'synthetic', text: c.text, publishedAt: '2026-01-01T12:00:00Z',
        url: 'https://example.invalid/post', ...(c.completeness ? { completeness: c.completeness } : {}) },
      outputs.find(o => o.id === c.id).output, { model: 'candidate', analyzerVersion: 'eval-v2', promptVersion: 'v1', inputHash: 'synthetic-eval' });
    } catch { invalid++; }
    const related = !!result && result.resetFinding.kind !== 'none' && products.includes(result.resetDetails?.product);
    const expectedRelated = c.expected.kind !== 'none';
    if (related && expectedRelated) relatedTp++;
    if (related && !expectedRelated) relatedFp++;
    if (!related && expectedRelated) relatedFn++;
    const confirmed = related && result.inputCompleteness === 'full'
      && result.resetFinding.kind === 'announcement' && result.resetDetails.certainty === 'confirmed';
    const expectedConfirmed = c.expected.kind === 'announcement' && c.expected.certainty === 'confirmed';
    const correctProduct = related && result.resetDetails.product === c.expected.product;
    if (confirmed && expectedConfirmed && correctProduct) tp++;
    if (confirmed && (!expectedConfirmed || !correctProduct)) fp++;
    if (expectedConfirmed && (!confirmed || !correctProduct)) fn++;
    if (result && (related ? result.resetFinding.kind : 'none') !== c.expected.kind) kindErrors++;
    if (related && !correctProduct) productErrors++;
    if (related && result.resetDetails.certainty !== c.expected.certainty) certaintyErrors++;
    const time = result?.resetFinding.kind !== 'none' ? result?.resetFinding.normalizedAt ?? null : null;
    if (time !== c.expected.normalizedAt) { timeErrors++; if (time !== null) inventedExactTimes++; }
  }
  const confirmedPrecision = ratio(tp, tp + fp), confirmedRecall = ratio(tp, tp + fn);
  const sufficient = summary.cases >= 60 && summary.positives >= 20 && summary.hardNegatives >= 20 && summary.confirmedAnnouncements > 0;
  const passed = sufficient && confirmedPrecision !== null && confirmedPrecision >= 0.9 && confirmedRecall !== null && confirmedRecall >= 0.95
    && invalid === 0 && timeErrors === 0 && inventedExactTimes === 0;
  return { status: passed ? 'passed' : 'failed', ...summary, sufficient, confirmedTp: tp, confirmedFp: fp, confirmedFn: fn,
    confirmedPrecision, confirmedRecall, relatedPrecision: ratio(relatedTp, relatedTp + relatedFp), relatedRecall: ratio(relatedTp, relatedTp + relatedFn),
    invalid, kindErrors, productErrors, certaintyErrors, timeErrors, inventedExactTimes };
}
