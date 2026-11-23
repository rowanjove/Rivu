import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import type {FeedPreview,ParsedFeedPreview,PagePreview,RssCandidate,RssFetched} from './feeds';
import type {JsonCandidate,JsonFetched,JsonPreview} from './custom-json';
import type {FullTextResult} from './fulltext';
import type {NewsletterMessage,NewsletterResult} from './newsletter';
import type {EntryMedia} from './media';
import type {AITextResult} from './ai-context';
import {AI_CONTENT_CHARS,type AIProviderKind,type AIProviderReply} from './ai-provider-response';

function validFeed(value:unknown):value is FeedPreview{
  if(!value||typeof value!=='object')return false;
  const result=value as FeedPreview;return typeof result.title==='string'&&typeof result.url==='string'&&Array.isArray(result.items);
}
function stringArray(value:unknown):value is string[]{return Array.isArray(value)&&value.every(item=>typeof item==='string');}

export class FeedParser {
  private jobs=new Set<Promise<unknown>>();
  private closed=false;
  private active=0;
  private pending:(()=>void)[]=[];
  private retainedInputBytes=0;
  private aiWorkers=new Set<Worker>();
  private idleAIWorkers:Worker[]=[];
  private imageWorkers=new Set<Worker>();
  private idleImageWorker:Worker|undefined;
  private imageIdleTimer:ReturnType<typeof setTimeout>|undefined;
  private imageResults=new Map<string,{urls:string[];bytes:number}>();
  private imagePending=new Map<string,Promise<string[]>>();
  private imageResultBytes=0;
  constructor(private workerPath:string,private modulePath=join(dirname(workerPath),'feed-parse-task.cjs'),private maxPending=64,private maxInputBytes=64*1024*1024,private timeoutMs=120000,private imageModulePath=modulePath===join(dirname(workerPath),'feed-parse-task.cjs')?join(dirname(workerPath),'image-url-task.cjs'):undefined,private imageIdleMs=30000){}
  parse(response:RssFetched,candidate:RssCandidate):Promise<ParsedFeedPreview>{
    return this.run('rss',response,candidate,(value):value is ParsedFeedPreview=>validFeed(value)&&(!('sourceIcon' in value)||typeof value.sourceIcon==='string'));
  }
  parsePage(response:RssFetched,candidate:RssCandidate):Promise<PagePreview>{return this.run('page',response,candidate,(value):value is PagePreview=>validFeed(value)&&stringArray((value as PagePreview).feedUrls)&&stringArray((value as PagePreview).iconUrls));}
  parseJson(response:JsonFetched,candidate:JsonCandidate):Promise<JsonPreview>{
    return this.run('custom_json',response,candidate,(value):value is JsonPreview=>validFeed(value)&&Number.isInteger((value as JsonPreview).skipped)&&(value as JsonPreview).skipped>=0&&!!(value as JsonPreview).mapping&&typeof (value as JsonPreview).mapping==='object');
  }
  extractFullText(response:RssFetched):Promise<FullTextResult>{return this.run('full_text',response,{url:response.url},(value):value is FullTextResult=>!!value&&typeof value==='object'&&typeof (value as FullTextResult).html==='string'&&typeof (value as FullTextResult).canonicalUrl==='string');}
  imageUrls(entry:{url?:string;feed_url?:string;content?:string;description?:string;full_content?:string;cover?:string}):Promise<string[]>{
    if(this.closed)return Promise.reject(Error('来源解析器已关闭'));
    const text=entry.full_content||entry.content||entry.description||'',base=entry.url||entry.feed_url||'',candidate={url:base,cover:entry.cover};
    const busy=()=>Promise.reject<string[]>(Object.assign(Error('来源解析繁忙，请稍后重试'),{statusCode:503,resourceBusy:true}));
    // Reject oversized input before UTF-16 hashing allocates/scans its body.
    // The cheap lower bound also avoids serializing an oversized URL or cover.
    if((text.length+base.length+(entry.cover?.length||0))*2>this.maxInputBytes)return busy();
    if(text.length*2+JSON.stringify(candidate).length*2>this.maxInputBytes)return busy();
    const hash=createHash('sha256');
    // Hash exact UTF-16 inputs, including base/cover, without retaining the body.
    for(const part of [text,base,entry.cover||''])hash.update(String(part.length)+':').update(part,'utf16le');
    const key=hash.digest('hex'),cached=this.imageResults.get(key);
    if(cached){this.imageResults.delete(key);this.imageResults.set(key,cached);return Promise.resolve([...cached.urls]);}
    let pending=this.imagePending.get(key);
    if(!pending){
      pending=this.run('image_urls',{text,url:base,type:'text/html'},candidate,stringArray).then(urls=>{
        const bytes=urls.reduce((sum,url)=>sum+url.length*2,0);
        if(bytes<=4*1024*1024){
          while(this.imageResults.size>=256||this.imageResultBytes+bytes>4*1024*1024){const oldest=this.imageResults.keys().next().value!;this.imageResultBytes-=this.imageResults.get(oldest)!.bytes;this.imageResults.delete(oldest);}
          this.imageResults.set(key,{urls:[...urls],bytes});this.imageResultBytes+=bytes;
        }
        return urls;
      });
      this.imagePending.set(key,pending);const clear=()=>this.imagePending.delete(key);void pending.then(clear,clear);
    }
    return pending.then(urls=>[...urls]);
  }
  aiText(html:string):Promise<string>{return this.run('ai_text',{text:html,url:'',type:'text/html'},{url:''},(value):value is string=>typeof value==='string');}
  aiProviderJson(text:string,kind:AIProviderKind):Promise<AIProviderReply>{
    if(typeof text!=='string'||!['models','completion'].includes(kind))return Promise.reject(Error('AI 响应解析参数无效'));
    const response={text,url:'',type:'application/json',aiProviderKind:kind};
    return this.run('ai_text',response,{url:''},(value):value is AIProviderReply=>{
      if(!value||typeof value!=='object'||Object.keys(value).length!==1)return false;
      const reply=value as AIProviderReply;
      return kind==='models'?typeof reply.model==='string'&&reply.model.length<=200:typeof reply.content==='string'&&reply.content.length<=AI_CONTENT_CHARS&&!!reply.content.trim();
    });
  }
  aiDigest(html:string):Promise<string>{const response={text:html,url:'',type:'text/html',aiHashOnly:true};return this.run('ai_text',response,{url:''},(value):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value));}
  aiContextText(html:string):Promise<AITextResult>{const response={text:html,url:'',type:'text/html',aiContext:true};return this.run('ai_text',response,{url:''},(value):value is AITextResult=>!!value&&typeof value==='object'&&typeof (value as AITextResult).body==='string'&&Array.isArray((value as AITextResult).paragraphs)&&(value as AITextResult).paragraphs.length<=5&&(value as AITextResult).paragraphs.every(part=>typeof part==='string'&&part.length>0&&part.length<=800));}
  archiveImages(html:string,base:string):Promise<EntryMedia[]>{return this.run('archive_images',{text:html,url:base,type:'text/html'},{url:base},(value):value is EntryMedia[]=>Array.isArray(value)&&value.length<=50&&value.every(item=>item?.kind==='image'&&typeof item.url==='string'));}
  parseNewsletter(messages:NewsletterMessage[]):Promise<NewsletterResult[]>{return this.run('newsletter',{messages},{url:''},(value):value is NewsletterResult[]=>Array.isArray(value)&&value.length===messages.length&&value.every((item,i)=>item?.name===messages[i].name&&(typeof item.error==='string'||item.entry&&typeof item.entry.title==='string'&&typeof item.entry.hash==='string')));}
  private run<Result>(kind:'rss'|'custom_json'|'page'|'full_text'|'image_urls'|'newsletter'|'ai_text'|'archive_images',response:RssFetched|JsonFetched|{messages:NewsletterMessage[]},candidate:RssCandidate|JsonCandidate|(RssCandidate&{cover?:string}),valid:(value:unknown)=>value is Result):Promise<Result>{
    if(this.closed)return Promise.reject(Error('来源解析器已关闭'));
    const inputBytes=('messages' in response?response.messages.reduce((bytes,item)=>bytes+item.raw.byteLength+item.name.length*2,0):'text' in response?response.text.length*2:response.bytes.byteLength)+JSON.stringify(candidate).length*2;
    if((this.active>=4&&this.pending.length>=this.maxPending)||this.retainedInputBytes+inputBytes>this.maxInputBytes)return Promise.reject(Object.assign(Error('来源解析繁忙，请稍后重试'),{statusCode:503,resourceBusy:true}));
    this.retainedInputBytes+=inputBytes;
    const job=this.queue(()=>kind==='ai_text'?this.runPersistentAI(response as RssFetched,valid):kind==='image_urls'&&this.imageModulePath?this.runPersistentImage(response as RssFetched,candidate,valid):new Promise<Result>((resolve,reject)=>{
      // Custom task modules retain their injected parsing behavior. The stock
      // image task loads only the HTML parser, never RSS/JSDOM/full-text modules.
      const imageModulePath=kind==='image_urls'?this.imageModulePath:undefined;
      let worker:Worker;try{worker=new Worker(this.workerPath,{workerData:{kind,modulePath:this.modulePath,imageModulePath,response,candidate},resourceLimits:{maxOldGenerationSizeMb:256}});}catch(error){reject(error);return;}
      let settled=false;
      const finish=(error?:unknown,result?:Result)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate().then(()=>{if(error)reject(error);else resolve(result!);},reject);};
      const timer=setTimeout(()=>finish(Error('来源解析超时')),this.timeoutMs);timer.unref();
      worker.on('message',(message:{error?:string;statusCode?:number;result?:unknown})=>{
        if(message?.error)finish(Object.assign(Error(message.error),{statusCode:message.statusCode}));
        else if(valid(message?.result))finish(undefined,message.result);
        else finish(Error('来源解析结果无效'));
      });
      worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(Error(`来源解析进程退出（${code}）`));});
    }));
    this.jobs.add(job);const cleanup=()=>{this.jobs.delete(job);this.retainedInputBytes-=inputBytes;};void job.then(cleanup,cleanup);return job;
  }
  private removeImageWorker(worker:Worker){
    this.imageWorkers.delete(worker);
    if(this.idleImageWorker===worker){this.idleImageWorker=undefined;clearTimeout(this.imageIdleTimer);this.imageIdleTimer=undefined;}
  }
  // Optional preparation for an explicit reading action, never service startup.
  // It parses no article and grants no image authorization. Actual jobs still
  // use normal admission, body identity and authorization checks.
  prepareImageParser():boolean{
    if(this.closed||!this.imageModulePath||this.jobs.size||this.imageWorkers.size)return false;
    const worker=this.createImageWorker();this.parkImageWorker(worker);return true;
  }
  private createImageWorker(){
    const worker=new Worker(this.workerPath,{workerData:{persistentImages:true,imageModulePath:this.imageModulePath},resourceLimits:{maxOldGenerationSizeMb:256}});
    this.imageWorkers.add(worker);worker.on('error',()=>{});
    worker.once('exit',()=>this.removeImageWorker(worker));return worker;
  }
  private parkImageWorker(worker:Worker){
    this.idleImageWorker=worker;worker.unref();
    this.imageIdleTimer=setTimeout(()=>{
      this.idleImageWorker=undefined;this.imageIdleTimer=undefined;
      void worker.terminate().then(()=>this.removeImageWorker(worker),()=>{});
    },this.imageIdleMs);this.imageIdleTimer.unref();
  }
  private runPersistentImage<Result>(response:RssFetched,candidate:RssCandidate,valid:(value:unknown)=>value is Result):Promise<Result>{
    return new Promise((resolve,reject)=>{
      let worker:Worker;
      try{
        worker=this.idleImageWorker!;
        if(worker){this.idleImageWorker=undefined;clearTimeout(this.imageIdleTimer);this.imageIdleTimer=undefined;worker.ref();}
        else{
          // Four active jobs plus one idle worker retiring asynchronously. If
          // termination fails, tracked survivors cannot accumulate unboundedly.
          if(this.imageWorkers.size>=5)throw Object.assign(Error('来源解析繁忙，请稍后重试'),{statusCode:503,resourceBusy:true});
          worker=this.createImageWorker();
        }
      }catch(error){reject(error);return;}
      let settled=false;
      const finish=(error?:unknown,result?:Result,discard=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);
        // Keep the queue slot and input reservation until surplus/failed workers
        // really stop. Only one idle lightweight parser can remain resident.
        if(discard||this.closed||this.idleImageWorker){
          void worker.terminate().then(()=>{this.removeImageWorker(worker);if(error)reject(error);else resolve(result!);},reject);
        }else{
          this.parkImageWorker(worker);
          if(error)reject(error);else resolve(result!);
        }
      };
      const timer=setTimeout(()=>finish(Error('来源解析超时'),undefined,true),this.timeoutMs);timer.unref();
      const onMessage=(message:{error?:string;statusCode?:number;result?:unknown})=>{if(message?.error)finish(Object.assign(Error(message.error),{statusCode:message.statusCode}));else if(valid(message?.result))finish(undefined,message.result);else finish(Error('来源解析结果无效'),undefined,true);};
      const onError=(error:Error)=>finish(error,undefined,true),onExit=(code:number)=>finish(Error(`来源解析进程退出（${code}）`),undefined,true);
      worker.on('message',onMessage);worker.on('error',onError);worker.on('exit',onExit);
      try{worker.postMessage({response,candidate});}catch(error){finish(error,undefined,true);}
    });
  }
  private removeAIWorker(worker:Worker){this.aiWorkers.delete(worker);this.idleAIWorkers=this.idleAIWorkers.filter(item=>item!==worker);}
  private runPersistentAI<Result>(response:RssFetched,valid:(value:unknown)=>value is Result):Promise<Result>{
    return new Promise((resolve,reject)=>{
      let worker:Worker;
      try{worker=this.idleAIWorkers.pop()!;if(!worker){worker=new Worker(this.workerPath,{workerData:{persistentAI:true,modulePath:this.modulePath},resourceLimits:{maxOldGenerationSizeMb:256}});this.aiWorkers.add(worker);const created=worker;created.on('error',()=>this.removeAIWorker(created));created.on('exit',()=>this.removeAIWorker(created));}}
      catch(error){reject(error);return;}
      let settled=false;
      const finish=(error?:unknown,result?:Result,discard=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);
        if(discard){this.removeAIWorker(worker);void worker.terminate().then(()=>reject(error),reject);}
        else{this.idleAIWorkers.push(worker);if(error)reject(error);else resolve(result!);}
      };
      const timer=setTimeout(()=>finish(Error('来源解析超时'),undefined,true),this.timeoutMs);timer.unref();
      const onMessage=(message:{error?:string;statusCode?:number;result?:unknown})=>{if(message?.error)finish(Object.assign(Error(message.error),{statusCode:message.statusCode}));else if(valid(message?.result))finish(undefined,message.result);else finish(Error('来源解析结果无效'),undefined,true);};
      const onError=(error:Error)=>finish(error,undefined,true);
      const onExit=(code:number)=>finish(Error(`来源解析进程退出（${code}）`),undefined,true);
      worker.on('message',onMessage);worker.on('error',onError);worker.on('exit',onExit);
      try{worker.postMessage(response);}catch(error){finish(error,undefined,true);}
    });
  }
  private queue<T>(action:()=>Promise<T>):Promise<T>{
    return new Promise((resolve,reject)=>{
      this.pending.push(()=>{this.active++;void Promise.resolve().then(action).then(resolve,reject).finally(()=>{this.active--;this.drain();});});
      this.drain();
    });
  }
  private drain(){while(this.active<4&&this.pending.length)this.pending.shift()!();}
  async stop(){this.closed=true;clearTimeout(this.imageIdleTimer);this.imageIdleTimer=undefined;await Promise.allSettled([...this.jobs]);await Promise.all([...this.aiWorkers,...this.imageWorkers].map(worker=>worker.terminate()));this.aiWorkers.clear();this.idleAIWorkers=[];this.imageWorkers.clear();this.idleImageWorker=undefined;this.imageResults.clear();this.imagePending.clear();this.imageResultBytes=0;}
}
