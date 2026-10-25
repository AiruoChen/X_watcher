import{spawnSync}from'node:child_process';
import{readFileSync}from'node:fs';
import{randomUUID}from'node:crypto';
import{saveReport}from'./acceptance-lib.mjs';
const id=randomUUID(),label='io.x-watcher.acceptance',name='x-watcher-check-'+id,volume=name+'-data',image='x-watcher-check:'+id;
const output=process.argv[2]??'data/acceptance/container-'+id+'.json';

const run=(args,allow=false,timeout=120000)=>{
 const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024});
 if(r.status!==0&&!allow)throw Error('Docker step failed: '+args[0]+' '+String(r.stderr??'').slice(-1200));return r;
};
const cli=['node','--experimental-sqlite','dist/src/cli.js'];
const env=['-e','APP_MODE=demo','-e','STORAGE_KIND=sqlite','-e','DATABASE_PATH=/app/data/watcher.sqlite','-e','NOTIFICATION_TO=reader@example.invalid'];
const lock=['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'];
const mount=['--mount','type=volume,source='+volume+',target=/app/data'];
function owned(type,target){
 const field=type==='container'?'.Config.Labels':'.Labels';
 const r=run([type,'inspect',target,'--format','{{index '+field+' "'+label+'"}}'],true);
 return r.status===0&&r.stdout.trim()===id;
}
async function healthy(){
 const until=Date.now()+30000;
 while(Date.now()<until){const r=run(['exec',name,...cli,'deploy:health'],true);if(r.status===0)return JSON.parse(r.stdout);await new Promise(r=>setTimeout(r,500));}
 throw Error('Demo container did not become operational');
}
let createdVolume=false,createdContainer=false;
try{
 if(run(['info','--format','{{.OSType}}']).stdout.trim()!=='linux')throw Error('Linux Docker engine required');
 const commit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
 run(['build','--pull','--build-arg','BUILD_REVISION='+commit,'--label',label+'='+id,'-f','deploy/watcher/Dockerfile','-t',image,'.'],false,600000);
 run(['volume','create','--label',label+'='+id,volume]);createdVolume=true;
 run(['run','--rm','--label',label+'='+id,...lock,...mount,...env,image,'deploy:init']);
 run(['run','-d','--name',name,'--label',label+'='+id,...lock,...mount,...env,image]);createdContainer=true;
 const first=await healthy(),hostBuild=JSON.parse(readFileSync('dist/build-info.json','utf8'));
 if(first.build.sourceHash!==hostBuild.sourceHash||first.build.lockHash!==hostBuild.lockHash||first.build.commit!==hostBuild.commit)throw Error('Image build metadata does not match the checkout');
 const sandbox=JSON.parse(run(['inspect',name,'--format','{{json .HostConfig}}']).stdout);
 if(sandbox.NetworkMode!=='none'||sandbox.ReadonlyRootfs!==true)throw Error('Container isolation was not applied');
 const uid=run(['exec',name,'node','-e','console.log(process.getuid())']).stdout.trim();if(uid==='0')throw Error('Container must not run as root');
 const before=JSON.parse(run(['exec',name,...cli,'ops:status']).stdout);
 run(['kill','--signal','KILL',name]);run(['start',name]);await healthy();
 const after=JSON.parse(run(['exec',name,...cli,'ops:status']).stdout);
 if(before.targets[0].checkpointRevision>after.targets[0].checkpointRevision)throw Error('Checkpoint went backwards');
 if(after.notifications.needs_attention || after.notifications.sending)throw Error('Empty demo unexpectedly created mail');
 run(['stop','--time','30',name]);
 const stopped=run(['inspect',name,'--format','{{.State.ExitCode}}']).stdout.trim();if(stopped!=='0')throw Error('Graceful stop failed');
 run(['start',name]);const final=await healthy();run(['stop','--time','30',name]);
 const imageId=run(['image','inspect',image,'--format','{{.Id}}']).stdout.trim();
 const report={formatVersion:1,kind:'container_acceptance',status:'passed',at:new Date().toISOString(),platform:'linux_containers',
  build:hostBuild,imageBuild:first.build,imageId,uid:Number(uid),network:sandbox.NetworkMode,readOnlyRoot:sandbox.ReadonlyRootfs,
  hardRestartRecovered:true,gracefulStop:true,persistentCheckpoint:true,coverage:first.coverage,finalState:final.state,productionReady:false};
 const sha256=saveReport(output,report);console.log(JSON.stringify({status:'passed',output,sha256,imageId}));
}finally{
 if(createdContainer&&owned('container',name))run(['rm','--force',name],true);
 if(createdVolume&&owned('volume',volume))run(['volume','rm',volume],true);
 // Image cache is retained for explicit inspection; no user images or volumes are pruned.
}
