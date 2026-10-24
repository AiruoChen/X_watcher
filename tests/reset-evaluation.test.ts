import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
interface Case { id: string; text: string; expected: { kind: string; product: string | null; certainty: string | null; whenText: string | null } }
const cases = JSON.parse(readFileSync('evals/reset/cases.json', 'utf8')) as Case[];
function candidate() {
  return cases.map(c => ({ id: c.id, output: { postId: c.id, summary: '合成评估器回归样例', topics: [], updates: [],
    reset: c.expected.kind === 'none' ? null : { kind: c.expected.kind, product: c.expected.product, certainty: c.expected.certainty,
      evidence: c.text, whenText: c.expected.whenText, timeZoneText: c.text.includes('UTC') ? 'UTC' : null, audience: null, previousPostId: null } } }));
}
function run(outputs: unknown) {
  const root = temporaryStorage();
  try {
    const path = join(root, 'outputs.json'); writeFileSync(path, JSON.stringify(outputs));
    const r = spawnSync(process.execPath, ['evals/reset/runner.mjs', path], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return { code: r.status, data: r.stdout.trim() ? JSON.parse(r.stdout) as Record<string, number | string | null> : null };
  } finally { cleanupStorage(root); }
}
test('evaluation self-test: labelled outputs meet the confirmed-announcement gate', () => {
  const r = run(candidate()); assert.equal(r.code, 0); assert.equal(r.data?.confirmedPrecision, 1); assert.equal(r.data?.confirmedRecall, 1);
});
test('all announcements marked uncertain cannot pass via broad relevance scores', () => {
  const outputs = candidate(); for (const c of outputs) if (c.output.reset) c.output.reset.certainty = 'uncertain';
  const r = run(outputs); assert.equal(r.code, 1); assert.equal(r.data?.relatedRecall, 1);
  assert.equal(r.data?.confirmedRecall, 0); assert.equal(r.data?.confirmedPrecision, null);
});
test('confirmed false positives count against precision and missing IDs cannot improve recall', () => {
  const outputs = candidate();
  for (const c of outputs.slice(-5)) c.output.reset = { kind: 'announcement', product: 'chatgpt', certainty: 'confirmed',
    evidence: cases.find(x => x.id === c.id)!.text, whenText: null, timeZoneText: null, audience: null, previousPostId: null };
  const r = run(outputs); assert.equal(r.code, 1); assert.equal(r.data?.confirmedFp, 5);
  assert.equal(run(candidate().slice(1)).code, 1);
});
test('duplicate, invalid and fabricated timestamp outputs fail evaluation', () => {
  const duplicate = candidate(); duplicate[1] = duplicate[0]!; assert.equal(run(duplicate).code, 1);
  const bad = candidate(); bad[0]!.output.reset!.whenText = '2030-01-01T00:00:00Z';
  const r = run(bad); assert.equal(r.code, 1); assert.equal(r.data?.invalid, 1);
});
