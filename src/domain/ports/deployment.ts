export interface BackupResult { readonly schemaVersion:number;readonly sha256:string;readonly bytes:number }
export interface BackupTask { create():Promise<BackupResult> }
export interface BackupObserver { record(event:{readonly type:'backup.created'|'backup.failed'|'backup.recovered';readonly result?:BackupResult}):void }
