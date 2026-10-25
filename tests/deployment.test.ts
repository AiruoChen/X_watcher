import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../src/adapters/storage/sqlite/store.js';
import {migrate,MIGRATIONS} from '../src/adapters/storage/sqlite/migrations.js';
import {fileHash} from '../src/adapters/storage/sqlite/backup.js';
import {ManualClock} from '../src/adapters/clock.js';
import {deploymentSession} from '../src/adapters/deployment/session.js';
import {readEvidence} from '../src/adapters/deployment/evidence.js';
import {inspectDeployment} from '../src/adapters/deployment/inspection.js';
import {processIdentity} from '../src/adapters/storage/sqlite/process-identity.js';
import {assessRelease} from '../src/domain/policies/deployment.js';
import {BackupSchedule} from '../src/runtime/backup-schedule.js';
import {deployment} from '../src/deployment.js';
import {buildInfo} from '../src/build-info.js';
import {loadConfig} from '../src/config.js';
import {loadLocalConfig} from '../src/config/load.js';
import {temporaryStorage,cleanupStorage} from './helpers/storage.js';
import {deferred,flush,StepWaiter} from './helpers/runtime.js';
import type {BuildInfo} from '../src/domain/model.js';
const stamp=buildInfo(),start='2026-01-01T00:00:00.000Z';
function setup(preview=false,rss=false){
 const root=temporaryStorage(),path=join(root,'deploy.sqlite'),clock=new ManualClock(new Date(start));
 const env:NodeJS.ProcessEnv=preview?{APP_MODE:'preview',SOURCE_PROVIDER:rss?'rsshub':'x-api-v2',SOURCE_CREDENTIAL_ENV:rss?'':'SYNTHETIC_TOKEN',
  ANALYSIS_PROVIDER:'deferred',ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:'',STORAGE_KIND:'sqlite',DATABASE_PATH:path}:
 {APP_MODE:'demo',STORAGE_KIND:'sqlite',DATABASE_PATH:path};
 const config=loadLocalConfig(env),target=config.targets[0]!,build:BuildInfo={...stamp,dirty:false};
 const store=new SqliteStore(path,{create:true,claims:{clock}});
 store.registerTarget({...target,authorId:rss?'rsshub-handle:'+target.handle:'100',enabled:true,monitorStartedAt:start,configRevision:config.revision});
 const session=deploymentSession(config,build,clock.now()),lease=store.runtime.acquire(86400000)!;
 store.schedules.ensure({id:'ingest',stage:'ingest',targetId:target.id,configRevision:config.revision,revision:0,state:'idle',dueAt:start,
  failures:0,startedAt:null,finishedAt:null});
 const observation=()=>{
  const cp=store.checkpoint(target.id),now=clock.now().toISOString();
  const from=cp.observedAt??new Date(clock.now().getTime()-1000).toISOString();
  store.commitIngestion({targetId:target.id,expectedRevision:cp.revision,cursor:null,observedAt:now,posts:[],jobs:[],
   coverage:{id:'coverage-'+cp.revision,targetId:target.id,from,to:now,status:rss?'gap':'complete',reason:rss?'rsshub_snapshot_unverified':null,
    scope:rss?'rsshub_timeline_snapshot':'x_recent_public_index',observation:{startedAt:now,completedAt:now}},observation:{startedAt:now,completedAt:now}});
 };
 return{root,path,clock,env,config,target,build,store,session,lease,observation,
  close:()=>{store.close();cleanupStorage(root);}};
}
test('build metadata records reproducible hashes, version and schema without credentials or private paths',()=>{
 assert.equal(stamp.formatVersion,1);assert.match(stamp.sourceHash,/^[a-f0-9]{64}$/);assert.match(stamp.lockHash,/^[a-f0-9]{64}$/);
 assert.equal(stamp.schemaVersion,MIGRATIONS.length);assert.ok(!JSON.stringify(stamp).includes('reader@'));
});
test('deployment health cannot create missing data and refuses corrupt files without replacing bytes',()=>{
 const root=temporaryStorage(),path=join(root,'missing.sqlite'),config=loadConfig({STORAGE_KIND:'sqlite',DATABASE_PATH:path});
 try{
  assert.equal(inspectDeployment(config,stamp).state,'invalid_database');assert.equal(readdirSync(root).length,0);
  writeFileSync(path,'synthetic corrupt database');const before=fileHash(path);
  assert.equal(inspectDeployment(config,stamp).code,'database_unavailable_or_invalid');assert.equal(fileHash(path),before);
 }finally{cleanupStorage(root);}
});
test('read-only health distinguishes a running demo from production readiness and does not mutate database records',()=>{
 const s=setup();
 try{s.observation();const before=s.store.checkpoint(s.target.id),health=inspectDeployment(s.config,s.build,s.clock.now());
  assert.equal(health.operational,true);assert.equal(health.coverage,'simulated');
  assert.equal(assessRelease(health).productionReady,false);
  assert.deepEqual(s.store.checkpoint(s.target.id),before);
  assert.ok(assessRelease(health).gates.some(g=>g.id==='real_source'&&g.state==='blocked'));
 }finally{s.close();}
});
test('health requires current build/config/session and refuses future observations after a clock rollback',()=>{
 const s=setup();
 try{s.observation();
  const changed={...s.config,revision:'changed-config'};assert.equal(inspectDeployment(changed,s.build,s.clock.now()).code,'build_or_config_changed');
  assert.equal(inspectDeployment(s.config,{...s.build,sourceHash:'0'.repeat(64)},s.clock.now()).operational,false);
  s.clock.jumpWallClock(-60000);assert.equal(inspectDeployment(s.config,s.build,s.clock.now()).code,'clock_changed');
 }finally{s.close();}
});
test('budget-paused ingestion and missing observations are not reported healthy',()=>{
 const s=setup();
 try{assert.equal(inspectDeployment(s.config,s.build,s.clock.now()).state,'starting');s.observation();
  const task=s.store.schedules.tasks()[0]!,claimed=s.store.schedules.claim(task.id,task.revision,start)!;
  s.store.schedules.finish(claimed.id,claimed.revision,'2026-01-02T00:00:00Z',false,false,start,{code:'budget_exhausted',retryAt:'2026-01-02T00:00:00Z'});
  assert.equal(inspectDeployment(s.config,s.build,s.clock.now()).code,'source_paused');
 }finally{s.close();}
});
test('48-hour preview evidence is build/config-bound and cannot bypass deferred real providers or unknown RSS coverage',()=>{
 for(const rss of [false,true]){
  const s=setup(true,rss);
  try{
   s.observation();
   for(let i=0;i<96;i++){s.clock.advance(30*60000);s.store.runtime.renew(s.store.runtime.current()!.revision,86400000);s.observation();}
   const health=inspectDeployment(s.config,s.build,s.clock.now());assert.equal(health.preview.mature,true);
   assert.equal(health.preview.sessionHours,48);assert.equal(health.preview.observations,97);
   const release=assessRelease(health);assert.equal(release.productionReady,false);
   assert.equal(release.gates.find(g=>g.id==='preview_48h')!.state,'passed');
   assert.equal(release.gates.find(g=>g.id==='live_adapter')!.state,'blocked');
   if(rss)assert.equal(release.gates.find(g=>g.id==='source_coverage')!.state,'blocked');
   for(let i=0;i<4;i++){s.clock.advance(30*60000);s.store.runtime.renew(s.store.runtime.current()!.revision,86400000);s.observation();}
   const recent=inspectDeployment(s.config,s.build,s.clock.now());assert.equal(recent.preview.mature,true);assert.equal(recent.preview.sessionHours,50);assert.equal(recent.preview.observations,97);
   assert.equal(inspectDeployment(s.config,{...s.build,dirty:true},s.clock.now()).preview.mature,false);
  }finally{s.close();}
 }
});
test('a long offline gap cannot be passed off as 48 hours of continuous preview',()=>{
 const s=setup(true);
 try{s.observation();s.clock.advance(48*3600000);s.store.runtime.renew(s.store.runtime.current()!.revision,86400000);s.observation();
  const health=inspectDeployment(s.config,s.build,s.clock.now());assert.equal(health.preview.mature,false);assert.ok(health.preview.maxGapMs!>s.config.pollIntervalMs);
 }finally{s.close();}
});
test('session receipts contain only provenance and end when the wrapper stops',()=>{
 const s=setup();
 try{
  const file=join(s.root,'deployment-sessions',readdirSync(join(s.root,'deployment-sessions'))[0]!);
  s.observation();writeFileSync(join(s.root,'deployment-sessions','00000000-0000-0000-0000-000000000000.json'),'broken');
  assert.equal(inspectDeployment(s.config,s.build,s.clock.now()).operational,true);
  const text=readFileSync(file,'utf8');assert.ok(!text.includes(s.config.recipient));assert.ok(!text.includes('SYNTHETIC_TOKEN'));
  s.session.finish(true);assert.equal(JSON.parse(readFileSync(file,'utf8')).outcome,'stopped');
  assert.equal(inspectDeployment(s.config,s.build,s.clock.now()).operational,false);
 }finally{s.close();}
});
test('old-schema deployment initialization requires a stopped host and preserves backup/migration history',async()=>{
 const root=temporaryStorage(),path=join(root,'v6.sqlite');
 try{
  const raw=new DatabaseSync(path);migrate(raw,true,MIGRATIONS.slice(0,6));
  raw.prepare("UPDATE runtime_ownership SET payload=? WHERE singleton=1").run(JSON.stringify({pid:1,hostId:'synthetic',ownerId:'old',revision:1,acquiredAt:start,leaseUntil:'2030-01-01T00:00:00Z'}));raw.close();
  const env={APP_MODE:'demo',STORAGE_KIND:'sqlite',DATABASE_PATH:path},config=loadConfig(env);
  assert.equal(inspectDeployment(config,stamp).code,'active_host_schema_upgrade');
  await assert.rejects(deployment('deploy:init',[],env));
  const clear=new DatabaseSync(path);clear.exec('UPDATE runtime_ownership SET payload=NULL');clear.close();
  await deployment('deploy:init',[],env);
  assert.ok(readdirSync(root).some(n=>n.includes('.pre-v7.')));const current=new SqliteStore(path);current.close();
 }finally{cleanupStorage(root);}
});
test('Linux process identities distinguish reused PIDs while unavailable metadata remains unknown',()=>{
 if(process.platform==='linux'){assert.match(processIdentity(process.pid)!,/^[a-f0-9-]{36}:\d+$/);}else assert.equal(processIdentity(process.pid),null);
 assert.equal(processIdentity(-1),null);
});
test('proven PID reuse replaces a dead container process promptly but never automatically resends an interrupted mail',()=>{
 const root=temporaryStorage(),path=join(root,'identity.sqlite'),clock=new ManualClock(new Date(start));
 const first=new SqliteStore(path,{create:true,claims:{clock,hostId:'same-host',pid:1,isProcessAlive:()=>true,identifyProcess:()=> 'boot:start-a'}});
 let next:SqliteStore|undefined;
 try{
  first.runtime.acquire(60000);first.enqueue({id:'unknown',kind:'reset',targetId:'fixture',recipient:'reader@example.invalid',subject:'Synthetic',text:'Synthetic',createdAt:start});
  first.claimDelivery('unknown',start);
  next=new SqliteStore(path,{claims:{clock,hostId:'same-host',pid:1,isProcessAlive:()=>true,identifyProcess:()=> 'boot:start-b'}});
  const lease=next.runtime.acquire(60000);assert.ok(lease);next.recoverAbandonedWork(lease.revision);
  assert.equal(next.deliveryRecord('unknown')!.entry.state,'needs_attention');assert.equal(next.claimDelivery('unknown',start),null);
  assert.equal(next.deliveryAttempts().length,1);next.runtime.release(lease.revision);
 }finally{next?.close();first.close();cleanupStorage(root);}
});
test('missing process-start proof or another host cannot reclaim an active lease merely because its PID is reused',()=>{
 const root=temporaryStorage(),path=join(root,'unknown.sqlite'),clock=new ManualClock(new Date(start));
 const first=new SqliteStore(path,{create:true,claims:{clock,hostId:'host-a',pid:1,isProcessAlive:()=>true,identifyProcess:()=> 'boot:old'}});
 let other:SqliteStore|undefined,next:SqliteStore|undefined;
 try{first.runtime.acquire(60000);
  other=new SqliteStore(path,{claims:{clock,hostId:'host-a',pid:1,isProcessAlive:()=>null,identifyProcess:()=>null}});assert.equal(other.runtime.acquire(60000),null);
  next=new SqliteStore(path,{claims:{clock,hostId:'host-b',pid:1,isProcessAlive:()=>false,identifyProcess:()=> 'boot:new'}});assert.equal(next.runtime.acquire(60000),null);
 }finally{other?.close();next?.close();first.close();cleanupStorage(root);}
});
test('backup schedule waits for a claimed snapshot to finish before stopping',async()=>{
 const clock=new ManualClock(new Date(start)),waiter=new StepWaiter(clock),held=deferred<{schemaVersion:number;sha256:string;bytes:number}>(),stop=new AbortController();
 let finished=false;const events:string[]=[];
 const run=new BackupSchedule({create:()=>held.promise},clock,waiter,1000,{record:e=>events.push(e.type)}).run(stop.signal).then(()=>{finished=true;});
 stop.abort();await flush();assert.equal(finished,false);held.resolve({schemaVersion:7,sha256:'a'.repeat(64),bytes:1});await run;
 assert.deepEqual(events,['backup.created']);
});
test('backup failure noise is deduplicated, recovery is recorded and wall-clock jumps do not accelerate cadence',async()=>{
 const clock=new ManualClock(new Date(start)),waiter=new StepWaiter(clock),stop=new AbortController(),events:string[]=[];let calls=0;
 const run=new BackupSchedule({create:async()=>{calls++;if(calls<3)throw new Error('private@example.invalid');return{schemaVersion:7,sha256:'a'.repeat(64),bytes:1};}},
  clock,waiter,1000,{record:e=>events.push(e.type)}).run(stop.signal);
 await flush();clock.jumpWallClock(3*86400000);await waiter.step(500);assert.equal(calls,1);
 await waiter.step(500);await waiter.step(1000);stop.abort();await run;
 assert.deepEqual(events,['backup.failed','backup.recovered','backup.created']);
});
test('acceptance manifest rejects missing, failing, skipped or incomplete scenarios and strips inherited credentials',()=>{
 const code=`import{evaluateScenarios,testEnvironment}from'./scripts/acceptance-lib.mjs';
const manifest=Array.from({length:20},(_,i)=>({id:'AC-'+String(i+1).padStart(2,'0'),required:['sample']}));
const good=evaluateScenarios(manifest,[{name:'sample',state:'passed',skip:false,todo:false}]);
const missing=evaluateScenarios(manifest,[]),skip=evaluateScenarios(manifest,[{name:'sample',state:'passed',skip:true}]);
console.log(JSON.stringify({good:good.every(s=>s.status==='offline_passed'),missing:missing[0].status,skip:skip[0].status,
env:testEnvironment({PATH:'synthetic',SECRET_KEY:'do-not-inherit',NOTIFICATION_TO:'private@example.invalid'})}));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
 const value=JSON.parse(r.stdout);assert.equal(value.good,true);assert.equal(value.missing,'failed');assert.equal(value.skip,'failed');
 assert.equal(value.env.SECRET_KEY,undefined);assert.equal(value.env.NOTIFICATION_TO,'reader@example.invalid');
});
test('deploy CLI initializes explicitly, health is read-only, and live cannot be enabled by a release report',()=>{
 const root=temporaryStorage(),path=join(root,'cli.sqlite');
 const env={...process.env,APP_MODE:'demo',STORAGE_KIND:'sqlite',DATABASE_PATH:path,SOURCE_PROVIDER:'',SOURCE_CREDENTIAL_ENV:'',ANALYSIS_PROVIDER:'',ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:''};
 const run=(command:string,patch:NodeJS.ProcessEnv={})=>spawnSync(process.execPath,['--experimental-sqlite','dist/src/cli.js',command],{env:{...env,...patch},encoding:'utf8',windowsHide:true,timeout:10000});
 try{
  assert.notEqual(run('deploy:health').status,0);assert.equal(readdirSync(root).length,0);
  const init=run('deploy:init');assert.equal(init.status,0,init.stderr);const before=fileHash(path);
  const gate=run('release:check');assert.equal(gate.status,2);assert.equal(JSON.parse(gate.stdout).productionReady,false);assert.equal(fileHash(path),before);
  assert.notEqual(run('deploy:run',{APP_MODE:'live'}).status,0);
  assert.notEqual(run('deploy:init',{DATABASE_PATH:':memory:'}).status,0);
  assert.notEqual(run('deploy:init',{DEPLOYMENT_DATA_ROOT:join(root,'durable')}).status,0);
 }finally{cleanupStorage(root);}
});
test('deployment foreground process stops gracefully through the original runtime without real service calls',async()=>{
 const root=temporaryStorage(),path=join(root,'foreground.sqlite'),store=new SqliteStore(path,{create:true});store.close();
 const script=`process.argv=[process.execPath,'cli','deploy:run'];process.on('message',()=>process.emit('SIGINT'));await import('./dist/src/cli.js');process.disconnect();`;
 const child=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
  env:{...process.env,APP_MODE:'demo',STORAGE_KIND:'sqlite',DATABASE_PATH:path,SOURCE_PROVIDER:'',SOURCE_CREDENTIAL_ENV:'',ANALYSIS_PROVIDER:'',ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:''}});
 let output='',error='',stopped=false;
 try{
  await new Promise<void>((resolve,reject)=>{child.stdout!.on('data',chunk=>{output+=String(chunk);if(!stopped&&output.includes('Simulated foreground runtime')){stopped=true;child.send('stop');}});
   child.stderr!.on('data',chunk=>{error+=String(chunk);});child.on('error',reject);child.on('exit',code=>{try{assert.equal(code,0,error);resolve();}catch(e){reject(e);}});});
  assert.ok(output.includes('Runtime stopped: stopped'));
  const after=new SqliteStore(path);try{assert.equal(after.runtime.current(),null);}finally{after.close();}
  const receipt=JSON.parse(readFileSync(join(root,'deployment-sessions',readdirSync(join(root,'deployment-sessions'))[0]!),'utf8'));assert.equal(receipt.outcome,'stopped');
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();cleanupStorage(root);}
});

test('release evidence must match the exact build, commit and complete AC mapping; supplied productionReady cannot enable live',()=>{
 const root=temporaryStorage(),path=join(root,'evidence.json'),build={...stamp,dirty:false};
 const valid={formatVersion:1,kind:'offline_acceptance',status:'passed',productionReady:false,at:start,build,testSuiteHash:'a'.repeat(64),
  tests:{passed:300,failed:0},scenarios:Array.from({length:20},(_,i)=>({id:'AC-'+String(i+1).padStart(2,'0'),status:'offline_passed',checks:[{matched:1,passed:true}]})),
  capacity:{targets:10,postVersions:100000,returnedPosts:24,plan:['posts_target_time']},
  timing:{status:'passed',kind:'synthetic_timing',realTimingMeasured:false,samples:20,resetP95Ms:60000,dailyOffsetMs:0}};
 try{
  writeFileSync(path,JSON.stringify(valid));assert.equal(readEvidence(path,build).accepted,true);assert.equal(readEvidence(path,build).capacity,true);
  writeFileSync(path,JSON.stringify({...valid,build:{...build,sourceHash:'0'.repeat(64)}}));assert.equal(readEvidence(path,build).accepted,false);
  writeFileSync(path,JSON.stringify({...valid,productionReady:true}));assert.equal(readEvidence(path,build).accepted,false);
  writeFileSync(path,JSON.stringify({...valid,scenarios:valid.scenarios.slice(1)}));assert.equal(readEvidence(path,build).accepted,false);
  writeFileSync(path,JSON.stringify({...valid,scenarios:valid.scenarios.map(s=>({...s,checks:[]}))}));assert.equal(readEvidence(path,build).accepted,false);
 }finally{cleanupStorage(root);}
});
test('deployment preflight checks available credentials without contacting external services or creating missing databases',async()=>{
 const root=temporaryStorage(),path=join(root,'missing.sqlite'),env={APP_MODE:'preview',STORAGE_KIND:'sqlite',DATABASE_PATH:path,
  SOURCE_PROVIDER:'x-api-v2',SOURCE_CREDENTIAL_ENV:'MISSING_SYNTHETIC_TOKEN',ANALYSIS_PROVIDER:'deferred',ANALYSIS_CREDENTIAL_ENV:'',ANALYSIS_MODEL:''};
 try{assert.equal(await deployment('deploy:preflight',[],env),1);assert.equal(readdirSync(root).length,0);}finally{cleanupStorage(root);}
});
