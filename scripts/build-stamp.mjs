import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {SCHEMA_VERSION} from '../dist/src/adapters/storage/sqlite/migrations.js';
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
const hash=createHash('sha256');
for(const path of [...walk('src'), 'package.json','package-lock.json','tsconfig.json'].map(p=>p.replaceAll('\\','/')).sort()){
  hash.update(path.replaceAll('\\','/'));hash.update('\0');hash.update(readFileSync(path,'utf8').replaceAll('\r\n','\n'));hash.update('\0');
}
let commit=null,dirty=null;
try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 dirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
if(process.env.BUILD_REVISION){if(!/^[a-f0-9]{40}$/.test(process.env.BUILD_REVISION))throw Error('Invalid build revision');commit=process.env.BUILD_REVISION;dirty=null;}
const info={formatVersion:1,version:JSON.parse(readFileSync('package.json','utf8')).version,node:process.version,
 schemaVersion:SCHEMA_VERSION,sourceHash:hash.digest('hex'),lockHash:createHash('sha256').update(readFileSync('package-lock.json','utf8').replaceAll('\r\n','\n')).digest('hex'),commit,dirty};
writeFileSync('dist/build-info.json',JSON.stringify(info,null,2)+'\n');
