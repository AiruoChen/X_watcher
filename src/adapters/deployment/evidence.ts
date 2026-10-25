import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import type{BuildInfo,OfflineEvidence}from'../../domain/model.js';
export function readEvidence(path:string,build:BuildInfo,now=new Date()):OfflineEvidence{
  try{
    const raw=readFileSync(path,'utf8');if(raw.length>4*1024*1024)throw new Error('Too large');
    const r=JSON.parse(raw) as Record<string,any>,b=r['build'],scenarios=r['scenarios'];
    const ids=Array.isArray(scenarios)?scenarios.map((s:Record<string,unknown>)=>s['id']):[];
    const bound=r['formatVersion']===1&&r['kind']==='offline_acceptance'&&r['status']==='passed'&&r['productionReady']===false
      &&b?.sourceHash===build.sourceHash&&b?.lockHash===build.lockHash&&b?.version===build.version&&b?.schemaVersion===build.schemaVersion
      &&build.commit!==null&&b?.commit===build.commit&&b?.dirty===false&&build.dirty!==true
      &&Number.isFinite(Date.parse(r['at']))&&Date.parse(r['at'])<=now.getTime()+60000
      &&/^[a-f0-9]{64}$/.test(r['testSuiteHash'])&&r['tests']?.failed===0&&Number.isSafeInteger(r['tests']?.passed)&&r['tests']?.passed>0&&ids.length===20
      &&new Set(ids).size===20&&ids.every((id:unknown)=>typeof id==='string'&&/^AC-(?:0[1-9]|1\d|20)$/.test(id))
      &&scenarios.every((s:Record<string,any>)=>s['status']==='offline_passed'&&Array.isArray(s['checks'])&&s['checks'].length>0
        &&s['checks'].every((c:Record<string,unknown>)=>c['passed']===true&&Number.isSafeInteger(c['matched'])&&Number(c['matched'])>0));
    if(!bound)return{accepted:false,sha256:null,capacity:false,syntheticTiming:false};
    const c=r['capacity'],t=r['timing'];
    return{accepted:true,sha256:createHash('sha256').update(raw).digest('hex'),
      capacity:c?.targets===10&&c?.postVersions===100000&&c?.returnedPosts===24&&Array.isArray(c?.plan)&&c.plan.some((p:unknown)=>String(p).includes('posts_target_time')),
      syntheticTiming:t?.status==='passed'&&t?.kind==='synthetic_timing'&&t?.realTimingMeasured===false&&t?.samples>=20
        &&t?.resetP95Ms>=0&&t?.resetP95Ms<=120000&&t?.dailyOffsetMs>=0&&t?.dailyOffsetMs<=300000};
  }catch{return{accepted:false,sha256:null,capacity:false,syntheticTiming:false};}
}
