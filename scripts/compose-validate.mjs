import{copyFileSync,mkdirSync}from'node:fs';
import{join}from'node:path';
import{spawnSync}from'node:child_process';
import{temporaryStorage,cleanupStorage}from'../dist/src/adapters/storage/temporary-directory.js';
import{testEnvironment}from'./acceptance-lib.mjs';
const root=temporaryStorage();
try{
 for(const folder of ['rsshub','watcher'])mkdirSync(join(root,'deploy',folder),{recursive:true});
 copyFileSync('deploy/rsshub/compose.yaml',join(root,'deploy/rsshub/compose.yaml'));
 copyFileSync('deploy/watcher/compose.yaml',join(root,'deploy/watcher/compose.yaml'));
 copyFileSync('deploy/watcher/watcher.env.example',join(root,'deploy/watcher/watcher.env'));
 const r=spawnSync('docker',['compose','-f','deploy/rsshub/compose.yaml','-f','deploy/watcher/compose.yaml','config','--quiet'],
  {cwd:root,env:{...testEnvironment(process.env),TWITTER_AUTH_TOKEN:'synthetic-unused',BUILD_REVISION:'a'.repeat(40)},encoding:'utf8',windowsHide:true,timeout:30000});
 if(r.status!==0)throw Error('Compose validation failed: '+String(r.stderr??'').slice(-1500));
 console.log(JSON.stringify({status:'passed',kind:'compose_validation',actualServicesStarted:false}));
}finally{cleanupStorage(root);}
