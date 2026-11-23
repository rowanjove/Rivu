import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RivuDatabase } from './database';
import { createBackup } from './backup';

type Phase='draining'|'backup'|'cache'|'fts'|'vacuum'|'integrity';
type Result={completedAt:string;durationMs:number;beforeBytes:number;afterBytes:number;removedCacheRows:number;backupPath:string};
const conflict=(message:string)=>Object.assign(Error(message),{statusCode:409});
const OWNED=/^rivu-maintenance-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.zip$/;

export class DatabaseMaintenance{
  private task:Promise<void>|null=null;
  private phase:Phase|null=null;
  private snapshotPercent:number|null=null;
  private lastResult:Result|null=null;
  private lastError:string|null=null;
  constructor(private db:RivuDatabase,private dataDir:string,private workerPath:string){}
  status(){return {running:!!this.task,phase:this.phase,snapshotPercent:this.snapshotPercent,lastResult:this.lastResult,lastError:this.lastError};}
  start(prepare:()=>Promise<void>){
    if(this.task)throw conflict('数据库优化已在运行');
    this.phase='draining';this.snapshotPercent=null;this.lastError=null;
    this.task=(async()=>{await prepare();this.phase='backup';this.snapshotPercent=0;return this.perform();})().then(result=>{this.lastResult=result;},error=>{this.lastError=error instanceof Error?error.message:String(error);}).finally(()=>{this.phase=null;this.snapshotPercent=null;this.task=null;});
    return this.status();
  }
  async wait(){await this.task;}
  async stop(){await this.wait();}
  private async perform():Promise<Result>{
    const started=Date.now(),databasePath=join(this.dataDir,'rivu.db');
    const beforeBytes=(await stat(databasePath)).size;
    const required=BigInt(beforeBytes)*3n+512n*1024n*1024n;
    const available=await statfs(this.dataDir,{bigint:true});
    if(available.bsize*available.bavail<required)throw Error(`数据库优化需要约 ${(Number(required)/1024**3).toFixed(1)} GiB 可用空间以容纳保护备份和整理临时文件`);
    if(parse(this.dataDir).root.toLowerCase()!==parse(tmpdir()).root.toLowerCase()){
      const tempSpace=await statfs(tmpdir(),{bigint:true});
      if(tempSpace.bsize*tempSpace.bavail<BigInt(beforeBytes)*2n)throw Error('系统临时目录可用空间不足，无法安全整理数据库');
    }
    const directory=join(this.dataDir,'backups'),name=`rivu-maintenance-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.zip`,backupPath=join(directory,name);
    await mkdir(directory,{recursive:true});
    await createBackup(this.db,this.dataDir,backupPath,{onSnapshotProgress:percent=>{this.snapshotPercent=percent;}});
    const previous=(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isFile()&&OWNED.test(entry.name)&&entry.name!==name).map(entry=>entry.name).sort().reverse();
    for(const old of previous.slice(2))await rm(join(directory,old),{force:true});
    const removedCacheRows=await new Promise<number>((resolve,reject)=>{
      const worker=new Worker(this.workerPath,{workerData:{databasePath,imageDirectory:join(this.dataDir,'cache','images')}});
      let settled=false,removed:number|undefined,workerError:Error|undefined;
      worker.on('message',(message:{phase?:Phase;done?:boolean;removedCacheRows?:number;error?:string})=>{
        if(message.phase){this.phase=message.phase;return;}
        if(message.error){workerError=Error(message.error);return;}
        if(message.done)removed=message.removedCacheRows||0;
      });
      worker.on('error',error=>{if(!settled){settled=true;reject(error);}});
      worker.on('exit',code=>{if(!settled){settled=true;if(workerError)reject(workerError);else if(code!==0||removed===undefined)reject(Error(`数据库维护进程提前退出（${code}）`));else resolve(removed);}});
    });
    return {completedAt:new Date().toISOString(),durationMs:Date.now()-started,beforeBytes,afterBytes:(await stat(databasePath)).size,removedCacheRows,backupPath};
  }
}
