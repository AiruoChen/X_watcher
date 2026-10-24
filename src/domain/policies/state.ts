import type { AnalysisJobState, DeliveryState, ReportState } from '../model.js';
import { RevisionConflictError } from '../errors.js';

const jobs: Record<AnalysisJobState, readonly AnalysisJobState[]> = {
  pending: ['processing'], processing: ['completed', 'retry_wait', 'needs_attention'],
  retry_wait: ['processing', 'needs_attention'], completed: [], needs_attention: [],
};
const delivery: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ['sending'], sending: ['provider_accepted', 'failed', 'needs_attention', 'retry_wait'],
  provider_accepted: ['delivered', 'bounced'], delivered: [], bounced: [],
  retry_wait: ['sending'], failed: [], needs_attention: [],
};
const reports: Record<ReportState, readonly ReportState[]> = {
  awaiting_data: ['awaiting_analysis', 'ready', 'empty'], awaiting_analysis: ['ready', 'empty'],
  ready: ['superseded'], empty: ['superseded'], superseded: [],
};
function transition<S extends string>(graph: Record<S, readonly S[]>, from: S, to: S): S {
  if (!graph[from]?.includes(to)) throw new Error(`Illegal state transition: ${from} -> ${to}`);
  return to;
}
export const transitionJob = (from: AnalysisJobState, to: AnalysisJobState): AnalysisJobState => transition(jobs, from, to);
export const transitionDelivery = (from: DeliveryState, to: DeliveryState): DeliveryState => transition(delivery, from, to);
export const transitionReport = (from: ReportState, to: ReportState): ReportState => transition(reports, from, to);
export function requireRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) throw new RevisionConflictError();
}
