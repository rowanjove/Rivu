import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {rm} from 'node:fs/promises';
import type {ArchiveExportInput} from './archive-export-task';

export class ArchiveExporter{
  private tail:Promise<unknown>=Promise.resolve();
  private closed=false;
  private accepted=0;
  constructor(private workerPath:string,private modulePath=join(dirname(workerPath),'archive-export-task.cjs'),private maxPending=8,private timeoutMs=600_000){}
  export(databasePath:string,archiveId:string,destination:string,onSnapshot?:()=>void):Promise<string>{
    if(this.closed)return Promise.reject(Object.assign(Error('归档导出器已关闭'),{statusCode:503}));
    if(this.accepted>=this.maxPending+1)return Promise.reject(Object.assign(Error('归档导出繁忙，请稍后重试'),{statusCode:503,resourceBusy:true}));
    this.accepted++;
    const input={databasePath,archiveId,destination,temporaryPath:`${destination}.${randomUUID()}.tmp`};
    const job=this.tail.then(()=>this.execute(input,onSnapshot)).finally(()=>{this.accepted--;});
    this.tail=job.catch(()=>{});return job;
  }
  private execute(input:ArchiveExportInput,onSnapshot?:()=>void):Promise<string>{
    return new Promise((resolve,reject)=>{
      let worker:Worker;
      try{worker=new Worker(this.workerPath,{workerData:{modulePath:this.modulePath,input},resourceLimits:{maxOldGenerationSizeMb:256}});}catch(error){reject(error);return;}
      let settled=false;
      const finish=(error?:unknown,result?:string)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        void worker.terminate().then(async()=>{
          await rm(input.temporaryPath,{force:true});
          if(error)reject(error);else resolve(result!);
        }).catch(reject);
      };
      const unknown=(message:string)=>Object.assign(Error(message),{outcomeUnknown:true,destination:input.destination});
      const timer=setTimeout(()=>finish(unknown('归档导出超时，请检查目标文件后重试')),this.timeoutMs);timer.unref();
      worker.on('message',(message:{phase?:string;error?:string;statusCode?:number;result?:unknown})=>{
        if(message?.phase==='snapshot'){try{onSnapshot?.();}catch(error){finish(error);}return;}
        if(message?.error)finish(Object.assign(Error(message.error),{statusCode:message.statusCode}));
        else if(message?.result===input.destination)finish(undefined,input.destination);
        else finish(unknown('归档导出结果无效，请检查目标文件'));
      });
      worker.on('error',error=>finish(Object.assign(error,{outcomeUnknown:true,destination:input.destination})));
      worker.on('exit',code=>{if(!settled)finish(unknown(`归档导出进程退出（${code}），请检查目标文件`));});
    });
  }
  async stop(){this.closed=true;await this.tail;}
}
