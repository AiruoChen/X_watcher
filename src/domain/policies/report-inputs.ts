import type { DigestReport, DigestWindow, ReportInputs, ReportItem, ReportProgress, SourceObservation, ReportBoundary, Coverage, Checkpoint } from '../model.js';
import { covers } from './coverage.js';
import { reportInputToken, validDay } from './reporting.js';
import { isInstant } from '../time.js';
export function buildReportInputs(data: {
  targetId: string; window: DigestWindow; checkpoint: Checkpoint; observation: SourceObservation | null;
  coverage: readonly Coverage[]; progress: ReportProgress | null; boundary: ReportBoundary | null;
  previous: DigestReport | null; previousItems: readonly ReportItem[]; items: readonly ReportItem[];
}): ReportInputs {
  if (!validDay(data.window.day) || !isInstant(data.window.from) || !isInstant(data.window.to)
    || Date.parse(data.window.from) >= Date.parse(data.window.to)) throw new Error('Invalid report window.');
  const relevant = data.coverage.filter(c => Date.parse(c.from) < Date.parse(data.window.to) && Date.parse(c.to) > Date.parse(data.window.from))
    .sort((a, b) => a.id.localeCompare(b.id));
  const input = { ...data, coverage: relevant, covered: covers(relevant, data.targetId, data.window) };
  return structuredClone({ ...input, token: reportInputToken(input) });
}
export function validateObservation(observation: { readonly startedAt: string; readonly completedAt: string } | undefined): void {
  if (observation && (!isInstant(observation.startedAt) || !isInstant(observation.completedAt)
    || Date.parse(observation.completedAt) < Date.parse(observation.startedAt))) throw new Error('Invalid source observation.');
}
