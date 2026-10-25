import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
/** Sensitive export is explicit, owner-readable, staged and published without overwriting. */
export function exportHistory(destination:string,rows:readonly Readonly<Record<string,unknown>>[]): {sha256:string;rows:number;bytes:number} {
  const target=resolve(destination);
  if(existsSync(target))throw new Error('Export destination already exists.');
  mkdirSync(dirname(target),{recursive:true});
  const stage=target+'.'+randomUUID()+'.partial';
  const content=rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'');
  try {
    const fd=openSync(stage,'wx',0o600);
    try {writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}
    linkSync(stage,target);return{sha256:createHash('sha256').update(content).digest('hex'),rows:rows.length,bytes:Buffer.byteLength(content)};}
  finally{if(existsSync(stage))unlinkSync(stage);}
}
