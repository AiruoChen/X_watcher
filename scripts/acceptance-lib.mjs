import {createHash} from 'node:crypto';
import{readFileSync,readdirSync,mkdirSync,writeFileSync}from'node:fs';
import{dirname,join}from'node:path';
export function evaluateScenarios(manifest,events){
 if(!Array.isArray(manifest)||manifest.length!==20||new Set(manifest.map(x=>x.id)).size!==20
  ||manifest.some(x=>!/^AC-(?:0[1-9]|1\d|20)$/.test(x.id)||!Array.isArray(x.required)||!x.required.length))throw Error('Invalid acceptance manifest');
 return manifest.map(s=>{const checks=s.required.map(pattern=>{
   const matched=events.filter(e=>new RegExp(pattern).test(e.name));
   return{pattern,matched:matched.length,passed:matched.length>0&&matched.every(e=>e.state==='passed'&&!e.skip&&!e.todo)};
  });return{id:s.id,status:checks.every(c=>c.passed)?'offline_passed':'failed',checks,productionAcceptance:'pending_external_validation'};});
}
export function suiteHash(){
 const hash=createHash('sha256');
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
 for(const path of [...walk('tests'),...walk('evals'),'acceptance/scenarios.json'].sort()){
  hash.update(path.replaceAll('\\','/'));hash.update('\0');hash.update(readFileSync(path,'utf8').replaceAll('\r\n','\n'));hash.update('\0');
 }return hash.digest('hex');
}
export function saveReport(path,value){
 const data=JSON.stringify(value,null,2)+'\n';mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data,{flag:'wx',mode:0o600});
 return createHash('sha256').update(data).digest('hex');
}
export function testEnvironment(parent){
 const allowed=['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LANG','LC_ALL','TZ'];
 const env={};for(const key of allowed)if(parent[key]!==undefined)env[key]=parent[key];
 return {...env,APP_MODE:'demo',NOTIFICATION_TO:'reader@example.invalid',X_WATCHER_OFFLINE_ACCEPTANCE:'1'};
}
