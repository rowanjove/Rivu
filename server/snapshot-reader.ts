import {Worker} from 'node:worker_threads';
export class SnapshotReader<Input>{
  private tail:Promise<unknown>=Promise.resolve();
  private worker:Worker|null=null;
  private closed=false;
  private accepted=0;
  constructor(private workerPath:string,private modulePath:string,private maxPending=16,private timeoutMs=120000,private label='后台读取',private decodeResult?:(result:unknown)=>Promise<unknown>,private shutdownMessage?:unknown,private workerConfiguration?:Record<string,unknown>){}
  prestart(){
    if(this.closed)throw Object.assign(Error(`${this.label}器已关闭`),{statusCode:503});
    this.getWorker();
  }
  private getWorker():Worker{
    if(!this.worker){const created=new Worker(this.workerPath,{workerData:{...this.workerConfiguration,modulePath:this.modulePath},resourceLimits:{maxOldGenerationSizeMb:256}});this.worker=created;created.on('error',()=>{if(this.worker===created)this.worker=null;});created.on('exit',()=>{if(this.worker===created)this.worker=null;});}
    return this.worker;
  }
  read(input:Input):Promise<unknown>{
    if(this.closed)return Promise.reject(Object.assign(Error(`${this.label}器已关闭`),{statusCode:503}));
    if(this.accepted>=this.maxPending+1)return Promise.reject(Object.assign(Error(`${this.label}繁忙，请稍后重试`),{statusCode:503,resourceBusy:true}));
    this.accepted++;
    const job=this.tail.then(()=>this.execute(input)).finally(()=>{this.accepted--;});
    this.tail=job.catch(()=>{});return job;
  }
  private execute(input:unknown,timeoutMs=this.timeoutMs):Promise<unknown>{
    return new Promise((resolve,reject)=>{
      let worker:Worker;
      try{
        worker=this.getWorker();
      }catch(error){reject(error);return;}
      let settled=false;
      const finish=(error?:unknown,result?:unknown,discard=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);
        if(discard){if(this.worker===worker)this.worker=null;void worker.terminate().then(()=>reject(error),reject);}
        else if(error)reject(error);else if(this.decodeResult){try{resolve(this.decodeResult(result));}catch(error){reject(error);}}else resolve(result);
      };
      const timer=setTimeout(()=>finish(Object.assign(Error(`${this.label}超时，请稍后重试`),{statusCode:503}),undefined,true),timeoutMs);timer.unref();
      const onMessage=(message:{error?:string;statusCode?:number;resourceBusy?:boolean;result?:unknown})=>{
        if(message?.error)finish(Object.assign(Error(message.error),{statusCode:message.statusCode,...(message.resourceBusy===true?{resourceBusy:true}:{})}));
        else if(message&&Object.hasOwn(message,'result'))finish(undefined,message.result);
        else finish(Error(`${this.label}结果无效`),undefined,true);
      };
      const onError=(error:Error)=>finish(error,undefined,true);
      const onExit=(code:number)=>finish(Error(`${this.label}进程退出（${code}）`),undefined,true);
      worker.on('message',onMessage);worker.on('error',onError);worker.on('exit',onExit);
      try{worker.postMessage(input);}catch(error){finish(error,undefined,true);}
    });
  }
  async stop(){this.closed=true;await this.tail;try{if(this.worker&&this.shutdownMessage)await this.execute(this.shutdownMessage,1000);}catch{/* A failed close handshake still terminates the worker and its native handles. */}finally{const worker=this.worker;this.worker=null;await worker?.terminate();}}
}
