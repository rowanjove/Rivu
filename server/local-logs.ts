import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LogKind='app'|'feed'|'ai'|'error';
export type LogFields={feedId?:string;action?:string;outcome?:'ok'|'failed';added?:number;total?:number;durationMs?:number;statusCode?:number;errorType?:string;buildId?:string;appVersion?:string;runtimeVersion?:string};
const KINDS:LogKind[]=['app','feed','ai','error'];
const MAX_BYTES=10*1024*1024,DAY_MS=86_400_000;
const day=(value:number)=>new Date(value).toISOString().slice(0,10);
const errorType=(value:unknown)=>{const name=value instanceof Error?value.name:'Error';return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)?name:'Error';};
export const logErrorType=errorType;

export class LocalLogs {
  private queue=Promise.resolve();
  private lastPruneDay=day(Date.now());
  private constructor(private directory:string){}
  static async open(dataDir:string){
    const logs=new LocalLogs(join(dataDir,'logs'));
    await mkdir(logs.directory,{recursive:true});
    for(const kind of KINDS){await logs.rotate(kind,false);await appendFile(join(logs.directory,`${kind}.log`),'');}
    await logs.prune();
    return logs;
  }
  private async rotate(kind:LogKind,force:boolean){
    const current=join(this.directory,`${kind}.log`);
    let info;try{info=await stat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(!force&&day(info.mtimeMs)===day(Date.now())&&info.size<MAX_BYTES)return;
    await rename(current,join(this.directory,`${kind}.${day(info.mtimeMs)}.${randomUUID().slice(0,8)}.log`));
  }
  private async prune(){
    const cutoff=Date.now()-7*DAY_MS;
    for(const file of await readdir(this.directory)){
      const match=file.match(/^(app|feed|ai|error)\.(\d{4}-\d{2}-\d{2})\.[0-9a-f]{8}\.log$/);
      if(match&&Date.parse(`${match[2]}T00:00:00.000Z`)<cutoff)await unlink(join(this.directory,file));
    }
  }
  write(kind:LogKind,event:string,fields:LogFields={}){
    const safeEvent=/^[a-z][a-z0-9_]{0,47}$/.test(event)?event:'unknown';
    const safe:LogFields={};
    if(fields.buildId&&/^[a-f0-9]{64}$/.test(fields.buildId))safe.buildId=fields.buildId;
    for(const key of ['appVersion','runtimeVersion'] as const)if(fields[key]&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(fields[key]!))safe[key]=fields[key];
    if(fields.feedId&&/^[0-9a-f-]{36}$/i.test(fields.feedId))safe.feedId=fields.feedId;
    if(fields.action&&/^[a-z][a-z0-9_]{0,31}$/.test(fields.action))safe.action=fields.action;
    if(fields.outcome==='ok'||fields.outcome==='failed')safe.outcome=fields.outcome;
    for(const key of ['added','total','durationMs','statusCode'] as const){const value=fields[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)safe[key]=Math.floor(value);}
    if(fields.errorType)safe.errorType=/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(fields.errorType)?fields.errorType:'Error';
    const line=JSON.stringify({at:new Date().toISOString(),event:safeEvent,...safe})+'\n';
    const operation=this.queue.then(async()=>{
      const today=day(Date.now());
      if(today!==this.lastPruneDay){for(const name of KINDS){await this.rotate(name,false);await appendFile(join(this.directory,`${name}.log`),'');}await this.prune();this.lastPruneDay=today;}
      else await this.rotate(kind,false);
      await appendFile(join(this.directory,`${kind}.log`),line,'utf8');
    });
    this.queue=operation.catch(()=>{});
    return operation;
  }
  async flush(){await this.queue;}
}
