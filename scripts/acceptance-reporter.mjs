import {relative,isAbsolute} from 'node:path';
export default async function* report(source){
 for await(const event of source){
  if(!['test:pass','test:fail'].includes(event.type))continue;
  const d=event.data;
  yield JSON.stringify({state:event.type==='test:pass'?'passed':'failed',name:isAbsolute(d.name)?relative(process.cwd(),d.name).replaceAll('\\','/'):d.name,
   file:d.file?relative(process.cwd(),d.file).replaceAll('\\','/'):null,skip:!!d.skip,todo:!!d.todo,
   durationMs:d.details?.duration_ms??null,code:event.type==='test:fail'?'test_failed':null})+'\n';
 }
}
