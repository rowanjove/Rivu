import type {RivuDatabase} from './database';
import {saveArchive,validateArchiveOptions,type ArchiveSaveAccess,type SaveOptions} from './archive';

export class ArchiveSaver{
  private closed=false;
  private running=0;
  private pending:{id:string;run:()=>void}[]=[];
  private activeEntries=new Set<string>();
  private jobs=new Map<string,Promise<Awaited<ReturnType<typeof saveArchive>>>>();
  constructor(private db:RivuDatabase,private access:ArchiveSaveAccess,private maxPending=16){}
  save(id:string,options:SaveOptions={}){
    validateArchiveOptions(options);
    if(this.closed)return Promise.reject(Object.assign(Error('归档保存正在停止'),{statusCode:503}));
    const key=JSON.stringify([id,!!options.images,!!options.attachments,!!options.snapshot]),existing=this.jobs.get(key);if(existing)return existing;
    if((this.running>=2||this.activeEntries.has(id))&&this.pending.length>=this.maxPending)return Promise.reject(Object.assign(Error('归档保存繁忙，请稍后重试'),{statusCode:503,resourceBusy:true}));
    const captured={images:!!options.images,attachments:!!options.attachments,snapshot:!!options.snapshot};
    const job=new Promise<Awaited<ReturnType<typeof saveArchive>>>((resolve,reject)=>{this.pending.push({id,run:()=>{this.running++;this.activeEntries.add(id);void saveArchive(this.db,id,captured,this.access).then(resolve,reject).finally(()=>{this.running--;this.activeEntries.delete(id);this.drain();});}});this.drain();});
    this.jobs.set(key,job);void job.finally(()=>{if(this.jobs.get(key)===job)this.jobs.delete(key);}).catch(()=>{});return job;
  }
  private drain(){while(this.running<2&&this.pending.length){const index=this.pending.findIndex(job=>!this.activeEntries.has(job.id));if(index===-1)break;this.pending.splice(index,1)[0].run();}}
  async stop(){this.closed=true;await Promise.allSettled([...this.jobs.values()]);}
}
