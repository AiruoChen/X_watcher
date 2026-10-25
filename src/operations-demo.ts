import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { restoreBackup } from './adapters/storage/sqlite/backup.js';
import { temporaryStorage, cleanupStorage } from './adapters/storage/temporary-directory.js';
import { ManualClock } from './adapters/clock.js';
import { Sha256Hasher } from './adapters/hash.js';
import { FixtureSource } from './adapters/source/fixture-source.js';
import { FixtureAnalyzer } from './adapters/analysis/fixture-analyzer.js';
import { PreviewChannel } from './adapters/notification/preview-channel.js';
import { BudgetController } from './application/budget.js';
import { IngestTarget } from './application/ingest-target.js';
import { ProcessAnalysis } from './application/process-analysis.js';
import { DeliverNotifications } from './application/deliver-notifications.js';
import { BuildReport } from './application/build-report.js';
import { ReportTextRenderer } from './application/report-renderer.js';
import { BudgetExceeded } from './domain/errors.js';
import { digestWindowForDay } from './domain/time.js';
import { loadConfig } from './config.js';

const config=loadConfig({STORAGE_KIND:'sqlite',MAX_SOURCE_CALLS_PER_DAY:'1'}),target=config.targets[0]!;
const clock=new ManualClock(new Date('2026-01-02T00:00:00Z')),hash=new Sha256Hasher(),root=temporaryStorage();
const store=new SqliteStore(join(root,'demo.sqlite'),{create:true,claims:{clock}});
let restored:SqliteStore|undefined;
try{
  const gate=new BudgetController(store.operations,clock,config,randomUUID);
  const post={id:'synthetic-ops',targetId:target.id,text:'Synthetic operations demonstration.',
    publishedAt:'2026-01-01T12:00:00Z',url:'https://example.invalid/synthetic-ops'};
  const ingest=()=>new IngestTarget(new FixtureSource([post]),store,clock,config,hash,gate).execute(target);
  await ingest();
  await new ProcessAnalysis(new FixtureAnalyzer(new Map([[post.id,{summary:'Synthetic summary',chatgptUpdates:[],reset:null}]])),
    store,[],clock,config,gate).execute(target);
  new BuildReport(store,hash,new ReportTextRenderer(),config).execute(target,digestWindowForDay('2026-01-01',config.timeZone),clock.now().toISOString());
  await new DeliverNotifications(store,new PreviewChannel(),clock,gate).execute();
  clock.advance(60000);await assert.rejects(ingest(),BudgetExceeded);await assert.rejects(ingest(),BudgetExceeded);
  assert.equal(store.operations.incidents().length,1);
  clock.advance(86400000);await ingest();assert.equal(store.operations.incidents()[0]!.state,'resolved');
  const backup=join(root,'backup.sqlite'),destination=join(root,'restored.sqlite');
  const manifest=store.backup(backup);restoreBackup(backup,destination,manifest.sha256);
  restored=new SqliteStore(destination,{claims:{clock}});
  assert.equal(restored.reports(target.id).length,1);assert.equal(restored.hasPostVersion(store.versions(target.id)[0]!.key),true);
  clock.advance(200*86400000);const plan=restored.operations.cleanupPlan(clock.now().toISOString(),90,180);
  restored.backup(join(root,'before-cleanup.sqlite'));
  restored.operations.cleanup(plan);assert.equal(restored.hasPost(target.id,post.id),true);
  console.log('Offline operations demo: durable budget pause → next-day recovery → verified backup/restore → protected retention and dedup keys.');
  console.log('All sources/models/delivery were synthetic; no real service, email, user database or configuration was changed.');
}finally{restored?.close();store.close();cleanupStorage(root);}
