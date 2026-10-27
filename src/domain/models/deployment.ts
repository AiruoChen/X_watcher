export interface BuildInfo { readonly formatVersion:1; readonly version:string; readonly node:string; readonly schemaVersion:number;
  readonly sourceHash:string; readonly lockHash:string; readonly commit:string|null; readonly dirty:boolean|null }
export interface DeploymentSession { readonly formatVersion:1; readonly id:string; readonly pid:number; readonly processIdentity:string|null; readonly startedAt:string;
  readonly endedAt:string|null; readonly mode:'demo'|'preview'; readonly configRevision:string; readonly build:BuildInfo;
  readonly outcome:'running'|'stopped'|'failed' }
export interface DeploymentHealth {
  readonly state:'healthy'|'starting'|'stopped'|'degraded'|'invalid_database'; readonly operational:boolean;
  readonly mode:'demo'|'preview'|'live'; readonly schemaVersion:number|null; readonly build:BuildInfo;
  readonly code:string; readonly coverage:'verified_query'|'unverified_snapshot'|'simulated'|'unknown';
  readonly preview:{readonly sessionHours:number;readonly observations:number;readonly maxGapMs:number|null;readonly configMatched:boolean;readonly buildMatched:boolean;readonly mature:boolean};
  readonly counts:{readonly unresolvedMail:number;readonly pendingAnalysis:number;readonly openIncidents:number};
}
export interface ReleaseGate { readonly id:string; readonly state:'passed'|'pending'|'blocked'; readonly code:string }
export interface ReleaseAssessment { readonly productionReady:false; readonly gates:readonly ReleaseGate[] }

export interface OfflineEvidence {readonly accepted:boolean;readonly sha256:string|null;readonly capacity:boolean;readonly syntheticTiming:boolean}
