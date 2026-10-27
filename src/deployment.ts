import {resolve,sep} from 'node:path';
import {existsSync} from 'node:fs';
import {SqliteStore} from './adapters/storage/sqlite/store.js';
import {readEvidence} from './adapters/deployment/evidence.js';
import {inspectDeployment} from './adapters/deployment/inspection.js';
import {deploymentSession} from './adapters/deployment/session.js';
import {assessRelease} from './domain/policies/deployment.js';
import {loadConfig,loadLocalConfig} from './config/load.js';
import {buildInfo} from './build-info.js';
import {watch} from './watch.js';
import {createReadonlySource} from './bootstrap-source.js';
import {SystemClock} from './adapters/clock.js';
import type {RuntimeConfig} from './domain/model.js';
import {previewSource} from './source-preview.js';
function persistentData(config:RuntimeConfig,env:NodeJS.ProcessEnv):void {
  if(config.storage.kind!=='sqlite'||config.storage.path===':memory:')throw new Error('Deployment requires a persistent SQLite file.');
  if(env.DEPLOYMENT_DATA_ROOT){const root=resolve(env.DEPLOYMENT_DATA_ROOT),path=resolve(config.storage.path);
    if(!path.startsWith(root+sep))throw new Error('Deployment database must remain inside the configured persistent data root.');}
}
function validateDeployment(config:RuntimeConfig,env:NodeJS.ProcessEnv):void {
  persistentData(config,env);
  if(config.mode==='live')throw new Error('Live deployment is unavailable.');
  if(config.storage.kind!=='sqlite')throw new Error('Deployment requires SQLite.');
  if(config.mode==='demo' && config.targets.some(t=>t.provider!=='x'))throw new Error('Demo deployment requires simulated X targets.');
  if(config.mode==='preview')createReadonlySource(config,env,new SystemClock());
}
export async function deployment(command:string,args:readonly string[],env:NodeJS.ProcessEnv):Promise<number>{
  if(args.length && !(command==='release:check' && args.length===1))throw new Error('Use deploy:* without arguments, or release:check [offline-evidence.json]; see docs/DEPLOYMENT.md.');
  if(command==='deploy:backups'){const {backupWorker}=await import('./backup-worker.js');return backupWorker(env);}
  const build=buildInfo();
  if(command==='deploy:run'){
    if(!['demo','preview'].includes(env.APP_MODE??''))throw new Error('Deploy requires explicit APP_MODE=demo or preview; live is unavailable.');
    const config=loadConfig(env);validateDeployment(config,env);
    if(!existsSync(config.storage.path))throw new Error('Initialize an explicit new database with deploy:init before deploy:run.');
    const session=deploymentSession(config,build);let result=1;
    try{result=config.mode==='demo'?await watch(config,false):await previewSource(config,env,false,false);return result;}
    finally{session.finish(result===0);}
  }
  const config=loadLocalConfig(env);persistentData(config,env);
  const health=inspectDeployment(config,build,new Date(),command!=='deploy:health');
  if(command==='deploy:init'){
    if(config.mode==='live')throw new Error('Live deployment is unavailable.');
    if(existsSync(config.storage.path) && !['stopped','degraded'].includes(health.state))throw new Error('Stop the host and inspect the existing database before initialization.');
    if(existsSync(config.storage.path) && health.code!=='no_running_host' && health.code!=='schema_upgrade_required')throw new Error('Explicit recovery is required before initialization.');
    const store=new SqliteStore(config.storage.path,{create:true});store.close();
    console.log(JSON.stringify({status:'initialized',version:build.version,schemaVersion:build.schemaVersion}));return 0;
  }
  if(command==='deploy:health'){console.log(JSON.stringify(health));return health.operational?0:1;}
  if(command==='deploy:preflight'){
    let configured=true;try{validateDeployment(loadConfig(env),env);}catch{configured=false;}
    console.log(JSON.stringify({build,mode:config.mode,storage:config.storage.kind,database:health.state,
      deployable:configured && ['stopped','healthy'].includes(health.state),productionReady:false}));
    return configured && ['stopped','healthy'].includes(health.state)?0:1;
  }
  if(command==='release:check'){console.log(JSON.stringify({at:new Date().toISOString(),build,health,evidence:args[0]?readEvidence(args[0],build):null,...assessRelease(health,args[0]?readEvidence(args[0],build):undefined)}));return 2;}
  throw new Error('Unknown deployment command.');
}
