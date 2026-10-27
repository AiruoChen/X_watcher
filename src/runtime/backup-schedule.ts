import type {BackupObserver,BackupTask,Clock,Waiter} from '../domain/ports.js';
export class BackupSchedule {
  constructor(private readonly task:BackupTask,private readonly clock:Clock,private readonly waiter:Waiter,
    private readonly intervalMs:number,private readonly observer:BackupObserver){
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1||intervalMs>7*86400000)throw new Error('Invalid backup interval.');
  }
  async run(signal:AbortSignal):Promise<void>{
    let failed=false;
    while(!signal.aborted){
      let delay=this.intervalMs;
      try{
        const result=await this.task.create();
        if(failed)this.observer.record({type:'backup.recovered',result});
        this.observer.record({type:'backup.created',result});failed=false;
      }catch{
        if(!failed)this.observer.record({type:'backup.failed'});failed=true;delay=Math.min(this.intervalMs,15*60000);
      }
      const until=this.clock.monotonicMs()+delay;
      while(!signal.aborted && this.clock.monotonicMs()<until)await this.waiter.wait(Math.min(60000,until-this.clock.monotonicMs()),signal);
    }
  }
}
