import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import PostalMime from 'postal-mime';
import type { RivuDatabase, EntryInput } from './database';
import { type SourceAdapter } from './source-adapter';
import {commitNewsletterScan} from './newsletter-scan';
import {feedWriteSnapshot,type FeedWriteInput} from './feed-write-task';
export type NewsletterMessage={name:string;raw:Uint8Array};
export type NewsletterResult={name:string;entry?:EntryInput&{hash:string;sender:string};error?:string};
export type NewsletterBatchParser=(messages:NewsletterMessage[])=>Promise<NewsletterResult[]>;
export type NewsletterScan={files:string[];records:{file:string;modified:number;size:number;failed:number}[];lastAudited?:string};
export async function parseNewsletterBatch(messages:NewsletterMessage[]):Promise<NewsletterResult[]>{
  const results:NewsletterResult[]=[];
  for(const message of messages)try{results.push({name:message.name,entry:await parseNewsletterMessage(message.raw)});}catch(error){results.push({name:message.name,error:error instanceof Error?error.message:String(error)});}
  return results;
}

const MAX_FILE=5_000_000, MAX_FOLDER_FILES=10_000, MAX_PER_REFRESH=500;
const MAX_UNCHANGED_AUDIT=50;
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const invalid=(message:string)=>Object.assign(Error(message),{statusCode:400});

function safeBody(html:string|undefined,text:string|undefined){
  if(!html)return text?`<p>${escape(text).replaceAll(/\r?\n/g,'<br>')}</p>`:'';
  const page=new JSDOM(html),document=page.window.document;
  try{
    document.querySelectorAll('script,style,link,base,meta,iframe,frame,object,embed,form,input,button,svg,math,picture,img,video,audio,source,track,canvas,noscript,template').forEach(node=>node.remove());
    for(const element of document.body.querySelectorAll('*')){
      const href=element.tagName==='A'?element.getAttribute('href'):null;
      for(const attribute of [...element.attributes])element.removeAttribute(attribute.name);
      if(href)try{const url=new URL(href);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)element.setAttribute('href',url.href);}catch{}
    }
    return document.body.innerHTML.slice(0,MAX_FILE);
  }finally{page.window.close();}
}

type NewsletterCandidate={directory:string;name:string};
type NewsletterParsed={mail:Awaited<ReturnType<typeof PostalMime.parse>>;rawHash:string};
export const newsletterSourceAdapter:SourceAdapter<string,NewsletterCandidate,Uint8Array,NewsletterParsed,EntryInput&{hash:string;sender:string}>={
  id:'newsletter',
  async discover(directory){
    const canonical=await realpath(directory),info=await stat(canonical);
    if(!info.isDirectory())throw invalid('请选择存放 .eml 邮件的文件夹');
    return (await filesInFolder(canonical)).map(name=>({directory:canonical,name}));
  },
  fetch(candidate){return readBoundedMessage(candidate.directory,candidate.name);},
  async parse(raw){return {mail:await PostalMime.parse(raw,{maxNestingDepth:30,maxHeadersSize:128_000,maxRfc822NestingDepth:4}),rawHash:hash(raw)};},
  normalize({mail,rawHash}){
  const sender=mail.from?.address||mail.sender?.address||'';
  const body=safeBody(mail.html,mail.text);
  if(!mail.subject?.trim()&&!body.trim())throw invalid('邮件没有主题或正文');
  const guid=mail.messageId?.trim()||rawHash,date=mail.date&&Date.parse(mail.date);
  return {guid,hash:hash(guid),title:mail.subject?.trim().slice(0,1000)||'无主题',author:(mail.from?.name||sender).slice(0,500),publishedAt:date?new Date(date).toISOString():'',content:body,description:(mail.text||'').slice(0,4000),sender};
  }
};
export async function parseNewsletterMessage(raw:Uint8Array):Promise<EntryInput&{hash:string;sender:string}>{
  const candidate={directory:'',name:''};
  return newsletterSourceAdapter.normalize(await newsletterSourceAdapter.parse(raw,candidate),candidate);
}

async function filesInFolder(directory:string){
  const entries=await readdir(directory,{withFileTypes:true});
  if(entries.length>MAX_FOLDER_FILES)throw invalid('目录文件超过 10000 个，请使用较小的 Newsletter 文件夹');
  return entries.filter(entry=>entry.isFile()&&/\.eml$/i.test(entry.name)).map(entry=>entry.name).sort();
}

async function readBoundedMessage(directory:string,name:string){
  const path=join(directory,name),before=await lstat(path);
  if(!before.isFile()||before.size>MAX_FILE)throw invalid('文件不是普通邮件或超过 5 MB');
  if(await realpath(path)!==path)throw invalid('邮件文件路径已变更');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.size>MAX_FILE||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw invalid('邮件文件已变更');
    const raw=await handle.readFile();
    const after=await lstat(path),closed=await handle.stat();
    if(raw.length>MAX_FILE||!after.isFile()||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||closed.size!==opened.size||closed.mtimeMs!==opened.mtimeMs)throw invalid('邮件文件读取期间已变更');
    return raw;
  }finally{await handle.close();}
}

export async function previewNewsletterFolder(directory:string,parse:NewsletterBatchParser=parseNewsletterBatch){
  const canonical=await realpath(directory),candidates=await newsletterSourceAdapter.discover(canonical);
  const files=candidates.map(candidate=>candidate.name),samples:{file:string;title:string;sender:string}[]=[];
  let skipped=0;
  for(const name of files.slice(0,20)){
    try{const [result]=await parse([{name,raw:await readBoundedMessage(canonical,name)}]);if(!result?.entry)throw Error(result?.error||'邮件解析结果无效');const entry=result.entry;samples.push({file:name,title:entry.title,sender:entry.sender});if(samples.length>=5)break;}catch(error){if((error as {resourceBusy?:boolean}).resourceBusy)throw error;skipped++;}
  }
  return {url:pathToFileURL(canonical).href,folder:canonical,count:files.length,samples,skipped};
}

export async function scanNewsletterFolder(db:RivuDatabase,feedId:string,parse:NewsletterBatchParser=parseNewsletterBatch,write?:(input:FeedWriteInput)=>Promise<{added:number;total:number}>){
  const feed=db.feed(feedId);
  if(!feed||feed.type!=='newsletter')throw Error('Newsletter 订阅不存在');
  if(!feed.folder_authorized)throw Error('请在设置中重新选择 Newsletter 文件夹后刷新');
  const authorizedDirectory=resolve(fileURLToPath(String(feed.url))),directory=await realpath(authorizedDirectory);
  if(directory!==authorizedDirectory)throw Object.assign(Error('Newsletter 文件夹路径已变更，请重新选择文件夹'),{statusCode:409});
  const candidates=await newsletterSourceAdapter.discover(directory),files=candidates.map(candidate=>candidate.name);
  const known=db.db.prepare('SELECT modified_ms,size FROM newsletter_files WHERE feed_id=? AND file_name=?');
  const records:NewsletterScan['records']=[],remember={run:(_id:string,file:string,modified:number,size:number,failed:number)=>records.push({file,modified,size,failed})};
  let batch:NewsletterMessage[]=[],batchBytes=0,totalBytes=0,outputBytes=0,budgetReached=false;
  const metadata=new Map<string,{modified:number;size:number}>();
  const flush=async()=>{if(!batch.length)return;let results:NewsletterResult[];try{results=await parse(batch);}catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{batchFailure:true});}if(results.length!==batch.length||results.some((result,i)=>result.name!==batch[i].name||(!result.entry&&!result.error)))throw Object.assign(Error('邮件解析结果无效'),{batchFailure:true});for(const result of results){const info=metadata.get(result.name)!;if(result.entry){const bytes=4096+Object.values(result.entry).reduce<number>((sum,value)=>sum+(typeof value==='string'?value.length*2:16),0);if(outputBytes+bytes>64*1024*1024){budgetReached=true;break;}outputBytes+=bytes;parsed.push({file:result.name,...info,entry:result.entry});}else remember.run(feedId,result.name,info.modified,info.size,1);}batch=[];batchBytes=0;};
  const read=async(name:string,modified:number,size:number)=>{if(JSON.stringify(feedWriteSnapshot(db.feed(feedId)||{}))!==JSON.stringify(feedWriteSnapshot(feed)))throw Object.assign(Error('Newsletter 文件夹或授权已变更'),{statusCode:409});if(totalBytes+size>32*1024*1024){budgetReached=true;return false;}if(await realpath(directory)!==authorizedDirectory)throw Object.assign(Error('Newsletter 文件夹路径已变更'),{statusCode:409});const raw=await readBoundedMessage(directory,name);totalBytes+=raw.byteLength;if(batch.length>=20||batchBytes+raw.byteLength>8*1024*1024)await flush();if(budgetReached)return false;metadata.set(name,{modified,size});batch.push({name,raw});batchBytes+=raw.byteLength;return true;};
  const parsed:{file:string;modified:number;size:number;entry:EntryInput&{hash:string}}[]=[];
  const unchanged:string[]=[];
  let processed=0;
  for(const name of files){if(budgetReached)break;
    const path=join(directory,name);
    try{
      const info=await lstat(path),modified=Math.trunc(info.mtimeMs);
      const old=known.get(feedId,name) as {modified_ms:number;size:number}|undefined;
      if(old?.modified_ms===modified&&old.size===info.size){unchanged.push(name);continue;}
      if(processed>=MAX_PER_REFRESH)break;
      processed++;
      if(!info.isFile()||info.size>MAX_FILE){remember.run(feedId,name,modified,info.size,1);continue;}
      try{if(!await read(name,modified,info.size))break;}
      catch(error){if((error as {statusCode?:number;resourceBusy?:boolean}).statusCode===409||(error as {resourceBusy?:boolean}).resourceBusy||(error as {batchFailure?:boolean}).batchFailure)throw error;remember.run(feedId,name,modified,info.size,1);continue;}
    }catch(error){if((error as {statusCode?:number;resourceBusy?:boolean}).statusCode===409||(error as {resourceBusy?:boolean}).resourceBusy||(error as {batchFailure?:boolean}).batchFailure)throw error;/* Removed files retry next refresh. */}
  }
  await flush();
  const auditKey=`newsletter_audit:${feedId}`;
  const lastAudit=(db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(auditKey) as {value:string}|undefined)?.value||'';
  const nextAuditIndex=Math.max(0,unchanged.findIndex(name=>name>lastAudit));
  const auditOrder=[...unchanged.slice(nextAuditIndex),...unchanged.slice(0,nextAuditIndex)];
  let lastAudited:string|undefined;
  const auditAttempted:string[]=[];
  for(const name of (budgetReached?[]:auditOrder).slice(0,Math.min(MAX_UNCHANGED_AUDIT,MAX_PER_REFRESH-processed))){
    auditAttempted.push(name);
    try{
      const info=await lstat(join(directory,name)),modified=Math.trunc(info.mtimeMs);
      processed++;
      if(!info.isFile()||info.size>MAX_FILE){remember.run(feedId,name,modified,info.size,1);continue;}
      try{if(!await read(name,modified,info.size))break;}
      catch(error){if((error as {statusCode?:number;resourceBusy?:boolean}).statusCode===409||(error as {resourceBusy?:boolean}).resourceBusy||(error as {batchFailure?:boolean}).batchFailure)throw error;remember.run(feedId,name,modified,info.size,1);}
    }catch(error){if((error as {statusCode?:number;resourceBusy?:boolean}).statusCode===409||(error as {resourceBusy?:boolean}).resourceBusy||(error as {batchFailure?:boolean}).batchFailure)throw error;}
  }
  await flush();
  if(await realpath(directory)!==authorizedDirectory)throw Object.assign(Error('Newsletter 文件夹路径已变更，请重新选择文件夹'),{statusCode:409});
  if(db.feed(feedId)?.url!==feed.url||!db.feed(feedId)?.folder_authorized)throw Error('Newsletter 文件夹已变更，请重新刷新');
  for(const item of parsed)remember.run(feedId,item.file,item.modified,item.size,0);
  const handled=new Set(records.map(record=>record.file));
  for(const name of auditAttempted){if(!handled.has(name))break;lastAudited=name;}
  if(write)return {...await write({databasePath:db.path,expected:feedWriteSnapshot(feed),items:parsed.map(item=>item.entry),newsletter:{files,records,lastAudited}}),failed:0};
  db.db.exec('BEGIN IMMEDIATE');let added:number;
  try{added=db.addEntries(feedId,parsed.map(item=>item.entry),true);commitNewsletterScan(db,feedId,{files,records,lastAudited});db.db.exec('COMMIT');}catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
  const failed=(db.db.prepare('SELECT count(*) count FROM newsletter_files WHERE feed_id=? AND failed=1').get(feedId) as {count:number}).count;
  return {added,total:parsed.length,failed};
}
