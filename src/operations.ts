import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from './domain/model.js';
import { SqliteStore } from './adapters/storage/sqlite/store.js';
import { restoreBackup } from './adapters/storage/sqlite/backup.js';
import { exportHistory } from './adapters/storage/export.js';
import { budgetReason, localDay, SERVICES } from './domain/policies/operations.js';
import { digestWindowForDay } from './domain/time.js';
import { validDay } from './domain/policies/reporting.js';

export function operationStatus(store:SqliteStore,config:RuntimeConfig,now:Date):Readonly<Record<string,unknown>> {
  const day=store.operations.budgetDay(localDay(now,config.timeZone)),usage=store.operations.usage(day);
  const ledgerCurrency=usage.find(r=>r.calls>r.unpricedCalls && r.currency)?.currency ?? config.budget.currency;
  return {mode:config.mode,at:now.toISOString(),...store.operations.summary(),budget:{day,clockState:day===localDay(now,config.timeZone)?'current':'clock_rollback_detected',currency:ledgerCurrency,configuredCurrency:config.budget.currency,
    estimatedKnownCost:ledgerCurrency?usage.reduce((n,r)=>n+r.knownMicros,0)/1e6:null,
    estimateComplete:usage.every(r=>r.unpricedCalls===0),measuredCalls:usage.reduce((n,r)=>n+r.measuredCalls,0),
    services:Object.fromEntries(SERVICES.map(s=>[s,{state:budgetReason(usage,s,config.budget)?'budget_exhausted':'available',
      reason:budgetReason(usage,s,config.budget),calls:usage.find(r=>r.service===s)?.calls??0}]))}};
}
/** All external service calls remain in the running host, not in this command process. */
export function operations(config:RuntimeConfig,command:string,args:readonly string[],now=new Date()):void {
  if(config.storage.kind!=='sqlite')throw new Error('Operations require existing SQLite storage.');
  const length=(n:number):void=>{if(args.length!==n)throw new Error('Invalid operations arguments; see docs/OPERATIONS.md.');};
  if(command==='ops:restore'){length(3);console.log(JSON.stringify(restoreBackup(args[0]!,args[1]!,args[2]!)));return;}
  const store=new SqliteStore(config.storage.path);
  try{
    const ops=store.operations;
    if(command==='ops:status'||command==='ops:metrics'){length(0);console.log(JSON.stringify(operationStatus(store,config,now)));return;}
    if(command==='ops:usage'){length(0);console.log(JSON.stringify({day:ops.budgetDay(localDay(now,config.timeZone)),totals:ops.usage().map(r=>({...r,unmeasuredCalls:r.calls-r.measuredCalls})),note:'Configured ceiling estimates; not a provider invoice. Null prices and unmeasured tokens remain unknown.'}));return;}
    if(command==='ops:analysis'){
      if(args.length>1 || args[0] && !/^\d+$/.test(args[0])) throw new Error('Invalid analysis job limit.');
      console.log(JSON.stringify(ops.analysisJobs(args[0]?Number(args[0]):50)));return;
    }
    if(command==='ops:notifications'){if(args.length>1||args[0]&&!/^\d+$/.test(args[0]))throw new Error('Invalid notification limit.');
      console.log(JSON.stringify(ops.notifications(args[0]?Number(args[0]):50)));return;}
    if(command==='ops:command'){length(1);const result=ops.control(args[0]!);if(!result)throw new Error('Unknown command ID.');console.log(JSON.stringify(result));return;}
    if(command==='ops:backup'){length(1);console.log(JSON.stringify(store.backup(args[0]!)));return;}
    if(command==='ops:export'){
      length(3);if(!validDay(args[0]!)||!validDay(args[1]!)||args[0]!>args[1]!)throw new Error('Invalid export date range.');
      const from=digestWindowForDay(args[0]!,config.timeZone).from,to=digestWindowForDay(args[1]!,config.timeZone).to;
      console.log(JSON.stringify(exportHistory(args[2]!,ops.archiveRows(from,to,config.targets.map(t=>t.id)))));return;
    }
    if(command==='ops:cleanup'){
      if(!args.length){console.log(JSON.stringify(ops.cleanupPlan(now.toISOString(),config.policy.postRetentionDays,config.policy.auditRetentionDays)));return;}
      if(args.length!==4||args[0]!=='--apply')throw new Error('Usage: ops:cleanup --apply <preview-at> <preview-token> <new-backup-path>');
      if(!config.operations.retentionTermsReviewed)throw new Error('Set RETENTION_TERMS_REVIEWED=true only after reviewing source terms; cleanup is disabled.');
      if(store.runtime.current())throw new Error('Stop the runtime before cleanup.');
      const plan=ops.cleanupPlan(args[1]!,config.policy.postRetentionDays,config.policy.auditRetentionDays);
      if(plan.token!==args[2])throw new Error('Cleanup plan changed; preview again.');
      const backup=store.backup(args[3]!);
      console.log(JSON.stringify({backup,deleted:ops.cleanup(plan)}));return;
    }
    if(command==='ops:recover'){
      length(0);const lease=store.runtime.acquire(config.runtime.leaseMs);if(!lease)throw new Error('Active/unknown host ownership prevents recovery.');
      const result=store.recoverAbandonedWork(lease.revision),schedules=store.schedules.recover(now.toISOString());
      store.runtime.release(lease.revision);console.log(JSON.stringify({result,schedules,mail:'unknown submissions remain needs_attention'}));return;
    }
    let kind:import('./domain/model.js').ControlCommand['kind'],targetId:string|null=null,entityId:string|null=null,expectedRevision:number|null=null,reason='Explicit local operation';
    if(command==='ops:check-now'){
      if(args.length>1)throw new Error('Usage: ops:check-now [handle]');
      const target=args[0]?config.targets.find(t=>t.handle.toLowerCase()===args[0]!.replace(/^@/,'').toLowerCase()):config.targets[0];
      if(!target)throw new Error('Unknown configured target.');targetId=target.id;kind='check';
    }else if(command==='ops:stop'){length(0);kind='stop';}
    else if(command==='ops:resume'||command==='ops:retry-analysis'){
      length(3);if(!/^\d+$/.test(args[1]!))throw new Error('Invalid expected revision.');
      kind=command==='ops:resume'?'resume':'retry_analysis';entityId=args[0]!;expectedRevision=Number(args[1]);reason=args[2]!;
    }else throw new Error('Unknown operations command.');
    console.log(JSON.stringify(ops.requestControl({id:randomUUID(),kind,targetId,entityId,expectedRevision,reason,at:now.toISOString()})));
  }finally{store.close();}
}
