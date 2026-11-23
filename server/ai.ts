import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { parseFilterSuggestion } from './ai-filter';
import { parseTagSuggestions } from './ai-tags';
import { aiPlainText } from './ai-text';
import type { RivuDatabase } from './database';
import { LocalLogs, logErrorType } from './local-logs';
import { directFetch } from './direct-fetch';
import { excerptParagraphs, fitText, messagesCost, textCost, type AITextResult } from './ai-context';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {AIBodyInput,AIBodyResult} from './ai-scan-task';
import {readAIResponse,decodeAIProviderResponse,AI_RESPONSE_BYTES,AI_MODELS_BYTES,type AIProviderKind,type AIProviderReply} from './ai-provider-response';
type PreparedBody={title:string;html:string;body:string;bytes:number;revision:string;cacheKey?:string;paragraphs?:string[]};

type AISettings={baseUrl:string;apiKey:string;credentialId:string;model:string;temperature:number;maxTokens:number;contextLength:number;summaryModel?:string;translationModel?:string;askModel?:string;tagModel?:string;customPrompt?:string;filterCriteria?:string};
export type AIActionType='summary'|'translation'|'ask'|'keywords'|'classification'|'explain'|'rewrite'|'custom'|'tags'|'filter';
type ChatSource={index:number;entryId:string;title:string;excerpt:string};
type Conversation={id:string;title:string;entry_ids:string;created_at:string;updated_at:string};
type ChatMessage={id:string;conversation_id:string;role:'user'|'assistant';content:string;citations:string;provider:string|null;model:string|null;created_at:string};
const defaults:AISettings={baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',credentialId:'',model:'',temperature:0.3,maxTokens:1200,contextLength:0};
const PROMPT_VERSION='v2';
const bad=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const articlePrompt=(title:string,body:string,question?:string)=>`标题：${title}\n\n正文：\n${body}${question?`\n\n问题：${question}`:''}`;
const actionSystem=(type:AIActionType,language:string,customPrompt='',filterCriteria='')=>type==='filter'?`根据用户过滤条件审阅文章：${filterCriteria}。只返回JSON对象：{"decision":"keep或mute或block","reason":"正文依据"}。reason最多400字。keep表示保留，mute表示退出收件箱但保留全部文章，block表示进入已屏蔽视图。缺乏依据时选择keep；不要输出Markdown或额外字段。`:type==='tags'?'根据文章建议最多8个标签。只返回JSON对象：{"tags":[{"name":"标签名","reason":"正文依据"}]}。标签名最多40字，依据最多240字；没有依据时返回空tags数组。不要返回Markdown或额外字段。':type==='explain'?'解释文章中的关键概念、推理和背景。区分正文事实与解释，缺少证据时明确说明，不编造事实。':type==='rewrite'?'将文章改写为简明易读的简体中文草稿，保留事实和原意，不增加正文没有的结论。结果供用户审阅，不替换原文。':type==='custom'?customPrompt:type==='summary'?'用简体中文概括文章，给出关键事实和结论，保持客观，不补造信息。':type==='translation'?`将文章完整翻译成${language}，保留原意和段落，不添加解释。`:type==='keywords'?'根据文章列出最多 8 个有证据的主题关键词，以逗号分隔。不要加入正文没有的概念。':type==='classification'?'为文章给出一个简短的主题分类，并用一句话说明正文中的依据。不要编造事实。':'根据给定文章回答用户问题。若文章没有相关信息，明确说明；不要补造事实。';
const chatSystem='你是本地阅读助手。只根据本轮提供的文章摘录回答，引用事实时在句末标出对应编号如 [1]。没有证据时明确说明，不得编造引文。';

export class AIService {
  private resultRevision=0;
  resultsRevision(){return this.resultRevision;}
  private settings:AISettings;
  private settingsError:Error|null=null;
  private activeChats=new Set<string>();
  private firstChatRequests=new Map<string,Promise<ReturnType<AIService['getConversation']>>>();
  private activeActions=new Map<string,Promise<{content:string;cached:boolean}>>();
  private consentSecret=randomUUID();
  private prepared=new AsyncLocalStorage<Map<string,PreparedBody>>();
  private bodyCache=new Map<string,PreparedBody>();
  private bodyAliases=new Map<string,{revision:string;title:string;key:string;bytes:number}>();
  private cacheBytes=0;
  private retainedBytes=0;
  async withPreparedBodies<T>(rawIds:unknown,action:()=>T|Promise<T>,replay?:()=>{value:T|Promise<T>}|undefined):Promise<T>{
    this.requireSettings();
    if(!this.parseText||!Array.isArray(rawIds)||!rawIds.length||rawIds.length>20||rawIds.some(id=>typeof id!=='string'||!id))return action();
    const settings=this.settings,rows=new Map<string,PreparedBody>(),ids=[...new Set(rawIds as string[])],missing:string[]=[];let bytes=0;
    for(const id of ids){
      const alias=this.bodyAliases.get(id),identity=alias?this.db.aiBodyIdentity(id):undefined,cached=alias?this.bodyCache.get(alias.key):undefined;
      if(alias&&cached&&identity?.body_revision===alias.revision&&identity.title===alias.title){
        const cost=256+2*(cached.html.length+identity.title.length);bytes+=cost;rows.set(id,{...cached,title:identity.title,revision:identity.body_revision,bytes:cost,cacheKey:alias.key});
        this.bodyCache.delete(alias.key);this.bodyCache.set(alias.key,cached);
      }else{
        if(alias)this.removeBodyAlias(id);
        if(this.readBodies){missing.push(id);continue;}
        const entry=this.db.aiBodySnapshot(id);if(!entry)throw bad('文章不存在',404);const html=entry.html,cost=256+2*(html.length+entry.title.length);bytes+=cost;rows.set(id,{title:entry.title,html,body:'',bytes:cost,revision:entry.body_revision});
      }
    }
    if(this.retainedBytes+bytes>64*1024*1024)throw Object.assign(bad('AI 正文准备繁忙，请稍后重试',503),{resourceBusy:true});
    this.retainedBytes+=bytes;
    const check=()=>{for(const [id,row] of rows){const current=this.db.aiBodyIdentity(id);if(!current)throw bad('文章已删除',404);if(current.title!==row.title||current.body_revision!==row.revision)throw bad('正文已变化，请重新预览发送范围',409);}};
    try{
      if(missing.length){
        try{await this.waitWithoutMain(async()=>{
          const snapshots=await this.readBodies!({operation:'bodies',databasePath:this.db.path,entryIds:missing,maxBytes:64*1024*1024-this.retainedBytes});
          if(!snapshots||!Array.isArray(snapshots.rows)||snapshots.rows.length!==missing.length)throw bad('正文读取结果无效',503);
          const incoming=new Map<string,PreparedBody>();let cost=0;
          for(let i=0;i<missing.length;i++){
            const entry=snapshots.rows[i];
            if(!entry||entry.id!==missing[i]||typeof entry.title!=='string'||typeof entry.html!=='string'||typeof entry.body_revision!=='string'||!/^[0-9a-f]{32}$/.test(entry.body_revision))throw bad('正文读取结果无效',503);
            const size=256+2*(entry.html.length+entry.title.length);cost+=size;incoming.set(entry.id,{title:entry.title,html:entry.html,body:'',bytes:size,revision:entry.body_revision});
          }
          if(snapshots.bytes!==cost)throw bad('正文读取结果无效',503);
          if(this.retainedBytes+cost>64*1024*1024)throw Object.assign(bad('AI 正文准备繁忙，请稍后重试',503),{resourceBusy:true});
          // Reserve accepted results before waiting to regain a main lease.
          this.retainedBytes+=cost;bytes+=cost;for(const [id,row] of incoming)rows.set(id,row);
        });}catch(error){const duplicate=replay?.();if(duplicate)return await duplicate.value;throw error;}
        const duplicate=replay?.();if(duplicate)return await duplicate.value;
        check();const ordered=ids.map(id=>[id,rows.get(id)!] as const);rows.clear();for(const [id,row] of ordered)rows.set(id,row);
      }
      for(const [id,row] of rows){
        let cacheKey:string;
        try{cacheKey=row.cacheKey??(this.hashText?await this.waitWithoutMain(()=>this.hashText!(row.html)):digest(row.html));}
        catch(error){const duplicate=replay?.();if(duplicate)return await duplicate.value;throw error;}
        const duplicate=replay?.();if(duplicate)return await duplicate.value;check();
        if(!/^[0-9a-f]{64}$/.test(cacheKey))throw bad('正文哈希结果无效',503);
        const cached=this.bodyCache.get(cacheKey);
        if(cached&&cached.html===row.html){row.body=cached.body;row.paragraphs=cached.paragraphs;this.bodyCache.delete(cacheKey);this.bodyCache.set(cacheKey,cached);}
        else{
          try{const parsed=await this.waitWithoutMain(()=>this.parseText!(row.html));if(typeof parsed==='string'){row.body=parsed;row.paragraphs=excerptParagraphs(parsed);}else{row.body=parsed.body;row.paragraphs=parsed.paragraphs;}}catch(error){const duplicate=replay?.();if(duplicate)return await duplicate.value;throw error;}
          const duplicate=replay?.();if(duplicate)return await duplicate.value;check();const stored={...row,bytes:row.bytes+row.body.length*2+128+(row.paragraphs?.reduce((bytes,part)=>bytes+part.length*2,0)||0)};
          if(stored.bytes<=16*1024*1024){this.removeCachedBody(cacheKey);this.makeBodyCacheRoom(stored.bytes);this.bodyCache.set(cacheKey,stored);this.cacheBytes+=stored.bytes;}
        }
        if(this.bodyCache.has(cacheKey))this.rememberBodyAlias(id,row,cacheKey);
      }
      const duplicate=replay?.();if(duplicate)return await duplicate.value;
      check();if(this.settings!==settings)throw bad('AI 设置已变化，请重新预览发送范围',409);return await this.prepared.run(rows,action);
    }finally{this.retainedBytes-=bytes;}
  }
  private removeBodyAlias(id:string){const alias=this.bodyAliases.get(id);if(alias){this.cacheBytes-=alias.bytes;this.bodyAliases.delete(id);}}
  private removeCachedBody(key:string){const cached=this.bodyCache.get(key);if(cached){this.cacheBytes-=cached.bytes;this.bodyCache.delete(key);}for(const [id,alias] of this.bodyAliases)if(alias.key===key)this.removeBodyAlias(id);}
  private makeBodyCacheRoom(bytes:number){while(this.cacheBytes+bytes>16*1024*1024&&this.bodyCache.size)this.removeCachedBody(this.bodyCache.keys().next().value!);}
  private rememberBodyAlias(id:string,row:PreparedBody,key:string){
    this.removeBodyAlias(id);while(this.bodyAliases.size>=256)this.removeBodyAlias(this.bodyAliases.keys().next().value!);
    const bytes=128+2*(id.length+row.title.length+row.revision.length+key.length);
    // An alias must not evict the body it would point to.
    if(this.cacheBytes+bytes<=16*1024*1024){this.bodyAliases.set(id,{revision:row.revision,title:row.title,key,bytes});this.cacheBytes+=bytes;}
  }
  constructor(private db:RivuDatabase,private path?:string,private logs?:LocalLogs,private parseText?:(html:string)=>Promise<string|AITextResult>,private waitWithoutMain:<T>(action:()=>Promise<T>)=>Promise<T>=async action=>action(),private hashText?:(html:string)=>Promise<string>,private readBodies?:(input:AIBodyInput)=>Promise<AIBodyResult>,private parseProvider?:(text:string,kind:AIProviderKind)=>Promise<AIProviderReply>){this.settings={...defaults,credentialId:randomUUID()};this.readSettings();}
  private settingsDocument():Record<string,unknown>{
    if(!this.path)return {};
    let value:unknown;try{value=JSON.parse(readFileSync(this.path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('设置文件格式无效');return value as Record<string,unknown>;
  }
  private readSettings(){
    if(!this.path)return;
    try{
      const document=this.settingsDocument(),raw=document.ai;
      if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw Error('AI 配置格式无效');
      const {credentialId,...patch}=(raw||{}) as Partial<AISettings>;
      if(credentialId!==undefined&&(typeof credentialId!=='string'||credentialId.length>200))throw Error('AI 凭据标识无效');
      const base={...defaults,credentialId:this.settings.credentialId},next=this.candidate(patch,base);
      next.credentialId=credentialId||((next.apiKey===this.settings.apiKey)?this.settings.credentialId:randomUUID());
      if(JSON.stringify(next)!==JSON.stringify(this.settings)){this.settings=next;this.resultRevision++;}
      this.settingsError=null;
    }catch{this.settingsError=bad('AI 配置读取失败，请修复本地设置文件后重新加载；原文件已保留，AI 请求已暂停',409);}
  }
  private requireSettings(){if(this.settingsError)throw this.settingsError;}
  private settingsView(){const {apiKey,credentialId,...rest}=this.settings;return {...rest,apiKeyConfigured:!!apiKey};}
  publicSettings(){this.readSettings();this.requireSettings();return this.settingsView();}
  credentialIdentity(){this.requireSettings();return this.settings.credentialId;}
  authorizationIdentity(){this.requireSettings();return this.settings.contextLength?digest(JSON.stringify({credentialId:this.settings.credentialId,contextLength:this.settings.contextLength})):this.settings.credentialId;}
  persistCredentialIdentity(){if(this.path)this.configure({});}
  private candidate(patch:Partial<AISettings>,base:AISettings=this.settings){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw bad('AI 设置无效');
    const allowed=['baseUrl','apiKey','model','temperature','maxTokens','contextLength','summaryModel','translationModel','askModel','tagModel','customPrompt','filterCriteria'];
    if(Object.keys(patch).some(key=>!allowed.includes(key)))throw bad('AI 设置包含未知字段');
    if(patch.baseUrl!==undefined){if(typeof patch.baseUrl!=='string'||patch.baseUrl.length>2048)throw bad('AI 地址无效');let url:URL;try{url=new URL(patch.baseUrl);}catch{throw bad('AI 地址无效');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw bad('AI 地址必须是无凭据、无查询参数的 HTTP/HTTPS');}
    for(const key of ['apiKey','model','summaryModel','translationModel','askModel','tagModel'] as const){const value=patch[key];if(value!==undefined&&(typeof value!=='string'||value.length>(key==='apiKey'?4096:200)))throw bad('AI 设置文本字段无效');}
    if(patch.temperature!==undefined&&(!Number.isFinite(patch.temperature)||patch.temperature<0||patch.temperature>2))throw bad('Temperature 应在 0 至 2 之间');
    if(patch.maxTokens!==undefined&&(!Number.isInteger(patch.maxTokens)||patch.maxTokens<1||patch.maxTokens>32000))throw bad('Max Tokens 应在 1 至 32000 之间');
    if(patch.customPrompt!==undefined&&(typeof patch.customPrompt!=='string'||patch.customPrompt.length>4000))throw bad('自定义提示词应不超过 4000 字');
    if(patch.filterCriteria!==undefined&&(typeof patch.filterCriteria!=='string'||patch.filterCriteria.length>1000))throw bad('AI过滤条件应不超过1000字');
    const nextKey=patch.apiKey===undefined?base.apiKey:patch.apiKey;
    const next={...base,...patch,apiKey:nextKey,credentialId:nextKey===base.apiKey?base.credentialId:randomUUID()};
    if(!Number.isInteger(next.contextLength)||next.contextLength!==0&&(next.contextLength<1024||next.contextLength>262144))throw bad('Context Length 应为 0 或 1024 至 262144 的整数');
    if(next.contextLength&&next.maxTokens+512>=next.contextLength)throw bad('上下文预算须大于 Max Tokens 加 512 的预留空间');
    return next;
  }
  configure(patch:Partial<AISettings>){
    this.publicSettings();
    const next=this.candidate(patch);
    if(this.path){
      mkdirSync(dirname(this.path),{recursive:true});
      const content=this.settingsDocument();
      const temp=`${this.path}.${randomUUID()}.tmp`;
      const descriptor=openSync(temp,'wx');
      try{try{writeFileSync(descriptor,JSON.stringify({...content,ai:next},null,2),'utf8');}finally{closeSync(descriptor);}renameSync(temp,this.path);}
      catch(error){try{rmSync(temp,{force:true});}catch{}throw error;}
    }
    if(JSON.stringify(next)!==JSON.stringify(this.settings)){this.settings=next;this.resultRevision++;}
    return this.settingsView();
  }
  async test(patch:Partial<AISettings>={}){this.publicSettings();return this.waitWithoutMain(async()=>{this.requireSettings();const settings=this.candidate(patch),start=Date.now();const response=await directFetch(`${settings.baseUrl.replace(/\/+$/,'')}/models`,{headers:{Authorization:`Bearer ${settings.apiKey||'local'}`},signal:AbortSignal.timeout(15000)});if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error(`AI 服务返回 HTTP ${response.status}`);}const text=await readAIResponse(response,AI_MODELS_BYTES),data=this.parseProvider?await this.parseProvider(text,'models'):decodeAIProviderResponse(text,'models');return {ok:true,model:settings.model||data.model||'',latencyMs:Date.now()-start};});}
  private async complete(messages:{role:'system'|'user'|'assistant';content:string}[],model:string,settings:AISettings=this.settings){return this.waitWithoutMain(async()=>{this.requireSettings();if(settings.contextLength&&messagesCost(messages)+settings.maxTokens>settings.contextLength)throw bad('上下文预算不足，未发送内容；请重新预览或提高 Context Length');if(!model)throw bad('请先在设置中填写 AI 模型');const response=await directFetch(`${settings.baseUrl.replace(/\/+$/,'')}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.apiKey||'local'}`},body:JSON.stringify({model,temperature:settings.temperature,max_tokens:settings.maxTokens,messages}),signal:AbortSignal.timeout(120000)});if(!response.ok){const message=(await readAIResponse(response,4096,true)).slice(0,300);throw Error(`AI 请求失败 HTTP ${response.status}: ${message}`);}const text=await readAIResponse(response,AI_RESPONSE_BYTES),data=this.parseProvider?await this.parseProvider(text,'completion'):decodeAIProviderResponse(text,'completion');const content=data.content;if(!content)throw Error('AI 返回空内容');return content;});}
  private entryBody(entryId:string){
    if(this.parseText){const entry=this.db.aiBodyIdentity(entryId);if(!entry)throw bad('文章不存在',404);const row=this.prepared.getStore()?.get(entryId);if(!row||row.revision!==entry.body_revision||row.title!==entry.title)throw bad('正文未准备或已变化，请重新预览发送范围',409);return {entry,body:row.body,paragraphs:row.paragraphs};}
    const entry=this.db.entry(entryId) as {id:string;title:string;full_content?:string;content?:string;description?:string}|undefined;if(!entry)throw bad('文章不存在',404);return {entry,body:aiPlainText(entry.full_content||entry.content||entry.description||'')};
  }
  modelFor(type:AIActionType){
    this.requireSettings();
    if(type==='summary')return this.settings.summaryModel||this.settings.model;
    if(type==='translation')return this.settings.translationModel||this.settings.model;
    if(type==='keywords'||type==='classification'||type==='tags')return this.settings.tagModel||this.settings.askModel||this.settings.model;
    return this.settings.askModel||this.settings.model;
  }
  private actionContext(entryId:string,type:AIActionType,language:string,question?:string){
    const {entry,body}=this.entryBody(entryId);if(!body)throw bad('这篇文章没有可供处理的正文');
    if(type==='custom'&&!this.settings.customPrompt?.trim())throw bad('请先在AI设置中保存自定义提示词');
    if(type==='filter'&&!this.settings.filterCriteria?.trim())throw bad('请先在AI设置中保存过滤条件');
    const model=this.modelFor(type),limit=this.settings.contextLength;
    const baseCost=messagesCost([{role:'system',content:actionSystem(type,language,this.settings.customPrompt,this.settings.filterCriteria)},{role:'user',content:articlePrompt(entry.title,'',question)}]);
    const sentBody=limit?fitText(body,limit-this.settings.maxTokens-baseCost):body.slice(0,40000);
    if(!sentBody)throw bad('上下文预算不足以发送正文，请提高 Context Length 或减少 Max Tokens');
    return {entry,body:sentBody,model,truncated:sentBody.length<body.length,hash:digest(JSON.stringify({title:entry.title,body:sentBody,language,type,temperature:this.settings.temperature,maxTokens:this.settings.maxTokens,...(type==='custom'?{customPrompt:this.settings.customPrompt}:{}),...(type==='filter'?{filterCriteria:this.settings.filterCriteria}:{}),...(limit?{contextLength:limit}:{})}))};
  }
  previewAction(entryId:string,type:AIActionType,language='zh-CN'){const {entry,body,model,hash,truncated}=this.actionContext(entryId,type,language);return {entryId,title:entry.title,body,systemPrompt:actionSystem(type,language,this.settings.customPrompt,this.settings.filterCriteria),prompt:articlePrompt(entry.title,body),hash,promptVersion:PROMPT_VERSION,provider:this.settings.baseUrl,model,chars:body.length,truncated,contextLength:this.settings.contextLength};}
  previewManualAction(entryId:string,type:unknown,language='zh-CN'){
    if(typeof type!=='string'||!['summary','translation','keywords','classification','explain','rewrite','custom','tags','filter'].includes(type))throw bad('不支持的 AI 预览动作');
    const preview=this.previewAction(entryId,type as AIActionType,language);
    return {...preview,scopeHash:createHmac('sha256',this.consentSecret).update(JSON.stringify({entryId,type,language,hash:preview.hash,provider:preview.provider,model:preview.model,credential:this.settings.apiKey,promptVersion:preview.promptVersion})).digest('hex')};
  }
  actionWithPreview(entryId:string,type:unknown,language:string|undefined,scopeHash:unknown){
    const preview=this.previewManualAction(entryId,type,language);
    if(typeof scopeHash!=='string'||scopeHash!==preview.scopeHash)throw bad('正文或 AI 设置已变化，请重新预览发送范围',409);
    return this.action(entryId,type as AIActionType,language);
  }
  async action(entryId:string,type:AIActionType,language='zh-CN',question?:string){if(!['summary','translation','ask','keywords','classification','explain','rewrite','custom','tags','filter'].includes(type))throw bad('不支持的 AI 动作');if(type==='ask'&&(!question?.trim()||question.length>1000))throw bad('问题应为 1 至 1000 字');const {entry,body,model,hash}=this.actionContext(entryId,type,language,type==='ask'?question:undefined),settings={...this.settings};if(type!=='ask'){const cached=this.db.validAIResult(entryId,type,language,settings.baseUrl,model,hash,PROMPT_VERSION) as {content:string}|undefined;if(cached){if(type==='tags')parseTagSuggestions(cached.content);if(type==='filter')parseFilterSuggestion(cached.content);return {content:cached.content,cached:true};}}
    const actionKey=type==='ask'?'':digest(JSON.stringify({entryId,type,language,provider:settings.baseUrl,model,hash,credentialHash:digest(settings.apiKey),promptVersion:PROMPT_VERSION}));
    if(actionKey){const active=this.activeActions.get(actionKey);if(active)return this.waitWithoutMain(()=>active);}
    const perform=async()=>{
    const system=actionSystem(type,language,settings.customPrompt,settings.filterCriteria);
    const prompt=articlePrompt(entry.title,body,type==='ask'?String(question||'').slice(0,1000):undefined);
    const started=Date.now();
    try{let content=await this.complete([{role:'system',content:system},{role:'user',content:prompt}],model,settings);if(type==='tags')content=JSON.stringify({tags:parseTagSuggestions(content)});if(type==='filter')content=JSON.stringify(parseFilterSuggestion(content));if(type!=='ask'){
      let cacheCurrent=false;
      try{const current=this.actionContext(entryId,type,language);cacheCurrent=this.settings.baseUrl!==settings.baseUrl||current.model!==model||(current.hash===hash&&this.settings.credentialId===settings.credentialId);}catch{/* The entry was removed while the request was in flight. */}
      if(cacheCurrent){this.db.saveAI(entryId,type,language,settings.baseUrl,model,content,hash,PROMPT_VERSION);this.resultRevision++;}
    }void this.logs?.write('ai','action',{action:type,outcome:'ok',durationMs:Date.now()-started}).catch(()=>{});return {content,cached:false};}
    catch(error){void this.logs?.write('ai','action',{action:type,outcome:'failed',errorType:logErrorType(error),durationMs:Date.now()-started}).catch(()=>{});throw error;}
    };
    if(!actionKey)return perform();
    const active=perform();this.activeActions.set(actionKey,active);
    try{return await active;}finally{if(this.activeActions.get(actionKey)===active)this.activeActions.delete(actionKey);}
  }
  cached(entryId:string,type:string,language='zh-CN'){if(!['summary','translation','keywords','classification','explain','rewrite','custom','tags','filter'].includes(type))return null;try{const {model,hash,body,truncated}=this.actionContext(entryId,type as AIActionType,language);const result=this.db.validAIResult(entryId,type,language,this.settings.baseUrl,model,hash,PROMPT_VERSION);return result?{...result,body,truncated}:null;}catch{return null;}}
  tagSuggestions(entryId:string){
    const result=this.cached(entryId,'tags') as {content:string;content_hash:string;created_at:string;provider:string;model:string}|null;
    if(!result)return null;
    const tags=parseTagSuggestions(result.content);
    const reviewHash=createHmac('sha256',this.consentSecret).update(JSON.stringify({entryId,tags,hash:result.content_hash,createdAt:result.created_at,provider:result.provider,model:result.model,credential:this.settings.credentialId})).digest('hex');
    return {tags,reviewHash};
  }
  applyTagSuggestions(entryId:string,names:unknown,reviewHash:unknown,reconcile:(feedId:string)=>void){
    if(!Array.isArray(names)||names.length<1||names.length>8||names.some(name=>typeof name!=='string')||new Set(names).size!==names.length)throw bad('请选择1至8个不重复的候选标签');
    const review=this.tagSuggestions(entryId);
    if(!review||typeof reviewHash!=='string'||reviewHash!==review.reviewHash)throw bad('标签建议或正文已变化，请重新查看建议',409);
    if(names.some(name=>!review.tags.some(tag=>tag.name===name)))throw bad('只能应用当前建议中的标签');
    return this.db.appendEntryTagNames(entryId,names,reconcile);
  }
  filterReview(entryId:string){
    if(!this.db.entry(entryId))throw bad('文章不存在',404);
    const effect=this.db.filterDecision(entryId)||null;
    const undoHash=effect?createHmac('sha256',this.consentSecret).update(JSON.stringify({entryId,effect})).digest('hex'):null;
    const result=this.cached(entryId,'filter') as {content:string;content_hash:string;created_at:string;provider:string;model:string}|null;
    if(!result)return {effect,undoHash,suggestion:null,reviewHash:null};
    const suggestion=parseFilterSuggestion(result.content);
    const reviewHash=createHmac('sha256',this.consentSecret).update(JSON.stringify({entryId,suggestion,hash:result.content_hash,createdAt:result.created_at,provider:result.provider,model:result.model,credential:this.settings.credentialId,effect})).digest('hex');
    return {effect,undoHash,suggestion,reviewHash};
  }
  applyFilterSuggestion(entryId:string,reviewHash:unknown){
    const review=this.filterReview(entryId);
    if(!review.suggestion||typeof reviewHash!=='string'||reviewHash!==review.reviewHash)throw bad('过滤建议或本地状态已变化，请重新审阅',409);
    const context=this.actionContext(entryId,'filter','zh-CN');
    this.db.setFilterDecision(entryId,{...review.suggestion,criteria:this.settings.filterCriteria!,provider:this.settings.baseUrl,model:context.model,content_hash:context.hash});
    return this.filterReview(entryId);
  }
  undoFilter(entryId:string,undoHash:unknown){
    const current=this.filterReview(entryId);
    if(!current.effect||typeof undoHash!=='string'||undoHash!==current.undoHash)throw bad('本地过滤状态已变化，请重新读取',409);
    this.db.setFilterDecision(entryId,{decision:'keep',reason:'',criteria:'',provider:'',model:'',content_hash:''});
    return this.filterReview(entryId);
  }
  preview(rawIds:unknown,options:{question?:unknown;conversationId?:unknown}={}){
    if(!Array.isArray(rawIds)||rawIds.length<1||rawIds.length>10||rawIds.some(id=>typeof id!=='string'||!id)||new Set(rawIds).size!==rawIds.length)throw bad('请选择 1 至 10 篇不重复的文章');
    const entryIds=rawIds as string[],sources:ChatSource[]=[];let remaining=24000;
    const limit=this.settings.contextLength;
    const question=typeof options.question==='string'?options.question.trim():'';
    if(question.length>2000)throw bad('问题应为 1 至 2000 字');
    let history:{role:'user'|'assistant';content:string}[]=[];
    if(options.conversationId!==undefined){
      if(typeof options.conversationId!=='string')throw bad('对话标识无效');
      const conversation=this.conversation(options.conversationId);
      if(JSON.stringify(JSON.parse(conversation.entry_ids))!==JSON.stringify(entryIds))throw bad('对话文章范围不一致');
      history=(this.db.db.prepare('SELECT role,content FROM ai_messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(options.conversationId) as typeof history).reverse();
    }
    const articles=entryIds.map(entryId=>{const {entry,body,paragraphs:preparedParagraphs}=this.entryBody(entryId);const paragraphs=preparedParagraphs||excerptParagraphs(body);if(!paragraphs.length)throw bad(`“${entry.title}”没有可发送的本地正文`);return {entryId,title:entry.title,paragraphs};});
    let budget=limit?limit-this.settings.maxTokens-messagesCost([{role:'system',content:chatSystem},{role:'user',content:'本轮可用文章摘录：\n'},...history,{role:'user',content:question}]):Infinity;
    for(let round=0;round<5&&remaining>0&&sources.length<30;round++)for(let position=0;position<articles.length;position++){
      const article=articles[position];if(remaining<=0||sources.length>=30)break;const paragraph=article.paragraphs[round];if(!paragraph)continue;
      const overhead=textCost(`${sources.length?'\n\n':''}[${sources.length+1}] ${article.title}\n`);
      const share=round===0?Math.floor((budget-overhead)/(articles.length-position)):budget-overhead;
      const excerpt=fitText(paragraph.slice(0,Math.min(800,remaining)),share);
      if(!excerpt){if(round===0)throw bad('上下文预算不足以包含每篇文章，请减少所选文章或提高 Context Length');continue;}
      sources.push({index:sources.length+1,entryId:article.entryId,title:article.title,excerpt});remaining-=excerpt.length;budget-=overhead+textCost(excerpt);
    }
    const provider=this.settings.baseUrl,model=this.modelFor('ask'),temperature=this.settings.temperature,maxTokens=this.settings.maxTokens;
    const contextHash=createHmac('sha256',this.consentSecret).update(JSON.stringify({sources,provider,model,credentialId:this.settings.credentialId,temperature,maxTokens,promptVersion:PROMPT_VERSION,...(limit?{contextLength:limit,question,history,conversationId:options.conversationId}:{} )})).digest('hex');
    return {entryIds,sources,contextHash,totalChars:24000-remaining,provider,model,temperature,maxTokens,contextLength:limit,history};
  }
  conversations(){return (this.db.db.prepare('SELECT * FROM ai_conversations ORDER BY updated_at DESC LIMIT 100').all() as Conversation[]).map(row=>({...row,entryIds:JSON.parse(row.entry_ids) as string[]}));}
  private conversation(id:string){const row=this.db.db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(id) as Conversation|undefined;if(!row)throw bad('对话不存在',404);return row;}
  createConversation(rawIds:unknown){const preview=this.preview(rawIds),id=randomUUID(),now=new Date().toISOString(),title=preview.sources[0].title.slice(0,80);this.db.db.prepare('INSERT INTO ai_conversations(id,title,entry_ids,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,title,JSON.stringify(preview.entryIds),now,now);return this.getConversation(id);}
  async startConversation(rawIds:unknown,rawQuestion:unknown,confirmedHash:unknown,requestId?:unknown):Promise<ReturnType<AIService['getConversation']>>{
    if(requestId!==undefined&&(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)))throw bad('首次发送请求标识无效');
    if(!Array.isArray(rawIds)||rawIds.length<1||rawIds.length>10||rawIds.some(id=>typeof id!=='string'||!id)||new Set(rawIds).size!==rawIds.length)throw bad('请选择 1 至 10 篇不重复的文章');
    if(typeof rawQuestion!=='string'||!rawQuestion.trim()||rawQuestion.trim().length>2000)throw bad('问题应为 1 至 2000 字');
    if(typeof confirmedHash!=='string'||!/^[a-f0-9]{64}$/.test(confirmedHash))throw bad('发送范围确认无效',409);
    const question=rawQuestion.trim(),key=requestId===undefined?undefined:`ai_chat_request:${requestId}`;
    const fingerprint=digest(JSON.stringify({entryIds:rawIds,question,contextHash:confirmedHash}));
    if(key){
      const row=this.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key) as {value:string}|undefined;
      if(row){
        let record:{fingerprint:string;status:string;conversationId?:string};
        try{record=JSON.parse(row.value);}catch{throw bad('本地请求记录损坏，已停止重复发送',409);}
        if(!record||record.fingerprint!==fingerprint)throw bad('同一请求标识不能用于不同问题或发送范围',409);
        if(record.status==='completed'&&typeof record.conversationId==='string'){
          if(!this.db.db.prepare('SELECT id FROM ai_conversations WHERE id=?').get(record.conversationId))throw bad('该请求的本地对话已删除，不能重复生成',410);
          return this.getConversation(record.conversationId);
        }
        const active=this.firstChatRequests.get(key);
        if(record.status==='pending'&&active)return this.waitWithoutMain(()=>active);
        throw bad('上次请求未完成或结果不确定；已停止自动重发，请重新预览并明确发起新请求',409);
      }
    }
    return this.withPreparedBodies(rawIds,async()=>{
      if(key&&this.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key))return this.startConversation(rawIds,rawQuestion,confirmedHash,requestId);
    const preview=this.preview(rawIds,{question});
    if(confirmedHash!==preview.contextHash)throw bad('文章或 AI 设置已变化，请重新预览发送范围',409);
    const model=preview.model,settings={...this.settings};if(!model)throw bad('请先在设置中填写 AI 模型');
    const writeRecord=(status:string,conversationId?:string)=>{if(key)this.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify({fingerprint,status,...(conversationId?{conversationId}:{})}));};
    writeRecord('pending');
    const perform=async()=>{
      try{
        const {answer,citations}=await this.chatAnswer(preview,question,[],model,settings);
        const id=randomUUID(),now=new Date().toISOString(),title=preview.sources[0].title.slice(0,80);
        this.db.db.exec('BEGIN');try{
          this.db.db.prepare('INSERT INTO ai_conversations(id,title,entry_ids,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,title,JSON.stringify(preview.entryIds),now,now);
          this.insertChatMessages(id,question,answer,citations,preview.provider,model,now);
          writeRecord('completed',id);
          this.db.db.exec('COMMIT');
        }catch(error){this.db.db.exec('ROLLBACK');throw error;}
        return this.getConversation(id);
      }catch(error){writeRecord('failed');throw error;}
      finally{if(key)this.firstChatRequests.delete(key);}
    };
    const pending=perform();if(key)this.firstChatRequests.set(key,pending);
    return pending;
    },()=>key&&this.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?{value:this.startConversation(rawIds,rawQuestion,confirmedHash,requestId)}:undefined);
  }
  getConversation(id:string){const row=this.conversation(id);const messages=this.db.db.prepare('SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY created_at,id').all(id) as ChatMessage[];return {...row,entryIds:JSON.parse(row.entry_ids) as string[],messages:messages.map(message=>({...message,citations:JSON.parse(message.citations) as ChatSource[]}))};}
  deleteConversation(id:string){this.conversation(id);this.db.db.prepare('DELETE FROM ai_conversations WHERE id=?').run(id);return {deleted:1};}
  private async chatAnswer(preview:ReturnType<AIService['preview']>,question:string,old:{role:'user'|'assistant';content:string}[],model:string,settings:AISettings){
    const sourceText=preview.sources.map(source=>`[${source.index}] ${source.title}\n${source.excerpt}`).join('\n\n');
    const messages:{role:'system'|'user'|'assistant';content:string}[]=[{role:'system',content:chatSystem},{role:'user',content:`本轮可用文章摘录：\n${sourceText}`},...old.map(({role,content})=>({role,content})),{role:'user',content:question}];
    const started=Date.now();let answer:string;
    try{answer=await this.complete(messages,model,settings);void this.logs?.write('ai','chat',{action:'chat',outcome:'ok',durationMs:Date.now()-started}).catch(()=>{});}
    catch(error){void this.logs?.write('ai','chat',{action:'chat',outcome:'failed',errorType:logErrorType(error),durationMs:Date.now()-started}).catch(()=>{});throw error;}
    const numbers=[...answer.matchAll(/\[(\d{1,2})\]/g)].map(match=>Number(match[1]));
    return {answer,citations:preview.sources.filter(source=>numbers.includes(source.index))};
  }
  private insertChatMessages(id:string,question:string,answer:string,citations:ChatSource[],provider:string,model:string,now:string){
    this.db.db.prepare('INSERT INTO ai_messages(id,conversation_id,role,content,citations,provider,model,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,'user',question,'[]',null,null,now);
    this.db.db.prepare('INSERT INTO ai_messages(id,conversation_id,role,content,citations,provider,model,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),id,'assistant',answer,JSON.stringify(citations),provider,model,new Date(Date.parse(now)+1).toISOString());
  }
  async send(id:string,rawQuestion:unknown,confirmedHash:unknown,expectedLastMessageId:unknown){const conversation=this.conversation(id);if(typeof rawQuestion!=='string'||!rawQuestion.trim()||rawQuestion.trim().length>2000)throw bad('问题应为 1 至 2000 字');const preview=this.preview(JSON.parse(conversation.entry_ids),{question:rawQuestion,conversationId:id});if(confirmedHash!==preview.contextHash)throw bad('文章或 AI 设置已变化，请重新预览发送范围',409);const model=preview.model,settings={...this.settings};if(!model)throw bad('请先在设置中填写 AI 模型');const old=this.db.db.prepare('SELECT id,role,content FROM ai_messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(id) as {id:string;role:'user'|'assistant';content:string}[];
    if((old[0]?.id??null)!==expectedLastMessageId)throw bad('对话历史已变化，请重新打开后再发送',409);
    if(this.activeChats.has(id))throw bad('这段对话正在处理上一条问题，请稍后重试',409);
    this.activeChats.add(id);
    try{
    const {answer,citations}=await this.chatAnswer(preview,rawQuestion.trim(),old.reverse(),model,settings);
    const now=new Date().toISOString();this.db.db.exec('BEGIN');try{this.insertChatMessages(id,rawQuestion.trim(),answer,citations,preview.provider,model,now);this.db.db.prepare('UPDATE ai_conversations SET updated_at=? WHERE id=?').run(now,id);this.db.db.exec('COMMIT');}catch(error){this.db.db.exec('ROLLBACK');throw error;}return this.getConversation(id);
    }finally{this.activeChats.delete(id);}
  }
}




