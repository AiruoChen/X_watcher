import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {BuildInfo,Coverage,DeploymentHealth,DeploymentSession,RuntimeConfig,ScheduledTask} from '../../domain/model.js';
import {validateHistory} from '../storage/sqlite/migrations.js';
import {inspectDatabase} from '../storage/sqlite/integrity.js';
type Lease={pid:number;leaseUntil:string;acquiredAt:string;processIdentity?:string};
export function inspectDeployment(config:RuntimeConfig,build:BuildInfo,now=new Date(),deep=false):DeploymentHealth {
  const base={mode:config.mode,build,preview:{sessionHours:0,observations:0,maxGapMs:null,configMatched:false,buildMatched:false,mature:false},
    counts:{unresolvedMail:0,pendingAnalysis:0,openIncidents:0},coverage:config.mode==='demo'?'simulated' as const:'unknown' as const};
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(config.storage.path,{readOnly:true});db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const schema=deep?inspectDatabase(db):validateHistory(db);
    const leaseRow=db.prepare('SELECT payload FROM runtime_ownership WHERE singleton=1').get()!;
    const lease=leaseRow['payload']===null?null:JSON.parse(String(leaseRow['payload'])) as Lease;
    const counts={unresolvedMail:Number(db.prepare("SELECT COUNT(*) n FROM notifications WHERE state IN ('sending','needs_attention')").get()!['n']),
      pendingAnalysis:Number(db.prepare("SELECT COUNT(*) n FROM analysis_jobs WHERE state!='completed'").get()!['n']),
      openIncidents:schema>=7?Number(db.prepare("SELECT COUNT(*) n FROM operation_incidents WHERE json_extract(payload,'$.state')='open'").get()!['n']):0};
    if(schema!==build.schemaVersion){db.exec('COMMIT');return{...base,counts,schemaVersion:schema,state:'degraded',operational:false,code:lease?'active_host_schema_upgrade':'schema_upgrade_required'};}
    const tasks=db.prepare('SELECT payload FROM runtime_tasks').all().map(r=>JSON.parse(String(r['payload'])) as ScheduledTask)
      .filter(t=>t.stage==='ingest' && config.targets.some(target=>target.id===t.targetId));
    const last=new Map(config.targets.map(t=>{
      const row=db!.prepare("SELECT payload FROM coverage_ranges WHERE target_id=? AND json_type(payload,'$.observation')='object' ORDER BY end_ms DESC LIMIT 1").get(t.id);
      return[t.id,row?JSON.parse(String(row['payload'])) as Coverage:undefined] as const;
    }));
    const coverage=config.mode==='demo'?'simulated' as const:[...last.values()].some(c=>c?.scope==='rsshub_timeline_snapshot')?'unverified_snapshot' as const:
      config.targets.every(t=>last.get(t.id)?.status==='complete')?'verified_query' as const:'unknown' as const;
    let session:DeploymentSession|undefined;
    try{
      const folder=join(dirname(config.storage.path),'deployment-sessions');
      session=readdirSync(folder).filter(p=>/^[a-f0-9-]{36}\.json$/.test(p)).flatMap(p=>{try{return[JSON.parse(readFileSync(join(folder,p),'utf8')) as DeploymentSession];}catch{return[];}})
        .filter(s=>s.formatVersion===1 && s.pid===lease?.pid && (s.processIdentity??null)===(lease?.processIdentity??null) && s.outcome==='running' && s.endedAt===null
          && Date.parse(s.startedAt)<=Date.parse(lease.acquiredAt) && Date.parse(lease.acquiredAt)-Date.parse(s.startedAt)<120000)
        .sort((a,b)=>a.startedAt.localeCompare(b.startedAt)).at(-1);
    }catch{/* An absent/unreadable receipt supplies no preview evidence. */}
    const configMatched=session?.configRevision===config.revision,buildMatched=session?.build.sourceHash===build.sourceHash && session?.build.commit===build.commit;
    const started=session?Date.parse(session.startedAt):NaN;
    const windowStart=Number.isFinite(started)?Math.max(started,now.getTime()-48*3600000):now.getTime()-48*3600000;
    const margin=Math.max(config.x.safetyLagMs,config.rsshub.safetyLagMs)+config.services.source.timeoutMs;
    const ranges=config.targets.flatMap(t=>db!.prepare('SELECT payload FROM coverage_ranges WHERE target_id=? AND end_ms>=? ORDER BY end_ms DESC LIMIT 4096').all(t.id,windowStart-margin)
      .map(r=>JSON.parse(String(r['payload'])) as Coverage));
    const during=ranges.filter(c=>c.observation && Date.parse(c.observation.startedAt)>=windowStart && Date.parse(c.observation.completedAt)<=now.getTime());
    const span=now.getTime()-started;
    let maxGapMs=0;
    for(const target of config.targets){
      const observations=during.filter(c=>c.targetId===target.id).map(c=>c.observation!).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
      let previous=windowStart;
      for(const o of observations){maxGapMs=Math.max(maxGapMs,Date.parse(o.startedAt)-previous);previous=Date.parse(o.completedAt);}
      maxGapMs=Math.max(maxGapMs,now.getTime()-previous);
    }
    const sessionHours=Number.isFinite(span)?Math.max(0,span/3600000):0;
    const preview={sessionHours:Number(sessionHours.toFixed(3)),observations:during.length,maxGapMs:session?maxGapMs:null,configMatched,buildMatched,
      mature:config.mode==='preview' && !!configMatched && !!buildMatched && build.commit!==null && build.dirty!==true && sessionHours>=48
        && config.targets.every(t=>during.some(c=>c.targetId===t.id)) && maxGapMs<=config.pollIntervalMs+config.services.source.timeoutMs};
    const futureStamp=(session && Date.parse(session.startedAt)>now.getTime()) || [...last.values()].some(c=>c && Date.parse(c.observation!.completedAt)>now.getTime()+1000);
    const live=!!lease && Date.parse(lease.leaseUntil)>now.getTime() && !!session;
    const badTask=tasks.some(t=>t.state==='needs_attention'||t.failureCode==='budget_exhausted');
    const stale=config.targets.some(t=>{const c=last.get(t.id);return !c || now.getTime()-Date.parse(c.observation!.completedAt)>config.policy.staleAfterMs;});
    const state=!lease?'stopped':!live || !buildMatched || !configMatched || futureStamp?'degraded':badTask||counts.openIncidents?'degraded':stale?'starting':'healthy';
    db.exec('COMMIT');
    return{...base,counts,coverage,preview,schemaVersion:schema,state,operational:state==='healthy',
      code:!lease?'no_running_host':!live?'lease_or_session_unverified':!buildMatched || !configMatched?'build_or_config_changed':futureStamp?'clock_changed':badTask?'source_paused':counts.openIncidents?'open_incident':stale?'source_observation_missing_or_stale':'operational'};
  }catch{
    try{db?.exec('ROLLBACK');}catch{}
    return{...base,schemaVersion:null,state:'invalid_database',operational:false,code:'database_unavailable_or_invalid'};
  }finally{db?.close();}
}
