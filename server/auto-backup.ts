import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RivuDatabase } from './database';
import { createBackup } from './backup';
import type {MainWriteAccess} from './write-coordinator';

export type BackupFrequency='off'|'daily'|'weekly';
const INTERVAL={daily:24*60*60*1000,weekly:7*24*60*60*1000};
const OWNED=/^rivu-auto-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}\.zip$/;
const invalid=(message:string)=>Object.assign(Error(message),{statusCode:400});

export class AutoBackupManager{
  private timer:NodeJS.Timeout|undefined;
  private running:Promise<unknown>|undefined;
  constructor(private db:RivuDatabase,private dataDir:string,private now:()=>number=Date.now,private withMain:MainWriteAccess=async action=>action()){}
  private get(key:string){return (this.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key) as {value:string}|undefined)?.value||'';}
  private set(key:string,value:string){this.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  frequency():BackupFrequency{const value=this.get('auto_backup_frequency');return value==='daily'||value==='weekly'?value:'off';}
  async status(){const frequency=this.frequency(),lastSuccessAt=this.get('auto_backup_last_success_at')||null,lastError=this.get('auto_backup_last_error')||null;const backups=await this.list();const previous=lastSuccessAt?Date.parse(lastSuccessAt):NaN,now=this.now();return {frequency,keep:7,lastSuccessAt,lastError,nextDueAt:frequency==='off'?null:new Date(Number.isFinite(previous)&&previous<=now?Math.max(now,previous+INTERVAL[frequency]):now).toISOString(),running:!!this.running,backups:backups.map(item=>({name:item.name,bytes:item.bytes}))};}
  async configure(input:unknown){if(!input||typeof input!=='object'||Array.isArray(input)||!['off','daily','weekly'].includes((input as {frequency?:string}).frequency||''))throw invalid('自动备份频率无效');const frequency=(input as {frequency:BackupFrequency}).frequency;this.set('auto_backup_frequency',frequency);if(frequency!=='off')void this.runDue().catch(()=>{});return this.status();}
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.runDue().catch(()=>{});},60*60*1000);this.timer.unref();void this.runDue().catch(()=>{});}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running?.catch(()=>{});}
  async runDue(){
    const frequency=this.frequency();if(frequency==='off')return {ran:false};
    if(this.running)return this.running;
    const last=Date.parse(this.get('auto_backup_last_success_at')),elapsed=this.now()-last;if(Number.isFinite(last)&&elapsed>=0&&elapsed<INTERVAL[frequency])return {ran:false};
    const task=this.withMain(()=>this.makeBackup());this.running=task;try{return await task;}finally{if(this.running===task)this.running=undefined;}
  }
  private async list(){
    const directory=join(this.dataDir,'backups');
    let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const rows:{name:string;bytes:number}[]=[];
    for(const entry of entries){if(!entry.isFile()||!OWNED.test(entry.name))continue;const info=await stat(join(directory,entry.name));rows.push({name:entry.name,bytes:info.size});}
    return rows.sort((a,b)=>b.name.localeCompare(a.name));
  }
  private async makeBackup(){
    const directory=join(this.dataDir,'backups');await mkdir(directory,{recursive:true});
    const name=`rivu-auto-${new Date(this.now()).toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.zip`,dest=join(directory,name);
    try{
      await createBackup(this.db,this.dataDir,dest);
      const files=await this.list(),older=files.filter(file=>file.name!==name);for(const old of older.slice(6))await rm(join(directory,old.name),{force:true});
      this.set('auto_backup_last_success_at',new Date(this.now()).toISOString());this.set('auto_backup_last_error','');
      return {ran:true,name};
    }catch(error){await rm(dest,{force:true});this.set('auto_backup_last_error',error instanceof Error?error.message:String(error));return {ran:false,error:this.get('auto_backup_last_error')};}
  }
}
