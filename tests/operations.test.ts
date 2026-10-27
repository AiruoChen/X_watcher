import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ControlCommand, Notification } from '../src/domain/model.js';
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { migrate, MIGRATIONS } from '../src/adapters/storage/sqlite/migrations.js';
import { restoreBackup } from '../src/adapters/storage/sqlite/backup.js';
import { exportHistory } from '../src/adapters/storage/export.js';
import { ManualClock } from '../src/adapters/clock.js';
import { BudgetController } from '../src/application/budget.js';
import { ManageHealth } from '../src/application/health.js';
import { IngestTarget } from '../src/application/ingest-target.js';
import { ProcessAnalysis } from '../src/application/process-analysis.js';
import { DeliverNotifications } from '../src/application/deliver-notifications.js';
import { BuildReport } from '../src/application/build-report.js';
import { ReportTextRenderer } from '../src/application/report-renderer.js';
import { FixtureSource } from '../src/adapters/source/fixture-source.js';
import { FixtureAnalyzer } from '../src/adapters/analysis/fixture-analyzer.js';
import { StructuredAnalyzer } from '../src/adapters/analysis/structured-analyzer.js';
import { loadConfig } from '../src/config.js';
import { loadLocalConfig } from '../src/config/load.js';
import { createReadonlySource } from '../src/bootstrap-source.js';
import { BudgetExceeded, SourceFailure } from '../src/domain/errors.js';
import { safeEvent } from '../src/adapters/observability/console-events.js';
import { budgetReason, localDay } from '../src/domain/policies/operations.js';
import { digestWindowForDay } from '../src/domain/time.js';
import { operationStatus } from '../src/operations.js';
import { contractFixture as f, seeded } from './contracts/watch-store.contract.js';
import { runtimeFixture, flush, deferred } from './helpers/runtime.js';
import { temporaryStorage, cleanupStorage } from './helpers/storage.js';
import { hasher, output, post as modelPost } from './helpers/analysis-mail.js';
import { author, page, post as xPost } from './fixtures/x.js';
import { previewEnv } from './helpers/x.js';

const now='2026-01-02T00:00:00.000Z', window=digestWindowForDay('2026-01-01','Asia/Shanghai');
const answer={summary:'Synthetic safe summary',chatgptUpdates:[],reset:null};
const mail:Notification={id:'synthetic-mail',targetId:f.target.id,kind:'reset',recipient:'reader@example.invalid',subject:'Synthetic',text:'Synthetic mail body',createdAt:now};
function setup(env:NodeJS.ProcessEnv={},path=':memory:') {
  const clock=new ManualClock(new Date(now)),config=loadConfig({STORAGE_KIND:'sqlite',...env});
  const store=new SqliteStore(path,{create:true,claims:{clock}});let sequence=0;
  const gate=new BudgetController(store.operations,clock,config,()=> 'test-'+ ++sequence),health=new ManageHealth(store.operations,clock,config);
  return {clock,config,store,gate,health,close:()=>store.close()};
}
function control(s:ReturnType<typeof setup>,extra:Partial<ControlCommand>={}):ControlCommand {
  return {id:'command-1',kind:'check',targetId:f.target.id,entityId:null,expectedRevision:null,at:s.clock.now().toISOString(),reason:'Synthetic operator request',...extra};
}
async function reportFixture(path=':memory:') {
  const s=setup({},path);await seeded(()=>s.store);
  await new ProcessAnalysis(new FixtureAnalyzer(new Map([[f.sample.id,answer]])),s.store,[],s.clock,s.config).execute(f.target);
  new BuildReport(s.store,hasher,new ReportTextRenderer(),s.config).execute(f.target,window,now);
  for(const n of s.store.outbox()) {const claim=s.store.claimDelivery(n.notification.id,now)!;s.store.finishDelivery(claim.attemptId,{status:'accepted',providerId:'synthetic'},now);}
  return s;
}
test('budget configuration validates per-service caps, prices/reference and reviewed retention without inventing a tariff',()=>{
  const cfg=loadConfig({MAX_SOURCE_CALLS_PER_DAY:'12',SOURCE_MAX_COST_PER_CALL:'0.000001',BUDGET_CURRENCY:'USD',BUDGET_PRICE_REFERENCE:'Synthetic configured ceiling'});
  assert.equal(cfg.budget.serviceCalls.source,12);assert.equal(cfg.budget.unitMicros.source,1);assert.equal(cfg.budget.unitMicros.analysis,null);
  assert.equal(cfg.operations.retentionTermsReviewed,false);
  for(const env of [{MAX_MAIL_CALLS_PER_DAY:'0'},{SOURCE_MAX_COST_PER_CALL:'0.0000001'},
    {SOURCE_MAX_COST_PER_CALL:'1'},{AUTO_CLEANUP:'true'},{RETENTION_TERMS_REVIEWED:'yes'}])assert.throws(()=>loadConfig(env));
});
test('durable reservations enforce global and independent service limits; cancellation is allowed only before start',async()=>{
  const s=setup({MAX_CALLS_PER_DAY:'3',MAX_SOURCE_CALLS_PER_DAY:'1'});
  try{
    const permit=s.gate.reserve('source');permit.cancel();assert.equal(s.store.operations.usage()[0]!.calls,0);
    await s.gate.reserve('source').run(async()=>1);assert.throws(()=>s.gate.reserve('source'),BudgetExceeded);
    const analysis=s.gate.reserve('analysis');await analysis.run(async()=>2);assert.throws(()=>analysis.cancel());await assert.rejects(analysis.run(async()=>2));
    await s.gate.reserve('mail').run(async()=>3);assert.throws(()=>s.gate.reserve('analysis'),BudgetExceeded);
    assert.equal(s.store.operations.usage().reduce((n,r)=>n+r.calls,0),3);
  }finally{s.close();}
});
test('configured cost ceilings stop before overspend; unknown prices and earlier unpriced calls remain unknown',async()=>{
  const s=setup({MAX_COST_PER_DAY:'0.02',SOURCE_MAX_COST_PER_CALL:'0.01',BUDGET_CURRENCY:'USD',BUDGET_PRICE_REFERENCE:'Synthetic price ceiling'});
  try{
    await s.gate.reserve('source').run(async()=>undefined);await s.gate.reserve('source').run(async()=>undefined);
    assert.throws(()=>s.gate.reserve('source'),(e:unknown)=>e instanceof BudgetExceeded&&e.reason==='cost');
    assert.throws(()=>s.gate.reserve('analysis'),(e:unknown)=>e instanceof BudgetExceeded&&e.reason==='price_unknown');
    const status=operationStatus(s.store,s.config,s.clock.now()) as {budget:{estimatedKnownCost:number}};
    assert.equal(status.budget.estimatedKnownCost,0.02);
  }finally{s.close();}
  const u=setup();
  try{await u.gate.reserve('source').run(async()=>undefined);
    const changed=loadConfig({MAX_COST_PER_DAY:'1',SOURCE_MAX_COST_PER_CALL:'0.01',BUDGET_CURRENCY:'USD',BUDGET_PRICE_REFERENCE:'Synthetic ceiling'});
    assert.equal(budgetReason(u.store.operations.usage(),'source',changed.budget),'price_unknown');
  }finally{u.close();}
});
test('failed and crashed calls consume reservations; known model tokens are stored without assuming unknown usage is zero',async()=>{
  const s=setup({MAX_ANALYSIS_CALLS_PER_DAY:'3'});
  try{
    await assert.rejects(s.gate.reserve('analysis').run(async()=>{throw new Error('synthetic failure');}));
    const unknown=s.gate.reserve('analysis');void unknown; // Simulates a crash before invocation/settlement; no automatic refund.
    const analyzer=new StructuredAnalyzer({capability:'simulated',complete:async()=>({status:'refused',output:null,usage:{inputTokens:100,outputTokens:5}})},
      hasher,{model:'synthetic',version:'fixture-v1',promptVersion:'v1',allowPartial:false});
    await assert.rejects(s.gate.reserve('analysis').run(()=>analyzer.analyze(modelPost)));
    const total=s.store.operations.usage()[0]!;
    assert.equal(total.calls,3);assert.equal(total.measuredCalls,1);assert.equal(total.inputTokens,100);assert.equal(total.outputTokens,5);
    assert.throws(()=>s.gate.reserve('analysis'),BudgetExceeded);
    assert.equal(s.store.operations.summary()['unresolvedUsage'],1);
  }finally{s.close();}
});
test('two connections and restart cannot oversubscribe or reset a day; a backwards clock cannot reopen quota',async()=>{
  const root=temporaryStorage(),path=join(root,'budget.sqlite'),s=setup({MAX_CALLS_PER_DAY:'1'},path);let second:SqliteStore|undefined;
  try{
    await s.gate.reserve('source').run(async()=>1);second=new SqliteStore(path);
    const other=new BudgetController(second.operations,s.clock,s.config,()=> 'other');
    assert.throws(()=>other.reserve('analysis'),BudgetExceeded);second.close();second=new SqliteStore(path);
    s.clock.advance(86400000);const next=new BudgetController(second.operations,s.clock,s.config,()=> 'next');
    await next.reserve('source').run(async()=>1);s.clock.jumpWallClock(-86400000);
    assert.throws(()=>s.gate.reserve('source'),BudgetExceeded);
    assert.equal(second.operations.budgetDay('2026-01-02'),'2026-01-03');
  }finally{second?.close();s.close();cleanupStorage(root);}
});
test('usage reservation and totals roll back together on an injected SQL failure',()=>{
  const root=temporaryStorage(),path=join(root,'rollback.sqlite'),s=setup({},path);
  try{const raw=new DatabaseSync(path);raw.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON usage_daily BEGIN SELECT RAISE(ABORT,'synthetic'); END");raw.close();
    assert.throws(()=>s.gate.reserve('source'));assert.equal(s.store.operations.usage().length,0);assert.equal(s.store.operations.summary()['unresolvedUsage'],0);
  }finally{s.close();cleanupStorage(root);}
});
test('every X identity/page HTTP request is metered; exhaustion mid-pagination leaves the authoritative checkpoint unchanged',async()=>{
  const config=loadConfig({...previewEnv,MAX_SOURCE_CALLS_PER_DAY:'2'}),s=setup();let requests=0;
  const gate=new BudgetController(s.store.operations,s.clock,config,()=> 'http-'+requests);
  const {source,client}=createReadonlySource(config,previewEnv,s.clock,async url=>{
    requests++;const body=url.pathname.includes('/users/')?author:page([xPost('200')],'next');
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  },gate);
  try{
    await assert.rejects(new IngestTarget(source,s.store,s.clock,config,hasher).execute(config.targets[0]!),BudgetExceeded);
    assert.equal(requests,2);assert.equal(client.requestCount,2);assert.equal(s.store.checkpoint(f.target.id).revision,0);
    assert.equal(s.store.versions(f.target.id).length,0);assert.equal(s.store.operations.usage()[0]!.calls,2);
    assert.equal(s.store.outbox().length,0);assert.equal(s.store.operations.incidents()[0]!.code,'budget_exhausted');
  }finally{s.close();}
});
test('RSSHub resolution cache is one HTTP request; later denied polling cannot advance the observation checkpoint',async()=>{
  const config=loadLocalConfig({APP_MODE:'preview',STORAGE_KIND:'sqlite',SOURCE_PROVIDER:'rsshub',ANALYSIS_PROVIDER:'deferred',
    ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:'',MAX_SOURCE_CALLS_PER_DAY:'1'}),s=setup();let requests=0;
  const gate=new BudgetController(s.store.operations,s.clock,config,()=> 'rss-'+requests);
  const t=config.targets[0]!;
  const {source}=createReadonlySource(config,{},s.clock,async()=>{
    requests++;return new Response(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'Synthetic',home_page_url:'https://x.com/'+t.handle,items:[]}),
      {headers:{'content-type':'application/feed+json'}});
  },gate);
  try{
    await new IngestTarget(source,s.store,s.clock,config,hasher).execute(t);assert.equal(requests,1);
    assert.equal(s.store.coverage(t.id)[0]!.status,'gap');const before=s.store.checkpoint(t.id);
    s.clock.advance(60000);await assert.rejects(new IngestTarget(source,s.store,s.clock,config,hasher).execute(t),BudgetExceeded);
    assert.deepEqual(s.store.checkpoint(t.id),before);assert.equal(s.store.operations.usage()[0]!.calls,1);
  }finally{s.close();}
});
test('analysis cap is checked before claim; no-new-post and duplicate versions make no model calls',async()=>{
  const s=setup({MAX_ANALYSIS_CALLS_PER_DAY:'1'});
  try{
    await new IngestTarget(new FixtureSource([f.sample,{...f.sample,id:'second'}]),s.store,s.clock,s.config,hasher).execute(f.target);
    const run=new ProcessAnalysis(new FixtureAnalyzer(new Map([[f.sample.id,answer],['second',answer]])),s.store,[],s.clock,s.config,s.gate);
    await assert.rejects(run.execute(f.target),BudgetExceeded);
    assert.deepEqual(s.store.analysisJobs(f.target.id).map(j=>j.state),['completed','pending']);
    assert.equal(s.store.operations.usage()[0]!.calls,1);
    s.clock.advance(86400000);await run.execute(f.target);await run.execute(f.target);
    assert.equal(s.store.operations.usage().reduce((n,r)=>n+r.calls,0),2);
  }finally{s.close();}
});
test('mail cap leaves later notifications pending and unknown mail cannot be auto-retried even on a new budget day',async()=>{
  const s=setup({MAX_MAIL_CALLS_PER_DAY:'1'});let calls=0;
  try{
    s.store.enqueue(mail);s.store.enqueue({...mail,id:'second'});
    const delivery=new DeliverNotifications(s.store,{capability:'simulated',send:async()=>{calls++;return{status:'unknown',reason:'Synthetic unknown'};}},s.clock,s.gate);
    await assert.rejects(delivery.execute(),BudgetExceeded);
    assert.equal(s.store.deliveryRecord(mail.id)!.entry.state,'needs_attention');
    assert.equal(s.store.deliveryRecord('second')!.entry.state,'pending');assert.equal(s.store.deliveryRecord('second')!.attempt,null);
    assert.equal(calls,1);s.clock.advance(86400000);
    await assert.rejects(delivery.execute(),BudgetExceeded);assert.equal(calls,2);
    assert.equal(s.store.deliveryAttempts().filter(a=>a.notificationId===mail.id).length,1);
  }finally{s.close();}
});
test('scheduler persists budget pause without exhausting source retries or bypassing it on 08:00 rechecks',async()=>{
  const s=runtimeFixture({MAX_SOURCE_CALLS_PER_DAY:'1',POLL_INTERVAL_MINUTES:'1'});const {scheduler}=s.app();
  try{s.store.runtime.acquire(3600000);scheduler.initialize();scheduler.pulse(s.context);await scheduler.drain();
    s.clock.advance(60000);scheduler.pulse(s.context);await scheduler.drain();
    const task=s.store.schedules.tasks().find(t=>t.stage==='ingest')!;
    assert.equal(task.failureCode,'budget_exhausted');assert.equal(task.state,'idle');assert.equal(task.failures,0);
    assert.equal(task.retryNotBeforeAt,'2026-01-02T16:00:00.000Z');
    s.clock.advance(60000);scheduler.pulse(s.context);await scheduler.drain();
    assert.equal(s.store.operations.usage().find(u=>u.service==='source')!.calls,1);
  }finally{s.close();}
});
test('persistent incidents notify once after threshold, recover once, and increment generation for a later outage',()=>{
  const root=temporaryStorage(),path=join(root,'incident.sqlite'),s=setup({},path);let other:SqliteStore|undefined;
  try{
    for(let i=0;i<5;i++)s.health.failure('ingest',f.target.id,new Error('secret body reader@example.invalid'));
    assert.equal(s.store.outbox().length,1);assert.equal(s.store.operations.incidents()[0]!.generation,1);
    other=new SqliteStore(path);const health=new ManageHealth(other.operations,s.clock,s.config);
    health.failure('ingest',f.target.id,new Error('secret'));assert.equal(other.outbox().length,1);
    health.observe('ingest',f.target.id,true,'source_failed');health.observe('ingest',f.target.id,true,'source_failed');
    assert.equal(other.outbox().length,2);assert.equal(other.operations.incidents()[0]!.state,'resolved');
    for(let i=0;i<3;i++)health.failure('ingest',f.target.id,new Error('synthetic'));
    assert.equal(other.outbox().length,3);assert.equal(other.operations.incidents()[0]!.generation,2);
    assert.ok(!JSON.stringify(other.operations.summary()).includes('reader@example.invalid'));
  }finally{other?.close();s.close();cleanupStorage(root);}
});
test('permanent failures are visible immediately; successful polling then staleness opens one separate persistent episode',()=>{
  const s=setup();
  try{
    s.health.failure('ingest',f.target.id,new SourceFailure('authentication',false));
    assert.equal(s.store.outbox().length,1);
    s.health.observe('ingest',f.target.id,true,'source_failed');s.clock.advance(s.config.policy.staleAfterMs);
    s.health.sweep();s.health.sweep();assert.equal(s.store.operations.incidents()[0]!.code,'stale');
    assert.equal(s.store.outbox().length,3);
    s.health.failure('ingest',f.target.id,new SourceFailure('page_limit',true));
    assert.equal(s.store.operations.health()[0]!.code,'page_limit');
  }finally{s.close();}
});
test('preview health remains local; logs discard extra credentials/email/text and do not stringify untrusted errors',()=>{
  const cfg=loadLocalConfig({...previewEnv}),s=setup();
  try{
    const h=new ManageHealth(s.store.operations,s.clock,cfg);
    for(let i=0;i<5;i++)h.failure('ingest',f.target.id,new Error('private source text'));
    assert.equal(s.store.outbox().length,0);assert.equal(s.store.operations.incidents()[0]!.state,'open');
    const unsafe={type:'poll.completed' as const,targetId:'private@example.invalid',newPosts:2,token:'SENSITIVE',text:'private source text',recipient:'private@example.invalid'};
    const logged=JSON.stringify(safeEvent(unsafe));
    for(const secret of ['SENSITIVE','private source text','private@example.invalid'])assert.ok(!logged.includes(secret));
    assert.equal(JSON.parse(logged).newPosts,2);
  }finally{s.close();}
});
test('second-process check-now commands are coalesced through the existing claim and cannot bypass provider backoff',async()=>{
  const s=runtimeFixture(),root=s.root;let other:SqliteStore|undefined;let calls=0;
  const source={capability:'simulated' as const,fetch:async()=>{calls++;return{posts:[],complete:true,nextCursor:null};}};
  const {scheduler}=s.app({sources:new Map([['x',source]])});
  try{
    s.store.runtime.acquire(3600000);scheduler.initialize();scheduler.pulse(s.context);await scheduler.drain();
    other=new SqliteStore(s.path);
    const c:ControlCommand={id:'check-a',kind:'check',targetId:f.target.id,entityId:null,expectedRevision:null,at:s.clock.now().toISOString(),reason:'Manual synthetic check'};
    assert.equal(other.operations.requestControl(c).state,'pending');other.operations.requestControl({...c,id:'check-b'});
    assert.equal(calls,1);s.clock.advance(1000);scheduler.pulse(s.context);await scheduler.drain();
    assert.equal(calls,2);assert.equal(other.operations.control(c.id)!.state,'applied');
    const task=s.store.schedules.tasks().find(t=>t.stage==='ingest')!;
    const claim=s.store.schedules.claim(task.id,task.revision,s.clock.now().toISOString())!;
    s.store.schedules.finish(claim.id,claim.revision,'2026-01-02T00:10:00Z',true,false,s.clock.now().toISOString(),{code:'rate_limited',retryAt:'2026-01-02T00:10:00Z'});
    other.operations.requestControl({...c,id:'check-rate-limit'});scheduler.pulse(s.context);await scheduler.drain();
    assert.equal(calls,2);assert.equal(other.operations.control('check-rate-limit')!.code,'backoff_active');
  }finally{other?.close();s.close();void root;}
});
test('explicit resume and analysis retry use revisions and never modify a running or unrelated claim',async()=>{
  const s=setup();await seeded(()=>s.store);
  try{
    const lease=s.store.runtime.acquire(3600000)!;
    s.store.schedules.ensure({id:'source-task',stage:'ingest',targetId:f.target.id,configRevision:s.config.revision,revision:0,state:'idle',dueAt:now,failures:0,startedAt:null,finishedAt:null});
    const task=s.store.schedules.claim('source-task',0,now)!;
    s.store.schedules.finish(task.id,task.revision,now,true,true,now);
    s.store.operations.requestControl(control(s,{kind:'resume',entityId:task.id,targetId:null,expectedRevision:0}));
    s.store.operations.applyControls(now);assert.equal(s.store.operations.control('command-1')!.state,'rejected');
    const paused=s.store.schedules.tasks()[0]!;
    s.store.operations.requestControl(control(s,{id:'resume-good',kind:'resume',entityId:task.id,targetId:null,expectedRevision:paused.revision}));
    s.store.operations.applyControls(now);assert.equal(s.store.schedules.tasks()[0]!.state,'idle');
    const job=s.store.claimAnalysis(s.store.analysisJobs(f.target.id)[0]!.id,now)!;s.store.failAnalysis(job.id,job.revision,null);
    const old=s.store.analysisJobs(f.target.id)[0]!;
    s.store.operations.requestControl(control(s,{id:'retry-job',kind:'retry_analysis',entityId:old.id,targetId:null,expectedRevision:old.revision}));
    s.store.operations.applyControls(now);assert.equal(s.store.analysisJobs(f.target.id)[0]!.state,'pending');
    assert.equal(s.store.deliveryAttempts().length,0);s.store.runtime.release(lease.revision);
  }finally{s.close();}
});
test('stop controls target the current host and graceful stop still persists a claimed delivery result',async()=>{
  const s=runtimeFixture(),held=deferred<import('../src/domain/model.js').DeliveryResult>();s.store.enqueue(mail);
  const {host}=s.app({notifications:{capability:'simulated',send:()=>held.promise}});const run=host.run();
  try{await flush();s.store.operations.requestControl({id:'stop-host',kind:'stop',targetId:null,entityId:null,expectedRevision:null,at:s.clock.now().toISOString(),reason:'Synthetic stop'});
    await s.waiter.step();assert.equal(s.store.deliveryRecord(mail.id)!.entry.state,'sending');
    held.resolve({status:'accepted',providerId:'synthetic'});await flush();await s.waiter.step();
    assert.equal((await run).reason,'stopped');assert.equal(s.store.deliveryRecord(mail.id)!.entry.state,'provider_accepted');
    assert.equal(s.store.runtime.current(),null);
  }finally{host.stop();held.resolve({status:'accepted',providerId:'synthetic'});await flush();await s.waiter.step();await run;s.close();}
});
test('a stale stop cannot stop a later host and rejected control commands never mutate business state',()=>{
  const s=setup();
  try{const first=s.store.runtime.acquire(3600000)!;
    s.store.operations.requestControl(control(s,{kind:'stop',targetId:null}));
    s.store.runtime.release(first.revision);const next=s.store.runtime.acquire(3600000)!;
    assert.equal(s.store.operations.applyControls(now).stop,false);assert.equal(s.store.operations.control('command-1')!.code,'host_changed');
    assert.throws(()=>s.store.operations.requestControl(control(s,{id:'bad',kind:'resume',targetId:null,entityId:'x',expectedRevision:-1})));
    s.store.runtime.release(next.revision);
  }finally{s.close();}
});
test('retention first pins report sources until audit expiry, then preserves minimal keys and cannot regenerate or resend archived data',async()=>{
  const s=await reportFixture();
  try{
    const key=s.store.versions(f.target.id)[0]!.key,note=s.store.outbox()[0]!.notification,report=s.store.reports(f.target.id)[0]!;
    s.clock.advance(91*86400000);let plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['post_versions'],0);assert.equal(plan.pinnedPosts,1);
    s.clock.advance(90*86400000);plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['post_versions'],1);assert.equal(plan.counts['digest_reports'],1);
    s.store.operations.cleanup(plan);
    assert.equal(s.store.postVersion(key),null);assert.equal(s.store.hasPostVersion(key),true);assert.equal(s.store.hasPost(f.target.id,f.sample.id),true);
    assert.equal(s.store.enqueue(note),false);assert.equal(s.store.createReportWithNotification(report,note),false);
    assert.throws(()=>s.store.reportInputs(f.target.id,window),/archived/);
    assert.equal(s.store.analysisJobs(f.target.id).length,0);assert.equal(s.store.outbox().length,0);
    await new IngestTarget(new FixtureSource([f.sample]),s.store,s.clock,s.config,hasher).execute(f.target,undefined,window.from);
    assert.equal(s.store.versions(f.target.id).length,0);assert.equal(s.store.analysisJobs(f.target.id).length,0);
  }finally{s.close();}
});
test('pending/needs_attention mail and jobs remain intact; cleanup refuses any active lease or unconfirmed send',async()=>{
  const s=await reportFixture();
  try{
    const n=s.store.outbox()[0]!.notification;s.store.enqueue({...n,id:'unknown-linked',originId:n.originId!});
    const claimed=s.store.claimDelivery('unknown-linked',now)!;
    s.clock.advance(200*86400000);let plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.throws(()=>s.store.operations.cleanup(plan),/in-flight/);
    s.store.finishDelivery(claimed.attemptId,{status:'unknown',reason:'Synthetic unresolved submission'},s.clock.now().toISOString());
    plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['post_versions'],0);assert.equal(plan.counts['digest_reports'],0);
    const lease=s.store.runtime.acquire(3600000)!;assert.throws(()=>s.store.operations.cleanup(plan),/Stop/);s.store.runtime.release(lease.revision);
    s.store.operations.cleanup(plan);assert.equal(s.store.deliveryRecord('unknown-linked')!.entry.state,'needs_attention');
    assert.equal(s.store.versions(f.target.id).length,1);
  }finally{s.close();}
});
test('unfinished analysis and report progress protect old content even when no mail exists',async()=>{
  const s=setup();await seeded(()=>s.store);
  try{
    new BuildReport(s.store,hasher,new ReportTextRenderer(),s.config).execute(f.target,window,now);
    s.clock.advance(200*86400000);
    const plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['post_versions'],0);assert.equal(plan.counts['analysis_jobs'],0);
    s.store.operations.cleanup(plan);assert.equal(s.store.analysisJobs(f.target.id)[0]!.state,'pending');
  }finally{s.close();}
});
test('recent historical addendum pins its immutable parent and all referenced source versions',async()=>{
  const s=await reportFixture();
  try{
    s.clock.advance(200*86400000);
    await new IngestTarget(new FixtureSource([{...f.sample,text:'Edited synthetic historical content'}]),s.store,s.clock,s.config,hasher).execute(f.target,undefined,window.from);
    await new ProcessAnalysis(new FixtureAnalyzer(new Map([[f.sample.id,answer]])),s.store,[],s.clock,s.config).execute(f.target);
    new BuildReport(s.store,hasher,new ReportTextRenderer(),s.config).execute(f.target,window,s.clock.now().toISOString());
    assert.equal(s.store.reports(f.target.id).length,2);
    const plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['digest_reports'],0);assert.equal(plan.counts['post_versions'],0);
  }finally{s.close();}
});
test('cleanup refuses a stale preview and rolls back all deletes/tombstones after injected SQL failure',async()=>{
  const root=temporaryStorage(),path=join(root,'cleanup.sqlite'),s=await reportFixture(path);
  try{
    s.clock.advance(200*86400000);const plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    s.store.enqueue({...mail,id:'pinned',originId:s.store.reports(f.target.id)[0]!.id});
    assert.throws(()=>s.store.operations.cleanup(plan),/plan changed/);
    const claim=s.store.claimDelivery('pinned',s.clock.now().toISOString())!;
    s.store.finishDelivery(claim.attemptId,{status:'accepted',providerId:'synthetic'},s.clock.now().toISOString());
    // The recent notification legitimately pins the report. Use a fresh independent expired fixture to inject rollback below.
    assert.equal(s.store.versions(f.target.id).length,1);
  }finally{s.close();cleanupStorage(root);}
  const r=temporaryStorage(),p=join(r,'rollback.sqlite'),v=await reportFixture(p);
  try{
    v.clock.advance(200*86400000);const plan=v.store.operations.cleanupPlan(v.clock.now().toISOString(),90,180);
    const raw=new DatabaseSync(p);raw.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON post_versions BEGIN SELECT RAISE(ABORT,'synthetic'); END");raw.close();
    assert.throws(()=>v.store.operations.cleanup(plan));assert.equal(v.store.versions(f.target.id).length,1);
    const check=new DatabaseSync(p);assert.equal(check.prepare('SELECT count(*) n FROM retained_keys').get()!['n'],0);check.close();
    assert.equal(v.store.outbox().length,1);assert.equal(v.store.reports(f.target.id).length,1);
  }finally{v.close();cleanupStorage(r);}
});
test('backup/restore verifies checksum without replacing files; dedup tombstones and usage totals survive restore',async()=>{
  const root=temporaryStorage(),path=join(root,'live.sqlite'),backup=join(root,'backup.sqlite'),restored=join(root,'restored.sqlite'),s=await reportFixture(path);
  let copy:SqliteStore|undefined;
  try{
    await s.gate.reserve('source').run(async()=>1);s.clock.advance(200*86400000);
    s.store.operations.cleanup(s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180));
    const manifest=s.store.backup(backup);assert.throws(()=>restoreBackup(backup,restored,'0'.repeat(64)));assert.equal(existsSync(restored),false);
    restoreBackup(backup,restored,manifest.sha256);copy=new SqliteStore(restored);
    assert.equal(copy.hasPost(f.target.id,f.sample.id),true);assert.equal(copy.operations.usage()[0]!.calls,1);
    assert.throws(()=>restoreBackup(backup,restored,manifest.sha256));assert.throws(()=>s.store.backup(backup));
  }finally{copy?.close();s.close();cleanupStorage(root);}
});
test('history export is explicit sensitive NDJSON, filtered by scope/date, and never overwrites an existing artifact',async()=>{
  const root=temporaryStorage(),path=join(root,'history.ndjson'),s=await reportFixture();
  try{
    const rows=s.store.operations.archiveRows(window.from,'2026-01-03T00:00:00Z',[f.target.id]);
    const result=exportHistory(path,rows);assert.ok(result.rows>=4);assert.equal(result.sha256.length,64);
    const original=readFileSync(path,'utf8');assert.ok(original.includes(f.sample.text));assert.ok(original.includes('reader@example.invalid'));
    assert.throws(()=>exportHistory(path,[]));assert.equal(readFileSync(path,'utf8'),original);
    assert.equal(s.store.operations.archiveRows(window.from,window.to,['other-target']).length,0);
    assert.ok(readdirSync(root).every(p=>!p.endsWith('.partial')));
  }finally{s.close();cleanupStorage(root);}
});
test('schema 6 upgrades losslessly with verified pre-schema-7 backup and new quota/health tables',()=>{
  const root=temporaryStorage(),path=join(root,'v6.sqlite');let store:SqliteStore|undefined;
  try{
    const raw=new DatabaseSync(path);try{migrate(raw,true,MIGRATIONS.slice(0,6));
      raw.prepare('INSERT INTO notifications(id,state,payload,revision) VALUES(?,?,?,?)').run(mail.id,'needs_attention',JSON.stringify(mail),8);
    }finally{raw.close();}
    store=new SqliteStore(path);assert.deepEqual(store.outbox()[0]!.notification,mail);assert.equal(store.deliveryRecord(mail.id)!.revision,8);
    assert.deepEqual(store.operations.usage(),[]);assert.deepEqual(store.operations.health(),[]);
    const name=readdirSync(root).find(n=>n.includes('.pre-v7.')&&n.endsWith('.sqlite'))!;
    const previous=new DatabaseSync(join(root,name),{readOnly:true});try{assert.equal(previous.prepare('PRAGMA user_version').get()!['user_version'],6);}finally{previous.close();}
  }finally{store?.close();cleanupStorage(root);}
});
test('local operations CLI has no credential requirement, redacts status, exports no secrets to stdout and guards cleanup terms',async()=>{
  const root=temporaryStorage(),path=join(root,'cli.sqlite'),s=await reportFixture(path);
  try{
    const env={...process.env,APP_MODE:'demo',STORAGE_KIND:'sqlite',DATABASE_PATH:path,NOTIFICATION_TO:'reader@example.invalid',
      SOURCE_PROVIDER:'',SOURCE_CREDENTIAL_ENV:'',ANALYSIS_PROVIDER:'',ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:''};
    const run=(...args:string[])=>spawnSync(process.execPath,['--experimental-sqlite','dist/src/cli.js',...args],{env,encoding:'utf8',timeout:10000,windowsHide:true});
    const status=run('ops:status');assert.equal(status.status,0,status.stderr);assert.ok(!status.stdout.includes(mail.recipient));assert.ok(!status.stdout.includes(f.sample.text));
    assert.equal(JSON.parse(status.stdout).notifications.provider_accepted,1);
    const usage=run('ops:usage');assert.equal(usage.status,0,usage.stderr);
    const jobs=run('ops:analysis');assert.equal(jobs.status,0,jobs.stderr);assert.equal(JSON.parse(jobs.stdout)[0].state,'completed');
    assert.ok(!jobs.stdout.includes(f.sample.text));
    const notes=run('ops:notifications');assert.equal(notes.status,0,notes.stderr);assert.ok(!notes.stdout.includes(mail.recipient));
    const backup=join(root,'cli-backup.sqlite'),saved=run('ops:backup',backup);assert.equal(saved.status,0,saved.stderr);
    const target=join(root,'copy.sqlite'),restored=run('ops:restore',backup,target,JSON.parse(saved.stdout).sha256);assert.equal(restored.status,0,restored.stderr);
    const preview=run('ops:cleanup');assert.equal(preview.status,0,preview.stderr);const plan=JSON.parse(preview.stdout);
    const denied=run('ops:cleanup','--apply',plan.at,plan.token,join(root,'denied.sqlite'));
    assert.notEqual(denied.status,0);assert.equal(existsSync(join(root,'denied.sqlite')),false);
    const command=run('ops:check-now');assert.equal(command.status,0,command.stderr);assert.equal(JSON.parse(command.stdout).state,'pending');
  }finally{s.close();cleanupStorage(root);}
});

test('budget day uses the configured calendar across DST repeated hours and measured successful model usage stays separate from output',async()=>{
  assert.equal(localDay(new Date('2026-11-01T05:45:00Z'),'America/New_York'),'2026-11-01');
  assert.equal(localDay(new Date('2026-11-01T06:15:00Z'),'America/New_York'),'2026-11-01');
  const s=setup();
  try{
    const analyzer=new StructuredAnalyzer({capability:'simulated',complete:async()=>({status:'complete',output:output(modelPost),usage:{inputTokens:50,outputTokens:20}})},
      hasher,{model:'synthetic',version:'fixture-v1',promptVersion:'v1',allowPartial:false});
    const result=await s.gate.reserve('analysis').run(()=>analyzer.analyze(modelPost),r=>r.usage);
    assert.equal(result.usage!.inputTokens,50);assert.equal(s.store.operations.usage()[0]!.measuredCalls,1);
  }finally{s.close();}
});

test('a recently reconciled old unknown mail is retained for the audit period after the resolution, including its report sources',async()=>{
  const s=await reportFixture();
  try{
    const base=s.store.outbox()[0]!.notification;
    s.store.enqueue({...base,id:'very-old-unknown'});const claim=s.store.claimDelivery('very-old-unknown',now)!;
    s.store.finishDelivery(claim.attemptId,{status:'unknown',reason:'Synthetic unresolved'},now);
    s.clock.advance(200*86400000);const record=s.store.deliveryRecord('very-old-unknown')!;
    s.store.resolveDelivery({notificationId:'very-old-unknown',attemptId:claim.attemptId,expectedRevision:record.revision,
      action:'confirm_sent',actor:'synthetic-operator',reason:'Explicitly verified the saved message',at:s.clock.now().toISOString()});
    const plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['notifications'],0);assert.equal(plan.counts['post_versions'],0);
    s.store.operations.cleanup(plan);assert.equal(s.store.deliveryRecord('very-old-unknown')!.entry.state,'provider_accepted');
  }finally{s.close();}
});
test('archived unreported content cannot be mistaken for an empty date even after a later broad source query covers that date',async()=>{
  const s=setup();await seeded(()=>s.store);
  try{
    await new ProcessAnalysis(new FixtureAnalyzer(new Map([[f.sample.id,answer]])),s.store,[],s.clock,s.config).execute(f.target);
    s.clock.advance(200*86400000);const plan=s.store.operations.cleanupPlan(s.clock.now().toISOString(),90,180);
    assert.equal(plan.counts['post_versions'],1);s.store.operations.cleanup(plan);
    await new IngestTarget(new FixtureSource([f.sample]),s.store,s.clock,s.config,hasher).execute(f.target,undefined,window.from);
    assert.equal(s.store.isCovered(f.target.id,window),true);assert.equal(s.store.versions(f.target.id).length,0);
    assert.throws(()=>s.store.reportInputs(f.target.id,window),/Source content archived/);
    assert.equal(s.store.reports(f.target.id).length,0);
  }finally{s.close();}
});

test('reviewed CLI cleanup creates a verified backup before deleting and explicit recovery quarantines dead-worker mail',async()=>{
  const root=temporaryStorage(),path=join(root,'reviewed.sqlite'),s=await reportFixture(path);
  try{
    const env={...process.env,APP_MODE:'demo',STORAGE_KIND:'sqlite',DATABASE_PATH:path,NOTIFICATION_TO:'reader@example.invalid',
      SOURCE_PROVIDER:'',SOURCE_CREDENTIAL_ENV:'',ANALYSIS_PROVIDER:'',ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:'',RETENTION_TERMS_REVIEWED:'true'};
    const run=(...args:string[])=>spawnSync(process.execPath,['--experimental-sqlite','dist/src/cli.js',...args],{env,encoding:'utf8',timeout:10000,windowsHide:true});
    const preview=run('ops:cleanup');assert.equal(preview.status,0,preview.stderr);const plan=JSON.parse(preview.stdout);
    const backup=join(root,'reviewed-backup.sqlite'),apply=run('ops:cleanup','--apply',plan.at,plan.token,backup);
    assert.equal(apply.status,0,apply.stderr);assert.ok(existsSync(backup));assert.equal(JSON.parse(apply.stdout).deleted.post_versions,1);
    assert.equal(s.store.versions(f.target.id).length,0);
    const original=new SqliteStore(backup);try{assert.equal(original.versions(f.target.id).length,1);}finally{original.close();}
    const dead=join(root,'dead.sqlite');
    const script=`import {SqliteStore} from './dist/src/adapters/storage/sqlite/store.js';
import {ManualClock} from './dist/src/adapters/clock.js';
const store=new SqliteStore(process.argv[1],{create:true,claims:{clock:new ManualClock(new Date('2026-01-02T00:00:00Z'))}});
store.runtime.acquire(1000);store.enqueue(${JSON.stringify(mail)});store.claimDelivery('synthetic-mail','2026-01-02T00:00:00Z');process.exit(0);`;
    const child=spawnSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',script,dead],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(child.status,0,child.stderr);
    const recovery=spawnSync(process.execPath,['--experimental-sqlite','dist/src/cli.js','ops:recover'],{env:{...env,DATABASE_PATH:dead},encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(recovery.status,0,recovery.stderr);
    const recovered=new SqliteStore(dead);try{assert.equal(recovered.runtime.current(),null);
      assert.equal(recovered.deliveryRecord(mail.id)!.entry.state,'needs_attention');assert.equal(recovered.deliveryAttempts().length,1);
    }finally{recovered.close();}
  }finally{s.close();cleanupStorage(root);}
});
test('manual budget resume rechecks the unchanged ledger and cannot grant another call',async()=>{
  const s=runtimeFixture({MAX_SOURCE_CALLS_PER_DAY:'1',POLL_INTERVAL_MINUTES:'1'}),{scheduler}=s.app();
  try{
    s.store.runtime.acquire(3600000);scheduler.initialize();scheduler.pulse(s.context);await scheduler.drain();
    s.clock.advance(60000);scheduler.pulse(s.context);await scheduler.drain();
    const task=s.store.schedules.tasks().find(t=>t.stage==='ingest')!;
    s.store.operations.requestControl({id:'resume-budget',kind:'resume',targetId:null,entityId:task.id,expectedRevision:task.revision,
      at:s.clock.now().toISOString(),reason:'Explicitly recheck configured budget'});
    scheduler.pulse(s.context);await scheduler.drain();
    assert.equal(s.store.operations.control('resume-budget')!.state,'applied');
    assert.equal(s.store.schedules.tasks().find(t=>t.id===task.id)!.failureCode,'budget_exhausted');
    assert.equal(s.store.operations.usage().find(r=>r.service==='source')!.calls,1);
  }finally{s.close();}
});

test('price basis and currency are frozen per reservation; changing currency cannot mix estimates in one budget day',async()=>{
  const s=setup({SOURCE_MAX_COST_PER_CALL:'0.01',BUDGET_CURRENCY:'USD',BUDGET_PRICE_REFERENCE:'Synthetic USD ceiling'});
  try{
    await s.gate.reserve('source').run(async()=>1);
    const record=s.store.operations.usageRecord('test-1:1')!;
    assert.equal(record.currency,'USD');assert.equal(record.priceReference,'Synthetic USD ceiling');assert.equal(record.configRevision,s.config.revision);
    const euro=loadConfig({SOURCE_MAX_COST_PER_CALL:'0.01',BUDGET_CURRENCY:'EUR',BUDGET_PRICE_REFERENCE:'Synthetic EUR ceiling'});
    const next=new BudgetController(s.store.operations,s.clock,euro,()=> 'euro');
    assert.throws(()=>next.reserve('source'),(e:unknown)=>e instanceof BudgetExceeded && e.reason==='currency_changed');
    const status=operationStatus(s.store,euro,s.clock.now()) as {budget:{currency:string;configuredCurrency:string}};
    assert.equal(status.budget.currency,'USD');assert.equal(status.budget.configuredCurrency,'EUR');
    s.clock.advance(86400000);await next.reserve('source').run(async()=>1);
    assert.equal(s.store.operations.usage('2026-01-03')[0]!.currency,'EUR');
  }finally{s.close();}
});
