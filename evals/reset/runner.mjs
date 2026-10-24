import { readFileSync } from 'node:fs';
import { evaluate, datasetSummary } from './evaluate.mjs';
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
if (!process.argv[2]) {
  console.log(JSON.stringify({ status: 'not_run', ...datasetSummary(cases), reason: 'Supply local model outputs; no provider has been selected.' }));
} else {
  const result = evaluate(cases, JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(result));
  if (result.status !== 'passed') process.exitCode = 1;
}
