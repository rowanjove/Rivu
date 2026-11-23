import { createHash, randomUUID } from 'node:crypto';
import {selection} from './ai-rule-selection';
import type {AIScanInput,AIScanResult,AIScanRow,AICursor} from './ai-scan-task';
import type {MainWriteAccess} from './write-coordinator';
import type { RivuDatabase } from './database';
import { AIService, type AIActionType } from './ai';
import { validateRule, type RuleConditions } from './rules';

type Action='summary'|'keywords'|'classification';
type Rule={id:string;name:string;enabled:number;auto_run:number;conditions:string;action_type:Action;max_items:number;provider:string|null;model:string|null;credential_id:string|null;last_error:string|null;created_at:string;updated_at:string};
type Job={rule_id:string;entry_id:string;source_hash:string;provider:string;model:string;status:'queued'|'running'|'done'|'failed'|'paused';attempts:number;last_error:string|null};
const bad=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobHash=(context:{hash:string;promptVersion:string})=>hash({contentHash:context.hash,promptVersion:context.promptVersion});
const localProvider=(provider:string)=>{try{return ['localhost','127.0.0.1','::1'].includes(new URL(provider).hostname);}catch{return false;}};
function validateInput(db:RivuDatabase,raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw bad('AI 规则内容无效');
  const input=raw as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['name','conditions','actionType','maxItems'].includes(key)))throw bad('AI 规则字段无效');
  const basic=validateRule(db,{name:input.name,conditions:input.conditions,action:{type:'save'},enabled:false});
  if(!['summary','keywords','classification'].includes(String(input.actionType)))throw bad('AI 规则动作无效');
  const maxItems=input.maxItems===undefined?10:input.maxItems;
  if(!Number.isInteger(maxItems)||Number(maxItems)<1||Number(maxItems)>20)throw bad('单批处理数量应为 1 至 20');
  return {name:basic.name,conditions:basic.conditions,actionType:input.actionType as Action,maxItems:Number(maxItems)};
}
export class AIRuleService {
  private running:Promise<void>|null=null;
  private lastError:string|null=null;
  constructor(private db:RivuDatabase,private ai:AIService,private withMain:MainWriteAccess=async action=>action(),private scan?:(input:AIScanInput)=>Promise<AIScanResult>){db.db.prepare("UPDATE ai_rule_jobs SET status='paused',last_error='上次运行中断，请手动重试',updated_at=? WHERE status='running'").run(new Date().toISOString());}
  private row(id:string){const row=this.db.db.prepare('SELECT * FROM ai_rules WHERE id=?').get(id) as Rule|undefined;if(!row)throw bad('AI 规则不存在',404);return row;}
  private publicRule(row:Rule){const counts=this.db.db.prepare('SELECT status,count(*) n FROM ai_rule_jobs WHERE rule_id=? GROUP BY status').all(row.id) as {status:string;n:number}[];return {id:row.id,name:row.name,enabled:!!row.enabled,autoRun:!!row.auto_run,needsAuthorization:!!row.enabled&&!this.configMatches(row),lastError:row.last_error,conditions:JSON.parse(row.conditions) as RuleConditions,actionType:row.action_type,maxItems:row.max_items,provider:row.provider,model:row.model,createdAt:row.created_at,updatedAt:row.updated_at,stats:Object.fromEntries(counts.map(item=>[item.status,item.n]))};}
  list(){return (this.db.db.prepare('SELECT * FROM ai_rules ORDER BY created_at,id').all() as Rule[]).map(row=>this.publicRule(row));}
  status(){return {running:!!this.running,lastError:this.lastError};}
  create(raw:unknown){const input=validateInput(this.db,raw),id=randomUUID(),now=new Date().toISOString();this.db.db.prepare('INSERT INTO ai_rules(id,name,conditions,action_type,max_items,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,input.name,JSON.stringify(input.conditions),input.actionType,input.maxItems,now,now);return this.publicRule(this.row(id));}
  private async candidates(input:AIScanInput):Promise<AIScanResult>{
    if(this.scan)return this.scan(input);
    const {where,args}=selection(input.conditions,input.feedId,input.since);if(input.entryId!==undefined)args.push(input.entryId);const from=`FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}${input.entryId!==undefined?' AND e.id=?':''}`;
    const matching=input.count?Number((this.db.db.prepare(`SELECT count(*) n ${from}`).get(...args) as {n:number}).n):undefined;
    const cursor=input.cursor?' AND (COALESCE(e.published_at,e.fetched_at)<? OR (COALESCE(e.published_at,e.fetched_at)=? AND e.id>?))':'';
    return {matching,rows:this.db.db.prepare(`SELECT e.id,e.title,e.body_revision,f.title feed_title,COALESCE(e.published_at,e.fetched_at) date ${from}${cursor} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id LIMIT ?`).all(...args,...(input.cursor?[input.cursor.date,input.cursor.date,input.cursor.id]:[]),input.limit) as AIScanResult['rows']};
  }
  private matches(id:string,conditions:RuleConditions,expected:AIScanRow,feedId?:string,since?:string){
    if(expected.id!==id)return false;
    // The scanner proved the body predicate in the snapshot carrying this revision.
    const {bodyKeyword,...metadataConditions}=conditions;
    const {where,args}=selection(metadataConditions,feedId,since),row=this.db.db.prepare(`SELECT e.title,f.title feed_title FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE e.id=? AND e.body_revision=? AND ${where}`).get(id,expected.body_revision,...args) as {title:string;feed_title:string}|undefined;
    return !!row&&row.title===expected.title&&row.feed_title===expected.feed_title;
  }
  private async previewInput(input:{name:string;conditions:RuleConditions;actionType:Action;maxItems:number},id?:string){
    const selected=await this.candidates({databasePath:this.db.path,conditions:input.conditions,limit:input.maxItems,count:true});
    const rows=selected.rows,matching=selected.matching!;
    const check=()=>{if(id){const current=this.row(id);if(current.name!==input.name||current.conditions!==JSON.stringify(input.conditions)||current.action_type!==input.actionType||current.max_items!==input.maxItems)throw bad('AI 规则已变化，请重新预演',409);}for(const row of rows)if(!this.matches(row.id,input.conditions,row))throw bad('匹配文章已变化，请重新预演',409);};
    check();
    return this.ai.withPreparedBodies(rows.map(row=>row.id),()=>{
    check();const settings=this.ai.publicSettings(),provider=settings.baseUrl,model=this.ai.modelFor(input.actionType);
    const sample=rows.map(row=>{try{const context=this.ai.previewAction(row.id,input.actionType);return {id:row.id,title:row.title,feedTitle:row.feed_title,prompt:context.prompt,chars:context.chars};}catch(error){return {id:row.id,title:row.title,feedTitle:row.feed_title,prompt:'',chars:0,error:error instanceof Error?error.message:String(error)};}});
    return {matching,sample,provider,model,isLocal:localProvider(provider),scopeHash:hash({id,name:input.name,conditions:input.conditions,actionType:input.actionType,maxItems:input.maxItems,provider,model,credentialId:this.ai.authorizationIdentity()})};
    });
  }
  previewDraft(raw:unknown){return this.previewInput(validateInput(this.db,raw));}
  preview(id:string){const row=this.row(id);return this.previewInput({name:row.name,conditions:JSON.parse(row.conditions),actionType:row.action_type,maxItems:row.max_items},id);}
  async enable(id:string,raw:unknown){const before=this.row(id),identity=this.ai.authorizationIdentity();if(!raw||typeof raw!=='object'||Array.isArray(raw))throw bad('授权内容无效');const input=raw as Record<string,unknown>,preview=await this.preview(id);if(JSON.stringify(this.row(id))!==JSON.stringify(before)||identity!==this.ai.authorizationIdentity()||this.ai.publicSettings().baseUrl!==preview.provider||this.ai.modelFor(before.action_type)!==preview.model)throw bad('规则或 Provider 已变化，请重新预演',409);if(input.scopeHash!==preview.scopeHash)throw bad('规则范围或 Provider 已变化，请重新预演',409);if(input.confirmSend!==true)throw bad('须明确确认发送范围');if(!preview.isLocal&&input.allowRemote!==true)throw bad('远端 Provider 需单独授权');if(typeof input.autoRun!=='boolean')throw bad('自动处理选项无效');if(!preview.model)throw bad('请先配置 AI 模型');this.ai.persistCredentialIdentity();this.db.db.prepare('UPDATE ai_rules SET enabled=1,auto_run=?,provider=?,model=?,credential_id=?,last_error=NULL,updated_at=? WHERE id=?').run(Number(input.autoRun),preview.provider,preview.model,this.ai.authorizationIdentity(),new Date().toISOString(),id);this.db.db.prepare("UPDATE ai_rule_jobs SET provider=?,model=?,last_error='授权已更新，请手动重试',updated_at=? WHERE rule_id=? AND status='paused'").run(preview.provider,preview.model,new Date().toISOString(),id);return this.publicRule(this.row(id));}
  disable(id:string){this.row(id);this.db.db.exec('BEGIN');try{this.db.db.prepare('UPDATE ai_rules SET enabled=0,auto_run=0,updated_at=? WHERE id=?').run(new Date().toISOString(),id);this.db.db.prepare("UPDATE ai_rule_jobs SET status='paused',last_error='规则已停用',updated_at=? WHERE rule_id=? AND status='queued'").run(new Date().toISOString(),id);this.db.db.exec('COMMIT');}catch(error){this.db.db.exec('ROLLBACK');throw error;}return this.publicRule(this.row(id));}
  delete(id:string){this.row(id);if(this.db.db.prepare("SELECT 1 FROM ai_rule_jobs WHERE rule_id=? AND status='running' LIMIT 1").get(id))throw bad('当前有正在处理的任务，请结束后再删除',409);this.db.db.prepare('DELETE FROM ai_rules WHERE id=?').run(id);return {deleted:true};}
  jobs(id:string){this.row(id);return this.db.db.prepare('SELECT j.*,e.title FROM ai_rule_jobs j LEFT JOIN entries e ON e.id=j.entry_id WHERE j.rule_id=? ORDER BY j.updated_at DESC LIMIT 100').all(id);}
  private configMatches(row:Rule){const settings=this.ai.publicSettings(),model=this.ai.modelFor(row.action_type);return row.provider===settings.baseUrl&&row.model===model&&row.credential_id===this.ai.authorizationIdentity();}
  async enqueue(id:string,feedId?:string,since?:string){const row=this.row(id);if(!row.enabled)throw bad('AI 规则尚未启用');if(!this.configMatches(row))throw bad('Provider 或模型已变化，请重新预演并授权',409);const conditions=JSON.parse(row.conditions) as RuleConditions;let queued=0,scanned=0;const staged=new Map<string,{sourceHash:string;candidate:AIScanRow}>();
    let cursor:AICursor|undefined;
    const check=()=>{if(JSON.stringify(this.row(id))!==JSON.stringify(row)||!this.configMatches(row))throw bad('AI 规则授权已变化，请重新预演',409);};
    while(staged.size<row.max_items){const entries=(await this.candidates({databasePath:this.db.path,conditions,limit:100,feedId,since,cursor})).rows;check();if(!entries.length)break;for(const entry of entries){scanned++;if(staged.has(entry.id))continue;if(!this.matches(entry.id,conditions,entry,feedId,since))continue;let sourceHash='';try{sourceHash=await this.ai.withPreparedBodies([entry.id],()=>{check();if(!this.matches(entry.id,conditions,entry,feedId,since))throw bad('文章不再匹配规则，请重新运行',409);return jobHash(this.ai.previewAction(entry.id,row.action_type));});}catch(error){if((error as {resourceBusy?:boolean;statusCode?:number}).resourceBusy||(error as {statusCode?:number}).statusCode===409)throw error;}if(!this.row(id).enabled||!this.configMatches(row))throw bad('AI 规则授权已变化，请重新预演',409);const existing=this.db.db.prepare('SELECT * FROM ai_rule_jobs WHERE rule_id=? AND entry_id=?').get(id,entry.id) as Job|undefined;if(existing&&existing.source_hash===sourceHash&&existing.provider===row.provider&&existing.model===row.model)continue;staged.set(entry.id,{sourceHash,candidate:entry});if(staged.size>=row.max_items)break;}cursor={date:entries.at(-1)!.date,id:entries.at(-1)!.id};if(entries.length<100)break;}
    await this.ai.withPreparedBodies([...staged.keys()],()=>{
      check();
      for(const [entryId,{sourceHash,candidate}] of staged){let currentHash='';try{currentHash=jobHash(this.ai.previewAction(entryId,row.action_type));}catch(error){const failure=error as {resourceBusy?:boolean;statusCode?:number};if(failure.resourceBusy||failure.statusCode===409)throw error;}if(!this.matches(entryId,conditions,candidate,feedId,since)||currentHash!==sourceHash)throw bad('批次文章已变化，未加入任务，请重新运行',409);}
      this.db.db.exec('BEGIN IMMEDIATE');
      try{
        for(const [entryId,{sourceHash}] of staged){const existing=this.db.db.prepare('SELECT * FROM ai_rule_jobs WHERE rule_id=? AND entry_id=?').get(id,entryId) as Job|undefined;if(existing&&existing.source_hash===sourceHash&&existing.provider===row.provider&&existing.model===row.model)continue;
const now=new Date().toISOString();this.db.db.prepare("INSERT INTO ai_rule_jobs(rule_id,entry_id,source_hash,provider,model,status,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?) ON CONFLICT(rule_id,entry_id) DO UPDATE SET source_hash=excluded.source_hash,provider=excluded.provider,model=excluded.model,status='queued',attempts=0,last_error=NULL,updated_at=excluded.updated_at").run(id,entryId,sourceHash,row.provider,row.model,now,now);queued++;}
        this.db.db.prepare('UPDATE ai_rules SET last_error=NULL WHERE id=?').run(id);
        this.db.db.exec('COMMIT');
      }catch(error){this.db.db.exec('ROLLBACK');throw error;}
    });
    if(queued)this.pump();return {queued,scanned,limit:row.max_items};
  }
  async enqueueAutomaticForFeed(feedId:string,since:string){for(const row of this.db.db.prepare('SELECT id FROM ai_rules WHERE enabled=1 AND auto_run=1').all() as {id:string}[]){try{await this.enqueue(row.id,feedId,since);}catch(error){const message=String(error instanceof Error?error.message:error).slice(0,500);this.db.db.prepare('UPDATE ai_rules SET last_error=? WHERE id=?').run(message,row.id);}}}
  retry(id:string){const row=this.row(id);if(!row.enabled)throw bad('AI 规则尚未启用');if(!this.configMatches(row))throw bad('Provider 或模型已变化，请重新预演并授权',409);const changed=Number(this.db.db.prepare("UPDATE ai_rule_jobs SET status='queued',last_error=NULL,updated_at=? WHERE rule_id=? AND status IN ('failed','paused')").run(new Date().toISOString(),id).changes);if(changed)this.pump();return {queued:changed};}
  pump(){if(this.running)return this.running;this.lastError=null;this.running=this.process().catch(error=>{this.lastError=String(error);}).finally(()=>{this.running=null;});return this.running;}
  async wait(){await this.running;}
  private async process(){
    for(;;){
      const progressed=await this.withMain(async()=>{
        const job=this.db.db.prepare("SELECT j.* FROM ai_rule_jobs j JOIN ai_rules r ON r.id=j.rule_id WHERE j.status='queued' AND r.enabled=1 ORDER BY j.created_at LIMIT 1").get() as Job|undefined;
        if(!job)return false;
        const rule=this.row(job.rule_id);
        if(!this.configMatches(rule)){
          this.db.db.prepare("UPDATE ai_rule_jobs SET status='paused',last_error='Provider 或模型已变化，请重新授权',updated_at=? WHERE rule_id=? AND entry_id=?").run(new Date().toISOString(),job.rule_id,job.entry_id);
          return true;
        }
        this.db.db.prepare("UPDATE ai_rule_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE rule_id=? AND entry_id=?").run(new Date().toISOString(),job.rule_id,job.entry_id);
        let sourceHash=job.source_hash;
        const fence="rule_id=? AND entry_id=? AND status='running' AND attempts=? AND source_hash=? AND provider=? AND model=?";
        const fenceArgs=()=>[job.rule_id,job.entry_id,job.attempts+1,sourceHash,job.provider,job.model];
        try{
          await this.ai.withPreparedBodies([job.entry_id],async()=>{
            if(!this.row(job.rule_id).enabled||!this.configMatches(rule))throw bad('AI 规则授权已变化',409);
            const candidate=(await this.candidates({databasePath:this.db.path,conditions:JSON.parse(rule.conditions),entryId:job.entry_id,limit:1})).rows[0];
            if(!this.row(job.rule_id).enabled||!this.configMatches(rule))throw bad('AI 规则授权已变化',409);
            if(!candidate||!this.matches(job.entry_id,JSON.parse(rule.conditions),candidate))throw bad('文章不再匹配规则，未发送内容',409);
            const currentHash=jobHash(this.ai.previewAction(job.entry_id,rule.action_type));
            const changed=this.db.db.prepare(`UPDATE ai_rule_jobs SET source_hash=? WHERE ${fence}`).run(currentHash,...fenceArgs()).changes;
            if(!changed)throw bad('AI 规则任务已被新任务替代',409);
            sourceHash=currentHash;
            await this.ai.action(job.entry_id,rule.action_type);
            if(!this.row(job.rule_id).enabled||!this.configMatches(rule))throw bad('AI 规则授权已变化',409);
            if(jobHash(this.ai.previewAction(job.entry_id,rule.action_type))!==sourceHash)throw bad('正文已变化，请重试 AI 规则任务',409);
            this.db.db.prepare(`UPDATE ai_rule_jobs SET status='done',last_error=NULL,updated_at=? WHERE ${fence}`).run(new Date().toISOString(),...fenceArgs());
          });
        }catch(error){
          // A replacement queued while the model was waiting owns this row now.
          this.db.db.prepare(`UPDATE ai_rule_jobs SET status='failed',last_error=?,updated_at=? WHERE ${fence}`).run(String(error instanceof Error?error.message:error).slice(0,500),new Date().toISOString(),...fenceArgs());
        }
        return true;
      });
      if(!progressed)break;
    }
  }
}
