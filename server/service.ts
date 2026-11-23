import {AIScanner} from './ai-scanner';
import Fastify from 'fastify';
import {FeedParser} from './feed-parser';
import {simpleArticleImageUrl} from './image-url-shape';
import {FeedWriter,validArchiveWriteResult} from './feed-writer';
import {bulkReadReceiptKey,validBulkReadWriteResult,type BulkReadWriteInput} from './bulk-read-write';
import {ArchiveReader} from './archive-reader';
import {EntryReader} from './entry-reader';
import {archivePage,validateArchiveRevision} from './archive-read';
import {ArchiveExporter} from './archive-exporter';
import {ArchiveSaver} from './archive-saver';
import type {ArchiveWriteInput} from './archive-write';
import {previewNewsletterFolder} from './newsletter';
import {WriteCoordinator} from './write-coordinator';
import {sourceIconKey} from './source-icons';
import { randomBytes, randomUUID } from 'node:crypto';
import { isRecoveredFeed, RivuDatabase, validateFetchInterval, type ReadScope } from './database';
import { discoverFeeds, refreshFeed, refreshFeedIcon } from './feeds';
import { previewCustomJson, validateJsonMapping } from './custom-json';
import { AIService } from './ai';
import { AIRuleService } from './ai-rules';
import { normalizeRsshubBase, previewRsshub, subscribeRsshub } from './rsshub';
import { fetchFullText } from './fulltext';
import { ImageCache } from './image-cache';
import { LocalReadingSettings } from './reading-settings';
import { LocalProxySettings } from './proxy-settings';
import { OfflineSaver } from './offline';
import { applyEnabledRules, applyRule, createRule, deleteRule, deleteTagAndReconcile, listRules, previewDraft, previewRule, undoRule, updateRule } from './rules';
import { createSmartFolder, deleteSmartFolder, getSmartFolder, listSmartFolders, updateSmartFolder } from './smart-folders';
import { isIP } from 'node:net';
import { privateAddress, requestBytes } from './network';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteArchive } from './archive';
import { AutoBackupManager } from './auto-backup';
import { DatabaseMaintenance } from './maintenance';
import { LocalLogs, logErrorType } from './local-logs';
import { changeFeeds, validateFeedCategoryChange, validateFeedDeleteChange } from './feed-bulk';
import type {FeedDeleteWriteInput} from './feed-delete-write';
import {feedCategoryReceiptKey,validFeedCategoryWriteResult,type FeedCategoryWriteInput} from './feed-category-write';
import {validateFeedPatch,type FeedMetadataWriteInput} from './feed-metadata-write';

export function createService(db:RivuDatabase, token=randomBytes(32).toString('hex'), settingsPath?:string, dataDir?:string, maintenanceWorkerPath=join(process.cwd(),'dist-server','maintenance-worker.cjs'),logs?:LocalLogs,feedParseWorkerPath=join(process.cwd(),'dist-server','feed-parse-worker.cjs'),feedParseTaskPath?:string,feedWriteWorkerPath=join(process.cwd(),'dist-server','feed-write-worker.cjs'),feedWriteTaskPath?:string,archiveExportWorkerPath=join(process.cwd(),'dist-server','archive-export-worker.cjs'),archiveExportTaskPath?:string,archiveReadWorkerPath=join(process.cwd(),'dist-server','archive-read-worker.cjs'),archiveReadTaskPath?:string,aiScanWorkerPath=join(process.cwd(),'dist-server','ai-scan-worker.cjs'),aiScanTaskPath?:string,entryReadWorkerPath=join(process.cwd(),'dist-server','entry-read-worker.cjs'),entryReadTaskPath?:string,imageParseTaskPath?:string){
  const feedParser=new FeedParser(feedParseWorkerPath,feedParseTaskPath,undefined,undefined,undefined,imageParseTaskPath);
  const feedParseAccess={feed:(...args:Parameters<typeof feedParser.parse>)=>feedParser.parse(...args),page:(...args:Parameters<typeof feedParser.parsePage>)=>feedParser.parsePage(...args)};
  const previewJson=(input:Parameters<typeof previewCustomJson>[0],authorize?:()=>void)=>previewCustomJson(input,(response,candidate)=>feedParser.parseJson(response,candidate),authorize);
  const feedWriter=new FeedWriter(feedWriteWorkerPath,feedWriteTaskPath),writes=new WriteCoordinator();
  const archiveExporter=new ArchiveExporter(archiveExportWorkerPath,archiveExportTaskPath);
  const archiveReader=new ArchiveReader(archiveReadWorkerPath,archiveReadTaskPath);
  const aiScanner=new AIScanner(aiScanWorkerPath,aiScanTaskPath);
  const entryReader=new EntryReader(entryReadWorkerPath,entryReadTaskPath,16,120000,32768);
  const entryDetailReader=new EntryReader(entryReadWorkerPath,entryReadTaskPath);
  const feedMetadataReader=new EntryReader(entryReadWorkerPath,entryReadTaskPath);
  const feedDeletePreviewReader=new EntryReader(entryReadWorkerPath,entryReadTaskPath);
  try{entryDetailReader.prestart();}catch(error){void logs?.write('error','entry_reader_start_failed',{errorType:logErrorType(error)}).catch(()=>{});}
  try{entryReader.prestart();}catch(error){void logs?.write('error','entry_list_reader_start_failed',{errorType:logErrorType(error)}).catch(()=>{});}
  const app=Fastify({logger:false,bodyLimit:2_000_000});
  const ai=new AIService(db,settingsPath,logs,html=>feedParser.aiContextText(html),writes.waitWithoutMain,html=>feedParser.aiDigest(html),input=>aiScanner.readBodies(input),(text,kind)=>feedParser.aiProviderJson(text,kind));
  const aiRules=new AIRuleService(db,ai,writes.withMain,input=>writes.waitWithoutMain(()=>aiScanner.read(input)));
  const images=new ImageCache(db,settingsPath,dataDir,writes.waitWithoutMain);
  const offline=new OfflineSaver(db,images,response=>feedParser.extractFullText(response),entry=>writes.waitWithoutMain(async()=>{
    if(typeof entry.body_revision==='string')try{
      const presence=await entryDetailReader.read({databasePath:db.path,kind:'image_presence',entryId:entry.id,bodyRevision:entry.body_revision,cover:entry.cover??null});
      if(presence===false)return [];
    }catch{} // Unavailable/custom readers fall back to the complete parser.
    return feedParser.imageUrls(entry);
  }),input=>writeFullText(input),writes.withMain);
  const archiveSaver=new ArchiveSaver(db,{withMain:writes.withMain,parseImages:(html,base)=>feedParser.archiveImages(html,base),write:input=>writeArchive(input)});
  const reading=new LocalReadingSettings(settingsPath);
  const proxySettings=new LocalProxySettings(settingsPath);
  const autoBackup=dataDir?new AutoBackupManager(db,dataDir,Date.now,writes.withMain):null;
  const maintenance=dataDir?new DatabaseMaintenance(db,dataDir,maintenanceWorkerPath):null;
  let maintenanceGate=false;
  const imageAvailabilityListeners=new Set<(available:boolean)=>void>();
  const notifyImageAvailability=()=>{for(const listener of imageAvailabilityListeners)try{listener(!maintenanceGate&&!stopping);}catch{}};
  const onImageAvailability=(listener:(available:boolean)=>void)=>{imageAvailabilityListeners.add(listener);listener(!maintenanceGate&&!stopping);return ()=>{imageAvailabilityListeners.delete(listener);};};
  const activeRequests=new Set<string>(),drainWaiters=new Set<()=>void>();
  let activeExternal=0;
  const signalDrained=()=>{if(activeRequests.size===0&&activeExternal===0){for(const resolve of drainWaiters)resolve();drainWaiters.clear();}};
  const waitForRequests=()=>activeRequests.size===0&&activeExternal===0?Promise.resolve():new Promise<void>(resolve=>drainWaiters.add(resolve));
  const imageMaintenance=new Map<string,{action:()=>void}>();
  const deferImageMaintenance=(url:string,action:()=>void)=>{
    const existing=imageMaintenance.get(url);if(existing){existing.action=action;return;}
    // LRU bookkeeping is best effort; bound retained callbacks during long writes.
    if(imageMaintenance.size>=1024)return;
    const pending={action};imageMaintenance.set(url,pending);activeExternal++;
    void writes.withMain(()=>{if(imageMaintenance.get(url)===pending)imageMaintenance.delete(url);pending.action();}).catch(error=>{void logs?.write('error','image_cache_bookkeeping_failed',{errorType:logErrorType(error)}).catch(()=>{});}).finally(()=>{if(imageMaintenance.get(url)===pending)imageMaintenance.delete(url);activeExternal--;signalDrained();});
  };
  async function withDatabaseAccess<T>(action:()=>Promise<T>|T):Promise<T>{
    if(stopping)throw Error('本地服务正在关闭');
    while(maintenanceGate)await maintenance?.wait();
    if(stopping)throw Error('本地服务正在关闭');
    activeExternal++;
    try{return await writes.withMain(action);}finally{activeExternal--;signalDrained();}
  }
  const readUndo=new Map<string,{invalidated:Set<string>;expiresAt:number}>();
  const readSessionId=randomUUID();let readUndoStored=false;
  type RefreshResult={added:number;total:number};
  const pending:{id:string;resolve:(result:RefreshResult)=>void;reject:(error:unknown)=>void}[]=[];
  const inFlight=new Map<string,Promise<RefreshResult>>();
  const deletingFeeds=new Set<string>();
  const imageChangingFeeds=new Map<string,number>(),imageChangingEntries=new Map<string,number>();
  async function withImageChange<T>(feeds:string[],entries:string[],action:()=>Promise<T>):Promise<T>{
    const scopes:[[Map<string,number>,string[]],[Map<string,number>,string[]]]=[[imageChangingFeeds,feeds],[imageChangingEntries,entries]];
    for(const [map,ids] of scopes)for(const id of ids)map.set(id,(map.get(id)||0)+1);
    try{return await action();}finally{for(const [map,ids] of scopes)for(const id of ids){const count=map.get(id)!-1;if(count)map.set(id,count);else map.delete(id);}}
  }
  const imageReplies=new Map<string,()=>void>();
  const iconUpdates=new Map<string,Promise<{updated:boolean}>>();
  let activeRefreshes=0;
  let stopping=false;
  const requestLeases=new Map<string,()=>void>(),activeHandlers=new Set<string>();
  const releaseRequestLease=(id:string)=>{requestLeases.get(id)?.();requestLeases.delete(id);};
  async function withoutRequestLease<T>(id:string,action:()=>Promise<T>):Promise<T>{
    const hadLease=requestLeases.has(id);releaseRequestLease(id);
    try{return await action();}finally{if(hadLease)requestLeases.set(id,await writes.enterMain());}
  }
  async function writeBulkRead(input:BulkReadWriteInput){
    readUndoStored=true;
    try{return await feedWriter.writeBulkRead(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown){
        const row=db.db.prepare('SELECT value FROM app_meta WHERE key=? AND length(CAST(value AS BLOB))<=4096').get(bulkReadReceiptKey(readSessionId)) as {value:string}|undefined;
        if(row)try{const receipt=JSON.parse(row.value);if(receipt.operationId===failure.operationId&&receipt.kind===input.kind&&validBulkReadWriteResult(receipt.result))return receipt.result;}catch{}
        readUndo.clear();throw Object.assign(Error('批量阅读状态提交结果待核验，请重新读取后确认'),{statusCode:503});
      }
      throw error;
    }
  }
  const writeFeedCategory=async(input:FeedCategoryWriteInput)=>writes.withWorker(async()=>{
    try{return await feedWriter.writeFeedCategory(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown){
        const row=db.db.prepare('SELECT value FROM app_meta WHERE key=? AND length(CAST(value AS BLOB))<=4096').get(feedCategoryReceiptKey) as {value:string}|undefined;
        if(failure.operationId&&row)try{const receipt=JSON.parse(row.value);if(receipt.operationId===failure.operationId&&validFeedCategoryWriteResult(receipt.result,input.change.ids.length))return receipt.result;}catch{}
        throw Object.assign(Error('分类调整提交结果待核验，请重新读取订阅后确认'),{statusCode:503});
      }
      throw error;
    }
  });
  const writeFeedDelete=async(input:FeedDeleteWriteInput)=>writes.withWorker(async()=>{
    try{return await feedWriter.writeFeedDelete(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown){
        if(failure.operationId)try{
          const recovered=await feedWriter.readFeedDeleteReceipt({kind:'feed_delete_receipt',databasePath:db.path,change:input.change,expectedOperationId:failure.operationId});
          if(recovered.found)return recovered;
        }catch{}
        throw Object.assign(Error('订阅删除提交结果待核验，请重新读取订阅后确认'),{statusCode:503});
      }
      throw error;
    }
  });
  const writeFeedMetadata=async(input:FeedMetadataWriteInput)=>withImageChange(input.kind==='feed_patch'&&input.patch.allowPrivate!==undefined?[input.id]:[],[],()=>writes.withWorker(async()=>{
    try{return await feedWriter.writeFeedMetadata(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown){
        if(failure.operationId)try{
          const recovered=await feedWriter.readFeedMetadataReceipt({kind:'feed_metadata_receipt',databasePath:db.path,id:input.id,targetKind:input.kind,expectedOperationId:failure.operationId});
          if(recovered.found)return recovered;
        }catch{}
        throw Object.assign(Error('订阅或分类修改结果待核验，请重新读取后确认'),{statusCode:503});
      }
      throw error;
    }
  }));
  const writeBatch=async(input:Parameters<FeedWriter['write']>[0])=>withImageChange([String(input.expected.id)],[],()=>writes.withWorker(async()=>{
    try{return await feedWriter.write(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown&&failure.operationId){
        const row=db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`feed-write:${input.expected.id}`) as {value:string}|undefined;
        if(row)try{const receipt=JSON.parse(row.value);if(receipt.operationId===failure.operationId&&Number.isInteger(receipt.result?.added)&&Number.isInteger(receipt.result?.total)&&receipt.result.added>=0&&receipt.result.total>=receipt.result.added)return receipt.result as RefreshResult;}catch{}
      }
      throw error;
    }
  }));
  const writeFullText=async(input:Parameters<FeedWriter['writeFullText']>[0])=>withImageChange([],[input.entryId],()=>writes.withWorker(async()=>{
    try{return await feedWriter.writeFullText(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown&&failure.operationId){
        const row=db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`full-text-write:${input.entryId}`) as {value:string}|undefined;
        if(row)try{const receipt=JSON.parse(row.value);if(receipt.operationId===failure.operationId&&receipt.result?.added===0&&receipt.result?.total===1)return receipt.result;}catch{}
      }
      throw error;
    }
  }));
  const writeArchive=async(input:ArchiveWriteInput)=>writes.withWorker(async()=>{
    try{return await feedWriter.writeArchive(input);}catch(error){
      const failure=error as {outcomeUnknown?:boolean;operationId?:string};
      if(failure.outcomeUnknown&&failure.operationId){const row=db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`archive-write:${input.entryId}`) as {value:string}|undefined;if(row)try{const receipt=JSON.parse(row.value);if(receipt.operationId===failure.operationId&&validArchiveWriteResult(receipt.result))return receipt.result;}catch{}}
      throw error;
    }
  });
  function drainRefreshes(){
    while(activeRefreshes<4&&pending.length){
      const task=pending.shift()!;
      activeRefreshes++;
      const since=new Date().toISOString();
      const started=Date.now();
      const operation=refreshFeed(db,task.id,(response,candidate)=>feedParser.parse(response,candidate),writeBatch,writes.withMain,(response,candidate)=>feedParser.parseJson(response,candidate),messages=>feedParser.parseNewsletter(messages));
      void operation.then(async result=>{if(result.added)await writes.withMain(()=>aiRules.enqueueAutomaticForFeed(task.id,since));void logs?.write('feed','refresh',{feedId:task.id,outcome:'ok',added:result.added,total:result.total,durationMs:Date.now()-started}).catch(()=>{});task.resolve(result);},error=>{void logs?.write('feed','refresh',{feedId:task.id,outcome:'failed',errorType:logErrorType(error),durationMs:Date.now()-started}).catch(()=>{});task.reject(error);}).catch(error=>task.reject(error)).finally(()=>{activeRefreshes--;inFlight.delete(task.id);drainRefreshes();});
    }
  }
  function queuedRefresh(id:string,requestId?:string):Promise<RefreshResult>{
    if(requestId&&requestLeases.has(requestId))return withoutRequestLease(requestId,()=>queuedRefresh(id));
    if(stopping)return Promise.reject(Error('本地服务正在关闭'));
    if(deletingFeeds.has(id))return Promise.reject(Object.assign(Error('订阅正在删除'),{statusCode:409}));
    if(maintenanceGate)return Promise.reject(Object.assign(Error('数据库优化中，刷新稍后重试'),{statusCode:423}));
    const existing=inFlight.get(id);
    if(existing)return existing;
    let resolve!:(result:RefreshResult)=>void,reject!:(error:unknown)=>void;
    const result=new Promise<RefreshResult>((res,rej)=>{resolve=res;reject=rej;});
    inFlight.set(id,result);
    pending.push({id,resolve,reject});
    drainRefreshes();
    return result;
  }
  async function imageAccess(entryId:string,raw:string){
    const requested=new URL(raw),snapshot=db.entryImageIdentity(entryId,requested.href);
    if(!snapshot)throw Error('文章不存在');
    const {has_image:indexed,...identity}=snapshot;
    const {feed_id:feedId,feed_url:feedUrl,feed_allow_private:allowPrivate}=identity;
    const fields=Object.keys(identity) as (keyof typeof identity)[];
    const assertNotChanging=()=>{if(deletingFeeds.has(feedId)||imageChangingFeeds.has(feedId)||imageChangingEntries.has(entryId))throw Object.assign(Error('文章或来源授权正在更新，请稍后重试图片'),{statusCode:409});};
    assertNotChanging();
    const changed=()=>Object.assign(Error('文章内容、来源或网络授权已变化，请重试'),{statusCode:409});
    const privateOrigin=allowPrivate&&feedUrl?new URL(feedUrl).origin:undefined;
    const authorize=()=>{
      assertNotChanging();const current=db.entryImageIdentity(entryId,requested.href);
      if(!current)throw Object.assign(Error('文章已删除'),{statusCode:404});
      // Content, description and full_content changes rotate body_revision.
      if(fields.some(field=>current[field]!==identity[field])||(indexed&&!current.has_image))throw changed();
      return privateOrigin;
    };
    if(!indexed){
      const entry=db.entry(entryId) as ({url?:string;feed_url?:string;content?:string;full_content?:string;description?:string;cover?:string}&Record<string,unknown>)|undefined;
      if(!entry||fields.some(field=>entry[field]!==identity[field]))throw changed();
      const source=entry.full_content||entry.content||entry.description||'';
      // The Worker is the parser for uncertain shapes, not an extra grant check.
      const allowed=((entry.cover?.length??0)<=8192&&simpleArticleImageUrl(source,entry.url||entry.feed_url||'')===requested.href)
        ||(await writes.waitWithoutMain(()=>feedParser.imageUrls(entry))).includes(requested.href);
      authorize();if(!allowed)throw Error('图片不属于这篇文章');
    }else authorize();
    const host=requested.hostname.replace(/^\[|\]$/g,'');
    if((host==='localhost'||isIP(host)!==0&&privateAddress(host))&&requested.origin!==privateOrigin)throw Object.assign(Error('此订阅未授权访问该本机或内网图片'),{statusCode:403});
    return {privateOrigin,authorize};
  }
  async function readAuthorizedImage(entryId:string,raw:string,mode:'lookup'|'load',assertAvailable=()=>{},signal?:AbortSignal){
    assertAvailable();const access=await imageAccess(entryId,raw);assertAvailable();
    const authorize=()=>{assertAvailable();return access.authorize();};
    const cached=await images.lookupBytes(raw,authorize,deferImageMaintenance,signal);assertAvailable();
    if(cached||mode==='lookup')return {image:cached,authorize};
    return writes.withMain(async()=>{
      assertAvailable();const current=await imageAccess(entryId,raw);assertAvailable();
      const authorize=()=>{assertAvailable();return current.authorize();};
      const image=await images.loadBytes(raw,current.privateOrigin,authorize,signal);assertAvailable();
      return {image,authorize};
    });
  }
  async function readNativeImage(entryId:string,raw:string,mode:'lookup'|'load',signal?:AbortSignal){
    const unavailable=()=>{if(stopping||maintenanceGate||signal?.aborted)throw Object.assign(Error('图片服务暂不可用'),{statusCode:503});};
    unavailable();
    if(typeof entryId!=='string'||!entryId||entryId.length>200||typeof raw!=='string'||raw.length>8192||!['lookup','load'].includes(mode))throw Object.assign(Error('图片参数无效'),{statusCode:400});
    const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Object.assign(Error('图片地址无效'),{statusCode:400});
    activeExternal++;
    try{
      // Cache hits remain WAL reads: taking a main write permit here would make
      // already-cached images wait behind a long Feed Worker transaction.
      const result=await readAuthorizedImage(entryId,raw,mode,unavailable,signal);
      unavailable();result.authorize();return result;
    }finally{activeExternal--;signalDrained();}
  }
  app.addHook('onRequest',async(req,reply)=>{
    if(req.headers['x-rivu-token']!==token){reply.code(401).send({error:'Unauthorized'});return;}
    const origin=req.headers.origin;if(origin&&origin!=='http://127.0.0.1:5173'&&origin!=='null'){reply.code(403).send({error:'Origin forbidden'});return;}
    const path=req.url.split('?')[0],control=path==='/health'||path==='/api/storage/maintenance'||(req.method==='GET'&&(path==='/api/backups/automatic'||path==='/api/storage/stats'));
    if(maintenanceGate&&!control)await maintenance?.wait();
    if(stopping){reply.code(503).send({error:'服务正在停止'});return;}
    if(!control)activeRequests.add(req.id);
    const refreshOnly=req.method==='POST'&&(path==='/api/feeds/refresh'||/^\/api\/feeds\/[^/]+\/refresh$/.test(path));
    const iconModes=new URLSearchParams(req.url.split('?')[1]||'').getAll('icons');
    const metadataRead=path==='/api/feeds'&&iconModes.length===1&&iconModes[0]==='metadata';
    const cachedImageRead=path==='/api/image-cache/lookup'||path==='/api/image-cache/load';
    const readOnly=req.method==='GET'&&(!path.startsWith('/api/image-cache/')||cachedImageRead)&&(path!=='/api/feeds'||metadataRead)&&!/^\/api\/feeds\/[^/]+\/icon-snapshot$/.test(path)&&!/^\/api\/entries\/[^/]+\/offline$/.test(path);
    if(!control&&!refreshOnly&&!readOnly){const release=await writes.enterMain();if(req.raw.aborted){release();finishRequest(req.id);throw Error('请求已取消');}requestLeases.set(req.id,release);}
  });
  const finishRequest=(id:string)=>{releaseRequestLease(id);if(activeRequests.delete(id))signalDrained();};
  app.addHook('onRoute',route=>{const handler=route.handler;route.handler=async function(req,reply){activeHandlers.add(req.id);try{return await writes.withLeaseContext(requestLeases.get(req.id),()=>handler.call(this,req,reply));}finally{activeHandlers.delete(req.id);finishRequest(req.id);}};});
  app.addHook('onResponse',async req=>finishRequest(req.id));
  app.addHook('onSend',(req,_reply,payload,done)=>{const authorize=imageReplies.get(req.id);imageReplies.delete(req.id);try{authorize?.();done(null,payload);}catch(error){done(error as Error);}});
  app.addHook('onResponse',async req=>{imageReplies.delete(req.id);});
  app.addHook('onRequestAbort',async req=>{imageReplies.delete(req.id);});
  app.addHook('onRequestAbort',async req=>{if(!activeHandlers.has(req.id))finishRequest(req.id);});
  app.setErrorHandler((error,_req,reply)=>{const statusCode=(error as {statusCode?:number}).statusCode||500;if(statusCode>=500)void logs?.write('error','api_error',{statusCode,errorType:logErrorType(error)}).catch(()=>{});return reply.code(statusCode).send({error:error instanceof Error?error.message:String(error)});});
  app.get('/health',async()=>({ok:true}));
  app.get('/api/storage/stats',async()=>{const pages=(db.db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count,pageSize=(db.db.prepare('PRAGMA page_size').get() as {page_size:number}).page_size;let lastRestore:null|{completedAt:string;durationMs:number;backupBytes:number}=null;if(dataDir)try{const parsed=JSON.parse(await readFile(join(dataDir,'restore-report.json'),'utf8'));if(typeof parsed.completedAt==='string'&&Number.isFinite(parsed.durationMs)&&Number.isFinite(parsed.backupBytes))lastRestore=parsed;}catch{}return {estimatedBackupBytes:pages*pageSize,lastRestore};});
  app.get('/api/backups/automatic',async(_req,reply)=>autoBackup?autoBackup.status():reply.code(503).send({error:'自动备份需要本地数据目录'}));
  app.patch<{Body:unknown}>('/api/backups/automatic',async(req,reply)=>autoBackup?autoBackup.configure(req.body):reply.code(503).send({error:'自动备份需要本地数据目录'}));
  app.get('/api/storage/maintenance',async(_req,reply)=>maintenance?maintenance.status():reply.code(503).send({error:'数据库维护需要本地数据目录'}));
  app.post('/api/storage/maintenance',async(_req,reply)=>{
    if(!maintenance)return reply.code(503).send({error:'数据库维护需要本地数据目录'});
    if(maintenanceGate)throw Object.assign(Error('数据库优化已在运行'),{statusCode:409});
    maintenanceGate=true;notifyImageAvailability();
    try{
      const status=maintenance.start(async()=>{await autoBackup?.stop();await waitForRequests();await Promise.allSettled([...inFlight.values()]);await aiRules.wait();await images.wait();});
      void maintenance.wait().finally(()=>{maintenanceGate=false;notifyImageAvailability();if(!stopping)autoBackup?.start();});
      return status;
    }catch(error){maintenanceGate=false;notifyImageAvailability();if(!stopping)autoBackup?.start();throw error;}
  });
  app.get<{Querystring:{icons?:string}}>('/api/feeds',async(req,reply)=>{
    if(req.query.icons!==undefined&&req.query.icons!=='metadata')return reply.code(400).send({error:'图标读取模式无效'});
    if(req.query.icons==='metadata')return withoutRequestLease(req.id,()=>feedMetadataReader.read({databasePath:db.path,kind:'feed_metadata'}));
    return db.feeds(false);
  });
  app.get<{Params:{id:string};Querystring:{key?:string}}>('/api/feeds/:id/icon-snapshot',async(req,reply)=>{
    if(typeof req.query.key!=='string'||!/^[a-f0-9]{64}$/.test(req.query.key))return reply.code(400).send({error:'图标指纹无效'});
    const feed=db.feed(req.params.id);if(!feed)return reply.code(404).send({error:'订阅不存在'});
    const key=sourceIconKey(feed.icon);if(!key||key!==req.query.key){db.invalidateFeedIconKey(req.params.id);return reply.code(409).send({error:'图标快照已变化，请刷新订阅信息'});}
    return {icon:feed.icon};
  });
  app.post<{Body:{url:string;categoryId?:string;allowPrivate?:boolean}}>('/api/feeds/discover',async(req,reply)=>{if(req.body.allowPrivate!==undefined&&typeof req.body.allowPrivate!=='boolean')return reply.code(400).send({error:'本地网络授权无效'});return writes.waitWithoutMain(()=>discoverFeeds(req.body.url,req.body.allowPrivate===true,feedParseAccess));});
  app.post<{Body:{url:string;categoryId?:string;allowPrivate?:boolean;fetchInterval?:number}}>('/api/feeds',async(req,reply)=>{if(req.body.allowPrivate!==undefined&&typeof req.body.allowPrivate!=='boolean')return reply.code(400).send({error:'本地网络授权无效'});const fetchInterval=validateFetchInterval(req.body.fetchInterval);const candidates=await writes.waitWithoutMain(()=>discoverFeeds(req.body.url,req.body.allowPrivate===true,feedParseAccess));const feed=db.addFeed({...candidates[0],categoryId:req.body.categoryId,fetchInterval,allowPrivate:req.body.allowPrivate===true});try{await queuedRefresh(String(feed?.id),req.id);}catch{/* Subscription remains available for retry. */}reply.code(201);return db.feed(String(feed?.id));});
  app.post<{Body:{url:string;title:string;mapping:unknown;allowPrivate?:boolean}}>('/api/feeds/custom-json/preview',async(req,reply)=>{if(req.body?.allowPrivate!==undefined&&typeof req.body.allowPrivate!=='boolean')return reply.code(400).send({error:'本地网络授权无效'});return writes.waitWithoutMain(()=>previewJson(req.body));});
  app.post<{Body:{url:string;title:string;mapping:unknown;categoryId?:string;allowPrivate?:boolean;fetchInterval?:number}}>('/api/feeds/custom-json',async(req,reply)=>{
    if(req.body?.allowPrivate!==undefined&&typeof req.body.allowPrivate!=='boolean')return reply.code(400).send({error:'本地网络授权无效'});
    const fetchInterval=validateFetchInterval(req.body.fetchInterval),preview=await writes.waitWithoutMain(()=>previewJson(req.body));
    const feed=db.addFeed({title:preview.title,url:preview.url,type:'custom_json',jsonMapping:JSON.stringify(preview.mapping),categoryId:req.body.categoryId,fetchInterval,allowPrivate:req.body.allowPrivate===true});
    try{await queuedRefresh(String(feed?.id),req.id);}catch{/* Subscription remains available for retry. */}
    reply.code(201);return db.feed(String(feed?.id));
  });
  app.patch<{Params:{id:string};Body:{mapping:unknown}}>('/api/feeds/:id/json-mapping',async(req,reply)=>{
    const feed=db.feed(req.params.id);
    if(!feed||feed.type!=='custom_json')return reply.code(404).send({error:'自定义 JSON 订阅不存在'});
    const mapping=validateJsonMapping(req.body?.mapping);
    const authorize=()=>{
      const current=db.feed(req.params.id);
      if(!current)throw Object.assign(Error('订阅已删除'),{statusCode:404});
      if(deletingFeeds.has(req.params.id)||['url','type','allow_private','enabled','json_mapping'].some(key=>current[key]!==feed[key]))throw Object.assign(Error('来源、授权或字段映射已变化，请重新预览'),{statusCode:409});
    };
    const preview=await writes.waitWithoutMain(()=>previewJson({url:String(feed.url),title:String(feed.title),mapping,allowPrivate:!!feed.allow_private},authorize));
    await withoutRequestLease(req.id,()=>Promise.allSettled([inFlight.get(req.params.id)]));
    authorize();
    db.updateJsonMapping(req.params.id,JSON.stringify(mapping));
    return {feed:db.feed(req.params.id),preview:{items:preview.items.slice(0,5),skipped:preview.skipped}};
  });
  async function deleteSelectedFeeds(input:unknown,requestId:string){
    const change=validateFeedDeleteChange(input),ids=change.ids;
    if(ids.some(id=>deletingFeeds.has(id)))throw Object.assign(Error('订阅正在删除'),{statusCode:409});
    for(const id of ids)deletingFeeds.add(id);
    try{
      const result=await withoutRequestLease(requestId,async()=>{
        await Promise.allSettled(ids.map(id=>inFlight.get(id)));
        return writeFeedDelete({kind:'feed_delete',databasePath:db.path,change});
      });
      return {changed:result.total,action:'delete'};
    }
    finally{for(const id of ids)deletingFeeds.delete(id);}
  }
  app.post<{Body:unknown}>('/api/feeds/bulk-delete-preview',async(req)=>withoutRequestLease(req.id,()=>feedDeletePreviewReader.read({databasePath:db.path,kind:'feeds_delete_preview',selection:req.body})));
  app.post<{Body:unknown}>('/api/feeds/bulk',async(req)=>{
    const body=req.body as {ids?:string[];action?:string}|null;
    if(body?.action==='category'){
      const change=validateFeedCategoryChange(req.body);
      const result=await withoutRequestLease(req.id,()=>writeFeedCategory({kind:'feed_category',databasePath:db.path,change}));
      return {changed:result.total,action:'category'};
    }
    if(body?.action!=='delete')return changeFeeds(db,req.body);
    return deleteSelectedFeeds(body,req.id);
  });
  app.patch<{Params:{id:string};Body:unknown}>('/api/feeds/:id',async(req,reply)=>{
    const patch=validateFeedPatch(req.body),result=await withoutRequestLease(req.id,()=>writeFeedMetadata({kind:'feed_patch',databasePath:db.path,id:req.params.id,patch}));
    if(!(result.json instanceof ArrayBuffer))throw Error('订阅修改结果无效');
    return reply.type('application/json; charset=utf-8').send(Buffer.from(result.json));
  });
  app.delete<{Params:{id:string};Body:{expected?:{entriesToDelete:number;archivesPreserved:number}}}>('/api/feeds/:id',async(req)=>{const result=await deleteSelectedFeeds({ids:[req.params.id],action:'delete',expected:req.body?.expected},req.id);return {deleted:result.changed};});
  app.get<{Params:{id:string}}>('/api/feeds/:id/delete-preview',async(req)=>withoutRequestLease(req.id,()=>feedDeletePreviewReader.read({databasePath:db.path,kind:'feed_delete_preview',feedId:req.params.id})));
  app.post('/api/feeds/refresh',async()=>{
    const feeds=db.refreshableFeeds();
    const results=await Promise.all(feeds.map(async feed=>{
      const id=(feed as {id:string}).id;
      try{const result=await queuedRefresh(id);return {id,added:result.added};}
      catch(error){return {id,error:error instanceof Error?error.message:String(error)};}
    }));
    return {total:feeds.length,succeeded:results.filter(result=>!result.error).length,failed:results.filter(result=>!!result.error).length,results};
  });
  app.post<{Params:{id:string}}>('/api/feeds/:id/refresh',async(req)=>queuedRefresh(req.params.id));
  app.post<{Params:{id:string}}>('/api/feeds/:id/icon',async(req)=>{
    const id=req.params.id;
    if(stopping||deletingFeeds.has(id))throw Object.assign(Error('订阅正在关闭或删除'),{statusCode:409});
    const existing=iconUpdates.get(id);if(existing)return writes.waitWithoutMain(()=>existing);
    const update=refreshFeedIcon(db,id,feedParseAccess,writes.waitWithoutMain);iconUpdates.set(id,update);
    try{return await update;}finally{iconUpdates.delete(id);}
  });
  app.get('/api/rsshub/instances',async()=>db.rsshubInstances());
  app.post<{Body:{name:string;baseUrl:string;allowPrivate?:boolean}}>('/api/rsshub/instances',async(req,reply)=>{if(!req.body.name?.trim())return reply.code(400).send({error:'实例名称不能为空'});if(req.body.allowPrivate!==undefined&&typeof req.body.allowPrivate!=='boolean')return reply.code(400).send({error:'本地网络授权无效'});reply.code(201);return db.addRsshubInstance(req.body.name.trim(),normalizeRsshubBase(req.body.baseUrl),req.body.allowPrivate===true);});
  app.delete<{Params:{id:string}}>('/api/rsshub/instances/:id',async(req)=>({deleted:db.deleteRsshubInstance(req.params.id)}));
  app.post<{Body:{instanceId:string;route:string}}>('/api/rsshub/preview',async(req)=>writes.waitWithoutMain(()=>previewRsshub(db,req.body.instanceId,req.body.route,feedParseAccess)));
  app.post<{Body:{instanceId:string;route:string;categoryId?:string;fetchInterval?:number}}>('/api/rsshub/subscribe',async(req,reply)=>{const fetchInterval=validateFetchInterval(req.body.fetchInterval);const feed=await subscribeRsshub(db,req.body.instanceId,req.body.route,req.body.categoryId,fetchInterval,feedParseAccess,id=>queuedRefresh(id,req.id),writes.waitWithoutMain);reply.code(201);return feed;});
  app.get<{Querystring:{view?:string;feedId?:string;categoryId?:string;tagId?:string;limit?:string;offset?:string;q?:string;beforeTime?:string;beforeId?:string}}>('/api/entries',async(req)=>entryReader.read({databasePath:db.path,kind:'entries',options:{view:req.query.view,feedId:req.query.feedId,categoryId:req.query.categoryId,tagId:req.query.tagId,query:req.query.q,limit:Number(req.query.limit||100),offset:Number(req.query.offset||0),cursor:req.query.beforeTime||req.query.beforeId?{sortTime:req.query.beforeTime||'',id:req.query.beforeId||''}:undefined,listOnly:true}}));
  app.get('/api/smart-folders',async()=>listSmartFolders(db));
  app.post<{Body:{query:string}}>('/api/smart-folders/preview',async(req)=>withoutRequestLease(req.id,()=>entryReader.read({databasePath:db.path,kind:'smart_preview',query:req.body?.query})));
  app.post<{Body:unknown}>('/api/smart-folders',async(req,reply)=>{reply.code(201);return createSmartFolder(db,req.body);});
  app.get<{Params:{id:string}}>('/api/smart-folders/:id',async(req)=>getSmartFolder(db,req.params.id));
  app.patch<{Params:{id:string};Body:unknown}>('/api/smart-folders/:id',async(req)=>updateSmartFolder(db,req.params.id,req.body));
  app.delete<{Params:{id:string}}>('/api/smart-folders/:id',async(req)=>deleteSmartFolder(db,req.params.id));
  app.get<{Params:{id:string};Querystring:{limit?:string;offset?:string;beforeTime?:string;beforeId?:string}}>('/api/smart-folders/:id/entries',async(req)=>entryReader.read({databasePath:db.path,kind:'smart_folder',folderId:req.params.id,limit:Number(req.query.limit||100),offset:Number(req.query.offset||0),cursor:req.query.beforeTime||req.query.beforeId?{sortTime:req.query.beforeTime||'',id:req.query.beforeId||''}:undefined}));
  app.post<{Body:ReadScope}>('/api/entries/mark-read',async(req,reply)=>{
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return reply.code(400).send({error:'批量范围无效'});
    const scope=req.body as ReadScope&{smartFolderId?:string};
    if(scope.smartFolderId!==undefined&&(typeof scope.smartFolderId!=='string'||Object.entries(scope).filter(([,value])=>value!==undefined).length!==1))return reply.code(400).send({error:'智能分类批量范围无效'});
    return withoutRequestLease(req.id,()=>writes.withWorker(async()=>{
      const result=await writeBulkRead({kind:'bulk_read',databasePath:db.path,sessionId:readSessionId,scope,token:randomUUID()});
      readUndo.clear();if(result.undoToken)readUndo.set(result.undoToken,{invalidated:new Set(),expiresAt:result.expiresAt!});
      return {changed:result.changed,undoToken:result.undoToken};
    }));
  });
  app.post<{Body:{token:string}}>('/api/entries/mark-read/undo',async(req,reply)=>{
    return withoutRequestLease(req.id,()=>writes.withWorker(async()=>{
      const record=readUndo.get(req.body?.token);
      if(!record||record.expiresAt<Date.now()){readUndo.delete(req.body?.token);return reply.code(404).send({error:'撤销已失效'});}
      const result=await writeBulkRead({kind:'bulk_read_undo',databasePath:db.path,sessionId:readSessionId,token:req.body.token,invalidated:[...record.invalidated]});
      readUndo.delete(req.body.token);return {changed:result.changed};
    }));
  });
  app.get<{Params:{id:string}}>('/api/entries/:id',async(req,reply)=>{
    const result=await withoutRequestLease(req.id,()=>entryDetailReader.read({databasePath:db.path,kind:'entry',entryId:req.params.id,serialize:true}));
    if(result===undefined||result===null)return reply.code(404).send({error:'文章不存在'});
    if(typeof result!=='object'||!('json' in result)||!(result.json instanceof ArrayBuffer))throw Error('文章读取结果无效');
    // The hint is computed off-main and is not an authorization decision.
    if('imageHint' in result&&result.imageHint===true)try{feedParser.prepareImageParser();}catch(error){void logs?.write('error','image_parser_prepare_failed',{errorType:logErrorType(error)}).catch(()=>{});}
    return reply.type('application/json; charset=utf-8').send(Buffer.from(result.json));
  });
  app.get<{Querystring:{limit?:string;offset?:string;revision?:string}}>('/api/archives/page',async req=>archiveReader.read({databasePath:db.path,kind:'list_page',...archivePage(req.query),revision:validateArchiveRevision(req.query.revision)}));
  app.get<{Querystring:{limit?:string;offset?:string}}>('/api/archives',async req=>archiveReader.read({databasePath:db.path,kind:'list',...archivePage(req.query)}));
  app.get('/api/archives/stats',async()=>archiveReader.read({databasePath:db.path,kind:'stats'}));
  app.get<{Params:{id:string}}>('/api/archives/:id',async req=>archiveReader.read({databasePath:db.path,kind:'get',archiveId:req.params.id}));
  app.get<{Params:{id:string};Querystring:{limit?:string;offset?:string;revision?:string}}>('/api/archives/:id/versions/page',async req=>archiveReader.read({databasePath:db.path,kind:'history_page',archiveId:req.params.id,...archivePage(req.query),revision:validateArchiveRevision(req.query.revision)}));
  app.get<{Params:{id:string};Querystring:{limit?:string;offset?:string}}>('/api/archives/:id/versions',async req=>archiveReader.read({databasePath:db.path,kind:'versions',archiveId:req.params.id,...archivePage(req.query)}));
  app.get<{Params:{id:string;versionId:string};Querystring:{revision?:string}}>('/api/archives/:id/versions/:versionId',async req=>archiveReader.read({databasePath:db.path,kind:'version',archiveId:req.params.id,versionId:req.params.versionId,revision:validateArchiveRevision(req.query.revision)}));
  app.get<{Params:{id:string;assetId:string}}>('/api/archives/:id/assets/:assetId',async req=>archiveReader.read({databasePath:db.path,kind:'asset',archiveId:req.params.id,assetId:req.params.assetId}));
  app.post<{Params:{id:string};Body:{images?:boolean;attachments?:boolean;snapshot?:boolean}}>('/api/entries/:id/archive',async(req,reply)=>{const result=await withoutRequestLease(req.id,()=>archiveSaver.save(req.params.id,req.body||{}));reply.code(201);return result;});
  app.delete<{Params:{id:string}}>('/api/archives/:id',async(req)=>deleteArchive(db,req.params.id));
  app.get<{Params:{id:string}}>('/api/entries/:id/media',async(req,reply)=>db.hasEntry(req.params.id)?db.entryMedia(req.params.id):reply.code(404).send({error:'文章不存在'}));
  app.get<{Params:{id:string}}>('/api/entries/:id/reading-position',async(req,reply)=>db.hasEntry(req.params.id)?db.readingPosition(req.params.id)??{progress:0}:reply.code(404).send({error:'文章不存在'}));
  app.put<{Params:{id:string};Body:{progress:number;anchor?:unknown}}>('/api/entries/:id/reading-position',async(req,reply)=>db.saveReadingPosition(req.params.id,req.body?.progress,req.body?.anchor)??reply.code(404).send({error:'文章不存在'}));
  app.patch<{Params:{id:string};Body:{read?:boolean;starred?:boolean;saved?:boolean;archived?:boolean}}>('/api/entries/:id',async(req,reply)=>{
    const invalidate=()=>{if(req.body?.read!==undefined)for(const [token,record] of readUndo){if(record.expiresAt<Date.now())readUndo.delete(token);else record.invalidated.add(req.params.id);}};
    const result=await withoutRequestLease(req.id,()=>writes.withWorker(async()=>{
      try{
        const result=await feedWriter.writeEntryState({kind:'entry_state',databasePath:db.path,entryId:req.params.id,patch:req.body});
        if(result.total)invalidate();return result;
      }catch(error){
        if((error as {outcomeUnknown?:boolean}).outcomeUnknown){invalidate();throw Object.assign(Error('文章状态提交结果待核验，请重新读取文章后确认'),{statusCode:503});}
        throw error;
      }
    }));
    if(!result.total)return reply.code(404).send({error:'文章不存在'});
    return reply.type('application/json; charset=utf-8').send(Buffer.from(result.json!));
  });
  app.get('/api/tags',async()=>db.tags());
  app.get('/api/rules',async()=>listRules(db));
  app.get('/api/ai-rules',async()=>aiRules.list());
  app.get('/api/ai-rules/status',async()=>aiRules.status());
  app.post<{Body:unknown}>('/api/ai-rules/preview',async(req)=>aiRules.previewDraft(req.body));
  app.post<{Body:unknown}>('/api/ai-rules',async(req,reply)=>{reply.code(201);return aiRules.create(req.body);});
  app.get<{Params:{id:string}}>('/api/ai-rules/:id/preview',async(req)=>aiRules.preview(req.params.id));
  app.get<{Params:{id:string}}>('/api/ai-rules/:id/jobs',async(req)=>aiRules.jobs(req.params.id));
  app.post<{Params:{id:string};Body:unknown}>('/api/ai-rules/:id/enable',async(req)=>aiRules.enable(req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/ai-rules/:id/disable',async(req)=>aiRules.disable(req.params.id));
  app.post<{Params:{id:string}}>('/api/ai-rules/:id/run',async(req)=>aiRules.enqueue(req.params.id));
  app.post<{Params:{id:string}}>('/api/ai-rules/:id/retry',async(req)=>aiRules.retry(req.params.id));
  app.delete<{Params:{id:string}}>('/api/ai-rules/:id',async(req)=>aiRules.delete(req.params.id));
  app.post<{Body:unknown}>('/api/rules/preview',async(req)=>previewDraft(db,req.body));
  app.post<{Body:unknown}>('/api/rules',async(req,reply)=>{reply.code(201);return createRule(db,req.body);});
  app.post('/api/rules/apply',async()=>applyEnabledRules(db));
  app.patch<{Params:{id:string};Body:unknown}>('/api/rules/:id',async(req)=>updateRule(db,req.params.id,req.body));
  app.delete<{Params:{id:string}}>('/api/rules/:id',async(req)=>deleteRule(db,req.params.id));
  app.get<{Params:{id:string}}>('/api/rules/:id/preview',async(req)=>previewRule(db,req.params.id));
  app.post<{Params:{id:string}}>('/api/rules/:id/apply',async(req)=>applyRule(db,req.params.id));
  app.post<{Params:{id:string}}>('/api/rules/:id/undo',async(req)=>undoRule(db,req.params.id));
  app.post<{Body:{name:string;color?:string}}>('/api/tags',async(req,reply)=>{if(!req.body.name?.trim())return reply.code(400).send({error:'标签名不能为空'});if(req.body.color&&!/^#[0-9a-fA-F]{6}$/.test(req.body.color))return reply.code(400).send({error:'标签颜色格式无效'});reply.code(201);return db.addTag(req.body.name,req.body.color);});
  app.delete<{Params:{id:string}}>('/api/tags/:id',async(req)=>deleteTagAndReconcile(db,req.params.id));
  app.get<{Params:{id:string}}>('/api/entries/:id/tags',async(req)=>db.entryTags(req.params.id));
  app.patch<{Params:{id:string};Body:{tagIds:string[]}}>('/api/entries/:id/tags',async(req,reply)=>{if(!Array.isArray(req.body.tagIds))return reply.code(400).send({error:'tagIds 必须是数组'});const result=db.setEntryTags(req.params.id,req.body.tagIds);if(!result)return reply.code(404).send({error:'文章不存在'});const entry=db.entryState(req.params.id);if(!entry)return reply.code(404).send({error:'文章不存在'});applyEnabledRules(db,entry.feed_id);return db.entryTags(req.params.id);});
  app.post<{Params:{id:string}}>('/api/entries/:id/full-text',async(req)=>{await withoutRequestLease(req.id,()=>fetchFullText(db,req.params.id,response=>feedParser.extractFullText(response),writeFullText));return db.entry(req.params.id);});
  app.get<{Params:{id:string}}>('/api/entries/:id/offline',async(req,reply)=>await withoutRequestLease(req.id,()=>offline.status(req.params.id))??reply.code(404).send({error:'文章不存在'}));
  app.post<{Params:{id:string};Body:{includeImages:boolean}}>('/api/entries/:id/offline',async(req,reply)=>{
    if(typeof req.body?.includeImages!=='boolean')return reply.code(400).send({error:'离线保存选项无效'});
    const result=await withoutRequestLease(req.id,()=>offline.save(req.params.id,req.body.includeImages));return result??reply.code(404).send({error:'文章不存在'});
  });
  app.get('/api/image-cache/settings',async()=>images.getSettings());
  app.get('/api/reading/settings',async()=>reading.get());
  app.patch<{Body:unknown}>('/api/reading/settings',async(req)=>reading.update(req.body));
  app.get('/api/network/proxy',async()=>proxySettings.get());
  app.patch<{Body:unknown}>('/api/network/proxy',async(req)=>proxySettings.update(req.body));
  app.post<{Body:{url?:string}}>('/api/network/proxy/test',async(req,reply)=>{
    if(typeof req.body?.url!=='string'||req.body.url.length>2048)return reply.code(400).send({error:'测试地址无效'});
    let url:URL;try{url=new URL(req.body.url);}catch{return reply.code(400).send({error:'测试地址无效'});}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return reply.code(400).send({error:'测试地址无效'});
    const result=await writes.waitWithoutMain(()=>requestBytes(url.href,256*1024,'application/rss+xml, application/atom+xml, application/json, text/plain, text/html'));
    return {url:result.url,bytes:result.bytes.length,type:result.type};
  });
  app.patch<{Body:{enabled?:boolean;maxBytes?:number}}>('/api/image-cache/settings',async(req)=>images.configure(req.body));
  app.get('/api/image-cache/stats',async()=>images.stats());
  for(const mode of ['lookup','load'] as const)app.get<{Querystring:{url:string;entryId:string;transport?:string}}>('/api/image-cache/'+mode,async(req,reply)=>{
    if(req.query.transport!==undefined&&req.query.transport!=='binary')throw Object.assign(Error('图片传输格式无效'),{statusCode:400});
    const binary=req.query.transport==='binary';
    const send=(image:{data:Buffer;mime:string}|null,authorize:()=>string|undefined)=>{
      if(!image)return binary?reply.code(204).send():null;
      imageReplies.set(req.id,authorize);
      if(binary)return reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').type(image.mime).send(image.data);
      return {dataUrl:'data:'+image.mime+';base64,'+image.data.toString('base64'),bytes:image.data.length};
    };
    const result=await readAuthorizedImage(req.query.entryId,req.query.url,mode);
    return send(result.image,result.authorize);
  });
  app.post<{Body:{url:string;entryId:string;explicit?:boolean}}>('/api/image-cache/cache',async(req)=>{if(req.body.explicit!==undefined&&typeof req.body.explicit!=='boolean')throw Object.assign(Error('缓存选项无效'),{statusCode:400});const access=await imageAccess(req.body.entryId,req.body.url);return images.cache(req.body.url,access.privateOrigin,req.body.explicit===true,access.authorize);});
  app.get('/api/categories',async()=>db.categories());
  app.post<{Body:{name:string}}>('/api/categories',async(req,reply)=>{if(!req.body.name?.trim())return reply.code(400).send({error:'分类名不能为空'});reply.code(201);return db.addCategory(req.body.name);});
  app.delete<{Params:{id:string}}>('/api/categories/:id',async(req)=>{const result=await withoutRequestLease(req.id,()=>writeFeedMetadata({kind:'category_delete',databasePath:db.path,id:req.params.id}));return {deleted:result.total};});
  app.get<{Querystring:{q:string}}>('/api/search',async(req)=>entryReader.read({databasePath:db.path,kind:'entries',options:{query:req.query.q,limit:100,listOnly:true}}));
  app.get('/api/ai/settings',async()=>ai.publicSettings());
  app.get('/api/ai/results-version',async()=>({revision:ai.resultsRevision(),running:aiRules.status().running}));
  app.patch<{Body:{baseUrl?:string;apiKey?:string;model?:string;temperature?:number;maxTokens?:number;contextLength?:number;summaryModel?:string;translationModel?:string;askModel?:string;tagModel?:string;customPrompt?:string;filterCriteria?:string}}>('/api/ai/settings',async(req)=>ai.configure(req.body));
  app.post<{Body:{baseUrl?:string;apiKey?:string;model?:string;temperature?:number;maxTokens?:number;contextLength?:number;summaryModel?:string;translationModel?:string;askModel?:string;tagModel?:string;customPrompt?:string;filterCriteria?:string}}>('/api/ai/test',async(req)=>ai.test(req.body||{}));
  app.get<{Params:{id:string};Querystring:{type:string;language?:string}}>('/api/entries/:id/ai/preview',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.previewManualAction(req.params.id,req.query.type,req.query.language)));
  app.get<{Params:{id:string};Querystring:{type:string;language?:string}}>('/api/entries/:id/ai',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.cached(req.params.id,req.query.type,req.query.language)));
  app.post<{Params:{id:string};Body:{type:'summary'|'translation'|'ask'|'keywords'|'classification'|'explain'|'rewrite'|'custom'|'tags'|'filter';language?:string;question?:string;scopeHash?:string}}>('/api/entries/:id/ai',async(req)=>ai.withPreparedBodies([req.params.id],()=>['summary','translation','explain','rewrite','custom','tags','filter'].includes(req.body.type)||req.body.scopeHash!==undefined?ai.actionWithPreview(req.params.id,req.body.type,req.body.language,req.body.scopeHash):ai.action(req.params.id,req.body.type,req.body.language,req.body.question)));
  app.get<{Params:{id:string}}>('/api/entries/:id/ai/tag-suggestions',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.tagSuggestions(req.params.id)));
  app.post<{Params:{id:string};Body:{names:unknown;reviewHash:unknown}}>('/api/entries/:id/ai/tag-suggestions/apply',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.applyTagSuggestions(req.params.id,req.body?.names,req.body?.reviewHash,feedId=>{applyEnabledRules(db,feedId,true);})));
  app.get<{Params:{id:string}}>('/api/entries/:id/ai/filter-review',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.filterReview(req.params.id)));
  app.post<{Params:{id:string};Body:{reviewHash:unknown}}>('/api/entries/:id/ai/filter-review/apply',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.applyFilterSuggestion(req.params.id,req.body?.reviewHash)));
  app.post<{Params:{id:string};Body:{undoHash:unknown}}>('/api/entries/:id/ai/filter-review/undo',async(req)=>ai.withPreparedBodies([req.params.id],()=>ai.undoFilter(req.params.id,req.body?.undoHash)));
  app.post<{Body:{entryIds:unknown;question?:unknown;conversationId?:unknown}}>('/api/ai/chat/preview',async(req)=>ai.withPreparedBodies(req.body?.entryIds,()=>ai.preview(req.body?.entryIds,{question:req.body?.question,conversationId:req.body?.conversationId})));
  app.post<{Body:{entryIds:unknown;question:unknown;contextHash:unknown;requestId?:unknown}}>('/api/ai/chat/messages',async(req)=>ai.startConversation(req.body?.entryIds,req.body?.question,req.body?.contextHash,req.body?.requestId));
  app.get('/api/ai/conversations',async()=>ai.conversations());
  app.post<{Body:{entryIds:unknown}}>('/api/ai/conversations',async(req,reply)=>{reply.code(201);return ai.withPreparedBodies(req.body?.entryIds,()=>ai.createConversation(req.body?.entryIds));});
  app.get<{Params:{id:string}}>('/api/ai/conversations/:id',async(req)=>ai.getConversation(req.params.id));
  app.delete<{Params:{id:string}}>('/api/ai/conversations/:id',async(req)=>ai.deleteConversation(req.params.id));
  app.post<{Params:{id:string};Body:{question:unknown;contextHash:unknown;lastMessageId:unknown}}>('/api/ai/conversations/:id/messages',async(req)=>ai.withPreparedBodies(ai.getConversation(req.params.id).entryIds,()=>ai.send(req.params.id,req.body?.question,req.body?.contextHash,req.body?.lastMessageId)));
  let timer:NodeJS.Timeout|undefined;
  async function start(port=0){await app.listen({host:'127.0.0.1',port});void logs?.write('app','service_started').catch(()=>{});timer=setInterval(()=>{if(!maintenanceGate)void Promise.allSettled(db.dueFeeds().map(feed=>queuedRefresh(feed.id)));},60_000);timer.unref();autoBackup?.start();return {address:app.server.address(),token};}
  async function stop(){stopping=true;notifyImageAvailability();if(timer)clearInterval(timer);const offlineDrained=offline.stop(),archivesDrained=archiveSaver.stop();await Promise.allSettled([...inFlight.values()]);await Promise.all([offlineDrained,archivesDrained]);await waitForRequests();await aiRules.wait();await feedParser.stop();if(readUndoStored)try{await writes.withWorker(()=>feedWriter.writeBulkRead({kind:'bulk_read_cleanup',databasePath:db.path,sessionId:readSessionId}));}catch(error){void logs?.write('error','bulk_read_cleanup_failed',{errorType:logErrorType(error)}).catch(()=>{});}await feedWriter.stop();await archiveExporter.stop();await archiveReader.stop();await aiScanner.stop();await Promise.all([entryReader.stop(),entryDetailReader.stop(),feedMetadataReader.stop(),feedDeletePreviewReader.stop()]);await autoBackup?.stop();await maintenance?.stop();await app.close();void logs?.write('app','service_stopped').catch(()=>{});await logs?.flush();}
  async function waitForFeedRefresh(id:string){await Promise.allSettled([inFlight.get(id)]);}
  async function previewNewsletter(directory:string){
    if(stopping)throw Error('本地服务正在关闭');while(maintenanceGate)await maintenance?.wait();if(stopping)throw Error('本地服务正在关闭');activeExternal++;
    try{return await previewNewsletterFolder(directory,messages=>feedParser.parseNewsletter(messages));}finally{activeExternal--;signalDrained();}
  }
  async function exportPermanentArchive(id:string,destination:string){
    if(stopping)throw Error('本地服务正在关闭');while(maintenanceGate)await maintenance?.wait();if(stopping)throw Error('本地服务正在关闭');activeExternal++;
    try{return await archiveExporter.export(db.path,id,destination);}finally{activeExternal--;signalDrained();}
  }
  return {app,start,stop,token,withDatabaseAccess,waitForFeedRefresh,previewNewsletter,exportPermanentArchive,onImageAvailability,readNativeImage};
}

