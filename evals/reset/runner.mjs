import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSemanticAnalysis } from '../../dist/src/domain/policies/semantic-analysis.js';
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const path = process.argv[2];
if (!path) {
  console.log(JSON.stringify({ status: 'not_run', cases: cases.length, positives: cases.filter(c => c.expected.kind !== 'none').length,
    hardNegatives: cases.filter(c => c.expected.kind === 'none').length, reason: 'Supply a local model-output JSON array; no provider has been selected.' }));
} else {
  const outputs = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(outputs) || outputs.length !== cases.length || new Set(outputs.map(o => o.id)).size !== cases.length
    || outputs.some(o => !cases.some(c => c.id === o.id))) throw Error('Exactly one output per evaluation case is required.');
  let tp = 0, fp = 0, fn = 0, invalid = 0, kindErrors = 0, timeErrors = 0;
  for (const c of cases) {
    let result;
    try {
      const post = { id: c.id, targetId: 'synthetic', text: c.text, publishedAt: '2026-01-01T12:00:00Z', url: 'https://example.invalid/post' };
      result = parseSemanticAnalysis(post, outputs.find(o => o.id === c.id).output, { model: 'candidate', analyzerVersion: 'eval-v1',
        promptVersion: 'v1', inputHash: createHash('sha256').update(JSON.stringify(post)).digest('hex') });
    } catch { invalid++; }
    const predicted = result && result.resetFinding.kind !== 'none' && result.resetDetails?.product !== 'other';
    const expected = c.expected.kind !== 'none';
    if (predicted && expected) tp++;
    if (predicted && !expected) fp++;
    if (!predicted && expected) fn++;
    if (result && ((predicted ? result.resetFinding.kind : 'none') !== c.expected.kind
      || (predicted && result.resetDetails.product !== c.expected.product))) kindErrors++;
    const time = result?.resetFinding.kind !== 'none' ? result?.resetFinding.normalizedAt ?? null : null;
    if (time !== c.expected.normalizedAt) timeErrors++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
  const passed = precision >= 0.9 && recall >= 0.95 && timeErrors === 0 && invalid === 0 && kindErrors === 0;
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', cases: cases.length, tp, fp, fn, invalid, kindErrors, timeErrors, precision, recall }));
  if (!passed) process.exitCode = 1;
}
