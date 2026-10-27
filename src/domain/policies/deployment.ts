import type { DeploymentHealth,OfflineEvidence,ReleaseAssessment,ReleaseGate } from '../models/deployment.js';
/** Current real analysis/mail factories are intentionally unavailable; no evidence flips a runtime mode. */
export function assessRelease(health:DeploymentHealth,evidence?:OfflineEvidence):ReleaseAssessment {
  const gate=(id:string,passed:boolean,code:string,state:'pending'|'blocked'='blocked'):ReleaseGate=>({id,state:passed?'passed':state,code:passed?'verified':code});
  return {productionReady:false,gates:[
    gate('database',health.schemaVersion===health.build.schemaVersion,'database_upgrade_or_recovery_required'),
    gate('operational_health',health.operational,'host_not_healthy'),
    gate('real_source',health.mode==='preview' && health.coverage!=='simulated','preview_required'),
    gate('source_coverage',health.coverage==='verified_query','coverage_not_proven'),
    gate('preview_48h',health.preview.mature,'same_build_config_observation_required','pending'),
    gate('unresolved_mail',health.counts.unresolvedMail===0,'manual_reconciliation_required'),
    gate('incidents',health.counts.openIncidents===0,'open_incident'),
    gate('offline_ac01_20',evidence?.accepted===true,'use_bound_offline_acceptance_artifact','pending'),
    gate('capacity_nfr09',evidence?.capacity===true,'use_measured_capacity_artifact','pending'),
    gate('synthetic_timing',evidence?.syntheticTiming===true,'synthetic_timing_not_run','pending'),
    {id:'real_timing_nfr03',state:'pending',code:'synthetic_timing_is_not_online_measurement'},
    {id:'model_quality',state:'pending',code:'real_model_provider_not_selected'},
    {id:'controlled_mail',state:'pending',code:'real_mail_provider_not_selected'},
    {id:'live_adapter',state:'blocked',code:'live_not_implemented'},
  ]};
}
