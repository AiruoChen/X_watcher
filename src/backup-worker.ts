import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SystemClock} from './adapters/clock.js';
import {TimerWaiter} from './adapters/execution.js';
import {inspectDatabase} from './adapters/storage/sqlite/integrity.js';
import {SCHEMA_VERSION} from './adapters/storage/sqlite/migrations.js';
import {SqliteStore} from './adapters/storage/sqlite/store.js';
import {BackupSchedule} from './runtime/backup-schedule.js';
export async function backupWorker(env:NodeJS.ProcessEnv):Promise<number>{
  const path=env.DATABASE_PATH,directory=env.BACKUP_DIRECTORY,hours=env.BACKUP_INTERVAL_HOURS??'24';
  if(!path||!directory||!/^\d+$/.test(hours)||Number(hours)<1||Number(hours)>168)throw new Error('Backups require database, output directory and a 1–168 hour interval.');
  const stop=new AbortController(),cancel=():void=>stop.abort();
  const schedule=new BackupSchedule({create:async()=>{
    const read=new DatabaseSync(path,{readOnly:true});try{if(inspectDatabase(read)!==SCHEMA_VERSION)throw new Error('Upgrade explicitly before scheduled backup.');}finally{read.close();}
    const store=new SqliteStore(path);
    try{return store.backup(join(directory,'backup-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()+'.sqlite'));}
    finally{store.close();}
  }},new SystemClock(),new TimerWaiter(),Number(hours)*3600000,{record:event=>console.log(JSON.stringify(event))});
  process.on('SIGTERM',cancel);process.on('SIGINT',cancel);
  try{await schedule.run(stop.signal);return 0;}finally{process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
}
