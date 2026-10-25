import{readFileSync,readdirSync}from'node:fs';
import{spawnSync}from'node:child_process';
import{join,resolve}from'node:path';
import{pathToFileURL}from'node:url';
import{evaluateScenarios,saveReport,suiteHash,testEnvironment}from'./acceptance-lib.mjs';
const args=process.argv.slice(2);
let output=null,benchmark=false;
for(let i=0;i<args.length;i++){if(args[i]==='--output'&&args[i+1])output=args[++i];else if(args[i]==='--benchmark')benchmark=true;else throw Error('Usage: acceptance:offline [--output new-file] [--benchmark]');}
output??='data/acceptance/offline-'+new Date().toISOString().replaceAll(':','-')+'.json';
const build=JSON.parse(readFileSync('dist/build-info.json','utf8'));
const files=readdirSync('dist/tests').filter(n=>n.endsWith('.test.js')).sort().map(n=>join('dist/tests',n));
if(!files.length)throw Error('Build tests before acceptance');
const env=testEnvironment(process.env),run=spawnSync(process.execPath,['--experimental-sqlite','--test','--test-reporter='+pathToFileURL(resolve('scripts/acceptance-reporter.mjs')).href,...files],
 {encoding:'utf8',env,windowsHide:true,maxBuffer:16*1024*1024,timeout:180000});
let events=[];try{events=String(run.stdout??'').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch{throw Error('Invalid test reporter output');}
const scenarios=evaluateScenarios(JSON.parse(readFileSync('acceptance/scenarios.json','utf8')),events);
const timingRun=spawnSync(process.execPath,['--experimental-sqlite','dist/src/acceptance-timing.js'],{env,encoding:'utf8',windowsHide:true,timeout:30000});
let timing=null;try{timing=JSON.parse(timingRun.stdout);}catch{}
let capacity=null,capacityOk=true;
if(benchmark){const measured=spawnSync(process.execPath,['--experimental-sqlite','dist/src/storage-benchmark.js'],{env,encoding:'utf8',windowsHide:true,timeout:180000});
 try{capacity=JSON.parse(measured.stdout);}catch{}capacityOk=measured.status===0 && capacity?.targets===10 && capacity?.postVersions===100000;}
const passed=run.status===0 && events.length>0 && events.every(e=>e.state==='passed'&&!e.skip&&!e.todo)
 && scenarios.every(s=>s.status==='offline_passed') && timingRun.status===0 && timing?.status==='passed' && capacityOk;
const report={formatVersion:1,kind:'offline_acceptance',at:new Date().toISOString(),build,testSuiteHash:suiteHash(),
 status:passed?'passed':'failed',tests:{passed:events.filter(e=>e.state==='passed').length,failed:events.filter(e=>e.state==='failed').length},
 scenarios,timing,capacity,productionReady:false,externalGates:{preview48h:'not_run',realModelQuality:'not_run',controlledMail:'not_run',realTiming:'not_run'}};
const sha256=saveReport(output,report);
console.log(JSON.stringify({status:report.status,tests:report.tests,scenarios:scenarios.map(s=>({id:s.id,status:s.status})),output,sha256,productionReady:false}));
if(!passed){console.error(JSON.stringify({failedTests:events.filter(e=>e.state!=='passed').map(e=>({name:e.name,file:e.file})),unmatched:scenarios.filter(s=>s.status!=='offline_passed'),timingStatus:timing?.status??'not_run',capacityOk}));process.exitCode=1;}
