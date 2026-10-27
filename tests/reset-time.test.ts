import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResetTime } from '../src/domain/policies/reset-time.js';
import { analyzer, output, post } from './helpers/analysis-mail.js';
import { validateAnalysis } from '../src/domain/validation.js';
for (const [text, zone, expected] of [
  ['3 January 2026 at 09:00 UTC', null, '2026-01-03T09:00:00.000Z'],
  ['January 3, 2026 at 9:00 AM UTC', null, '2026-01-03T09:00:00.000Z'],
  ['January 3, 2026 at 12 PM', 'UTC', '2026-01-03T12:00:00.000Z'],
  ['3 Jan 2026 12 AM GMT', null, '2026-01-03T00:00:00.000Z'],
  ['2026年1月3日 09:00 UTC', null, '2026-01-03T09:00:00.000Z'],
  ['2026年1月3日下午3点30分', '北京时间', '2026-01-03T07:30:00.000Z'],
  ['2026-01-03 09:00 UTC+08:00', null, '2026-01-03T01:00:00.000Z'],
  ['2026-01-03 09:00', 'Asia/Shanghai', '2026-01-03T01:00:00.000Z'],
  ['2026-01-03 09:00 America/New_York', null, '2026-01-03T14:00:00.000Z'],
  ['2026-07-03 09:00 America/New_York', null, '2026-07-03T13:00:00.000Z'],
  ['2026-01-03 09:00', 'Asia/Kathmandu', '2026-01-03T03:15:00.000Z'],
  ['2026-01-03T09:00:00.123+08:00', 'Asia/Shanghai', '2026-01-03T01:00:00.123Z'],
  ['2026-11-01 01:30 America/New_York', null, null],
  ['2026-03-08 02:30 America/New_York', null, null],
  ['2026-02-30 09:00 UTC', null, null],
  ['2026-01-03 24:00 UTC', null, null],
  ['2026-01-03 13 PM UTC', null, null],
  ['3 January 2026 9 AM PST', null, null],
  ['2026-01-03 09:00 UTC', 'Asia/Shanghai', null],
  ['2026-01-03T09:00:00+08:00', 'UTC', null],
  ['2026-01-03 09:00', null, null],
  ['03/04/2026 09:00 UTC', null, null],
  ['tomorrow at 09:00 UTC', null, null],
  ['Friday at noon', 'UTC', null],
] as const) test('reset time: ' + text + ' / ' + zone, () => assert.equal(normalizeResetTime(text, zone), expected));
test('natural time survives adapter and store validation; invented normalized timestamps still fail', async () => {
  const p = { ...post, text: 'ChatGPT quotas reset on 3 January 2026 at 09:00 UTC.' }, value = output(p);
  value.reset.whenText = '3 January 2026 at 09:00 UTC';
  const result = await analyzer(value).analyze(p); validateAnalysis(p, result);
  assert.equal(result.resetFinding.kind === 'none' ? null : result.resetFinding.normalizedAt, '2026-01-03T09:00:00.000Z');
  assert.throws(() => validateAnalysis(p, { ...result, resetFinding: { ...result.resetFinding, normalizedAt: '2026-01-04T09:00:00Z' } }));
});
