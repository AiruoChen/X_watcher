import type { AnalysisJob, PostVersion } from '../model.js';
import { stableId } from '../identifiers.js';
export function validateReanalysis(job: AnalysisJob, post: PostVersion | null): void {
  if (!post || post.deleted || post.targetId !== job.targetId || post.key !== job.postKey
    || ![job.analyzerVersion,job.promptVersion,job.configRevision].every(x => typeof x === 'string' && x.trim())
    || job.id !== stableId('analysis', job.postKey, job.analyzerVersion, job.promptVersion)
    || job.emitNotifications || job.state !== 'pending' || job.revision !== 0 || job.attempts !== 0 || job.nextAttemptAt !== null)
    throw new Error('Invalid reanalysis request.');
}
