import {readFileSync} from 'node:fs';
/** A PID can be reused (notably PID 1 after a container restart); inaccessible proc data stays unknown. */
export function processIdentity(pid:number):string|null{
  if(process.platform!=='linux' || !Number.isSafeInteger(pid) || pid<1)return null;
  try{
    const stat=readFileSync('/proc/'+pid+'/stat','utf8'),end=stat.lastIndexOf(')');
    const ticks=stat.slice(end+2).split(/\s+/)[19],boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    if(end<0 || !ticks || !/^\d+$/.test(ticks) || !/^[a-f0-9-]{36}$/.test(boot))return null;
    return boot+':'+ticks;
  }catch{return null;}
}
