import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {processIdentity} from '../storage/sqlite/process-identity.js';
import type { BuildInfo,DeploymentSession,RuntimeConfig } from '../../domain/model.js';
/** One receipt per process start; a losing host cannot overwrite the active host's receipt. */
export function deploymentSession(config:RuntimeConfig,build:BuildInfo,now=new Date()):{finish:(success:boolean)=>void} {
  if(config.mode==='live')throw new Error('Live deployment is not implemented.');
  const directory=join(dirname(config.storage.path),'deployment-sessions');mkdirSync(directory,{recursive:true});
  const id=randomUUID(),path=join(directory,id+'.json');
  const receipt:DeploymentSession={formatVersion:1,id,pid:process.pid,processIdentity:processIdentity(process.pid),startedAt:now.toISOString(),endedAt:null,mode:config.mode,
    configRevision:config.revision,build,outcome:'running'};
  writeFileSync(path,JSON.stringify(receipt),{encoding:'utf8',mode:0o600,flag:'wx'});
  return{finish:(success:boolean)=>{
    const stage=path+'.partial';
    try{writeFileSync(stage,JSON.stringify({...receipt,endedAt:new Date().toISOString(),outcome:success?'stopped':'failed'}),{mode:0o600});
      renameSync(stage,path);}finally{if(existsSync(stage))unlinkSync(stage);}
  }};
}
