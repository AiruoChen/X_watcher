import assert from 'node:assert/strict';
import {SqliteStore} from './adapters/storage/sqlite/store.js';
import {ManualClock} from './adapters/clock.js';
import {Sha256Hasher} from './adapters/hash.js';
import {FixtureSource} from './adapters/source/fixture-source.js';
import {FixtureAnalyzer} from './adapters/analysis/fixture-analyzer.js';
import {PreviewChannel} from './adapters/notification/preview-channel.js';
import {IngestTarget} from './application/ingest-target.js';
import {ProcessAnalysis} from './application/process-analysis.js';
import {DeliverNotifications} from './application/deliver-notifications.js';
import {BuildReport} from './application/build-report.js';
import {ReportTextRenderer} from './application/report-renderer.js';
import {ResetRule} from './application/rules/reset-rule.js';
import {loadConfig} from './config.js';
import {digestWindowForDay} from './domain/time.js';
const config=loadConfig({}),target=config.targets[0]!,hash=new Sha256Hasher(),latencies:number[]=[];
for(let i=0;i<20;i++){
 const clock=new ManualClock(new Date('2026-01-02T00:00:00Z')),store=new SqliteStore(':memory:',{claims:{clock}});
 try{
  store.registerTarget({...target,authorId:'fixture:'+target.handle,enabled:true,monitorStartedAt:'2026-01-01T00:00:00Z',configRevision:config.revision});
  const post={id:'timing-'+i,targetId:target.id,text:'Limits reset tomorrow.',publishedAt:'2026-01-01T23:59:00Z',url:'https://example.invalid/timing'};
  await new IngestTarget(new FixtureSource([post]),store,clock,config,hash).execute(target);
  clock.advance(60000);
  await new ProcessAnalysis(new FixtureAnalyzer(new Map([[post.id,{summary:'Synthetic reset',chatgptUpdates:[],reset:{evidence:post.text,whenText:'tomorrow',timeZoneText:null}}]])),
   store,[new ResetRule()],clock,config).execute(target);
  await new DeliverNotifications(store,new PreviewChannel(),clock).execute();
  const attempt=store.deliveryAttempts()[0]!;assert.ok(attempt);
  latencies.push(Date.parse(attempt.finishedAt!)-Date.parse(store.versions(target.id)[0]!.discoveredAt));
 }finally{store.close();}
}
const clock=new ManualClock(new Date('2026-01-02T00:00:00Z')),store=new SqliteStore(':memory:',{claims:{clock}});
try{
 const post={id:'daily-timing',targetId:target.id,text:'Synthetic update.',publishedAt:'2026-01-01T12:00:00Z',url:'https://example.invalid/daily'};
 await new IngestTarget(new FixtureSource([post]),store,clock,config,hash).execute(target);
 await new ProcessAnalysis(new FixtureAnalyzer(new Map([[post.id,{summary:'Synthetic',chatgptUpdates:[],reset:null}]])),store,[],clock,config).execute(target);
 new BuildReport(store,hash,new ReportTextRenderer(),config).execute(target,digestWindowForDay('2026-01-01',config.timeZone),clock.now().toISOString());
 const dailyOffsetMs=Date.parse(store.outbox()[0]!.notification.createdAt)-Date.parse('2026-01-02T00:00:00Z');
 const resetP95Ms=latencies.sort((a,b)=>a-b)[Math.ceil(latencies.length*0.95)-1]!;
 assert.ok(resetP95Ms<=120000 && dailyOffsetMs>=0 && dailyOffsetMs<=300000);
 console.log(JSON.stringify({status:'passed',kind:'synthetic_timing',samples:latencies.length,resetP95Ms,dailyOffsetMs,realTimingMeasured:false}));
}finally{store.close();}
