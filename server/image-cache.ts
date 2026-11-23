import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RivuDatabase } from './database';
import { requestBytes } from './network';

const MIB=1024*1024;
const MAX_IMAGE=8*MIB;
const MIME_EXT:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif'};
const validFileName=(name:string)=>/^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/.test(name);
export type ImageCacheSettings={enabled:boolean;maxBytes:number};
export type ImageFetchAccess=()=>string|undefined;
type WaitExternal=<T>(action:()=>Promise<T>)=>Promise<T>;
const DEFAULTS:ImageCacheSettings={enabled:false,maxBytes:1024*MIB};
function validateSettings(raw:unknown):Partial<ImageCacheSettings>{
  const bad=(message:string)=>Object.assign(Error(message),{statusCode:400});
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['enabled','maxBytes'].includes(key)))throw bad('缓存设置字段无效');
  const patch=raw as Partial<ImageCacheSettings>;
  if(Object.hasOwn(patch,'enabled')&&typeof patch.enabled!=='boolean')throw bad('缓存开关无效');
  if(Object.hasOwn(patch,'maxBytes')&&![0,1,2,5,10].map(x=>x*1024*MIB).includes(patch.maxBytes!))throw bad('缓存上限无效');
  return patch;
}

export class ImageCache{
  private settings:ImageCacheSettings;
  private directory?:string;
  private queue=Promise.resolve();
  private cleanupError:string|null=null;
  private settingsError:Error|null=null;
  constructor(private db:RivuDatabase,private settingsPath?:string,dataDir?:string,private awaitExternal:WaitExternal=async action=>action()){this.directory=dataDir?join(dataDir,'cache','images'):undefined;this.settings={...DEFAULTS};this.readSettings();}
  private queued<T>(action:()=>Promise<T>,signal?:AbortSignal){
    signal?.throwIfAborted();
    const previous=this.queue;
    let started=false;
    const task=(async()=>{await this.awaitExternal(()=>previous);signal?.throwIfAborted();started=true;return action();})();
    this.queue=task.then(()=>{},()=>{});
    if(!signal)return task;
    return new Promise<T>((resolve,reject)=>{
      // An aborted waiter releases its caller immediately but remains a skipped
      // queue link. Started work keeps its lease through IO/atomic publication.
      const aborted=()=>{if(!started)reject(signal.reason??Error('图片请求已中止'));};
      signal.addEventListener('abort',aborted,{once:true});
      void task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
      if(signal.aborted)aborted();
    });
  }
  private readSettings(){
    try{
      let next={...DEFAULTS};
      if(this.settingsPath){
        let document:unknown;
        try{document=JSON.parse(readFileSync(this.settingsPath,'utf8'));}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;document={};}
        if(!document||typeof document!=='object'||Array.isArray(document))throw Error('设置文件格式无效');
        const value=(document as Record<string,unknown>).imageCache;
        if(value!==undefined)next={...next,...validateSettings(value)};
      }
      this.settings=next;this.settingsError=null;
    }catch(cause){this.settingsError=Error('图片缓存配置读取失败，请修复本地设置文件后重新加载；原文件和缓存会保留',{cause});}
  }
  getSettings(){if(this.settingsError)this.readSettings();if(this.settingsError)throw this.settingsError;return {...this.settings};}
  async configure(raw:unknown){
    const patch=validateSettings(raw);
    this.getSettings();
    const next={...this.settings,...patch};
    if(this.settingsPath){
      let content:Record<string,unknown>={};
      try{const value:unknown=JSON.parse(readFileSync(this.settingsPath,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('设置文件格式无效');content=value as Record<string,unknown>;}
      catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw Error('无法读取现有设置文件，图片缓存配置未更新',{cause});}
      mkdirSync(dirname(this.settingsPath),{recursive:true});const temp=`${this.settingsPath}.${randomUUID()}.tmp`;
      const descriptor=openSync(temp,'wx');
      try{try{writeFileSync(descriptor,JSON.stringify({...content,imageCache:next},null,2),'utf8');}finally{closeSync(descriptor);}renameSync(temp,this.settingsPath);}
      catch(cause){try{rmSync(temp,{force:true});}catch{}throw cause;}
    }
    // Publish only after the atomic settings file replacement succeeds.
    this.settings=next;
    const task=this.queued(()=>this.enforceLimit());
    try{await task;}catch(cause){throw Object.assign(Error('图片缓存设置已保存，但限额清理失败，请重新加载后重试限额清理',{cause}),{settingsApplied:true});}
    return {...next};
  }
  private normalizedUrl(raw:string){const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('仅支持 HTTP/HTTPS 图片');return url.href;}
  async lookup(raw:string,authorize?:ImageFetchAccess,deferMaintenance?:(url:string,action:()=>void)=>void,signal?:AbortSignal){
    const image=await this.lookupBytes(raw,authorize,deferMaintenance,signal);
    return image?{dataUrl:`data:${image.mime};base64,${image.data.toString('base64')}`,bytes:image.data.length}:null;
  }
  async lookupBytes(raw:string,authorize?:ImageFetchAccess,deferMaintenance?:(url:string,action:()=>void)=>void,signal?:AbortSignal){
    signal?.throwIfAborted();
    const url=this.normalizedUrl(raw);if(!this.directory)return null;
    const row=this.db.cachedImage(url);if(!row)return null;
    const mutate=(action:()=>void)=>{
      if(!deferMaintenance){action();return;}
      // Never evict or touch a replacement row after waiting for write access.
      deferMaintenance(url,()=>{if(JSON.stringify(this.db.cachedImage(url))===JSON.stringify(row))action();});
    };
    if(!validFileName(row.file_name)){mutate(()=>this.db.deleteCachedImage(url));return null;}
    authorize?.();const path=join(this.directory,row.file_name);let bytes:Buffer;
    try{bytes=await this.awaitExternal(()=>readFile(path,{signal}));}catch(error){if(signal?.aborted)throw error;mutate(()=>{if(!deferMaintenance||!existsSync(path))this.db.deleteCachedImage(url);});return null;}
    signal?.throwIfAborted();
    authorize?.();
    const current=this.db.cachedImage(url);
    if(!current||current.file_name!==row.file_name||current.mime!==row.mime||current.bytes!==row.bytes)return null;
    mutate(()=>this.db.touchCachedImage(url));
    if(!MIME_EXT[row.mime]||!bytes.length||bytes.length>MAX_IMAGE)throw Error('图片缓存内容无效');
    return {data:bytes,mime:row.mime};
  }
  async isCached(raw:string){const url=this.normalizedUrl(raw);const row=this.db.cachedImage(url);if(!row||!this.directory)return false;if(!validFileName(row.file_name)){this.db.deleteCachedImage(url);return false;}try{const info=await this.awaitExternal(()=>stat(join(this.directory!,row.file_name)));return info.isFile()&&info.size===row.bytes;}catch{this.db.deleteCachedImage(url);return false;}}
  async load(raw:string,privateOrigin?:string,authorize?:ImageFetchAccess){const image=await this.loadBytes(raw,privateOrigin,authorize);return {dataUrl:`data:${image.mime};base64,${image.data.toString('base64')}`,bytes:image.data.length};}
  async loadBytes(raw:string,privateOrigin?:string,authorize?:ImageFetchAccess,signal?:AbortSignal){signal?.throwIfAborted();const url=this.normalizedUrl(raw);const cached=await this.lookupBytes(url,authorize,undefined,signal);if(cached)return cached;if(this.settings.enabled&&this.directory){await this.cache(url,privateOrigin,false,authorize,signal);const stored=await this.lookupBytes(url,authorize,undefined,signal);if(stored)return stored;}const origin=authorize?authorize():privateOrigin;const response=await this.awaitExternal(()=>requestBytes(url,MAX_IMAGE,'image/avif,image/webp,image/png,image/jpeg,image/gif',origin,undefined,undefined,signal));signal?.throwIfAborted();authorize?.();const mime=response.type.split(';')[0].trim().toLowerCase();if(!MIME_EXT[mime]||!response.bytes.length)throw Error('不支持此图片格式');return {data:response.bytes,mime};}
  cache(raw:string,privateOrigin?:string,explicit=false,authorize?:ImageFetchAccess,signal?:AbortSignal){return this.queued(()=>this.cacheInternal(raw,privateOrigin,explicit,authorize,signal),signal);}
  async wait(){await this.queue;}
  private async cacheInternal(raw:string,privateOrigin?:string,explicit=false,authorize?:ImageFetchAccess,signal?:AbortSignal){signal?.throwIfAborted();if(this.settingsError)throw this.settingsError;const url=this.normalizedUrl(raw);if((!this.settings.enabled&&!explicit)||!this.directory)return {cached:false};if(this.db.cachedImage(url)){const found=await this.lookup(url,authorize,undefined,signal);if(found)return {cached:true,bytes:found.bytes};}
    const origin=authorize?authorize():privateOrigin;const response=await this.awaitExternal(()=>requestBytes(url,MAX_IMAGE,'image/avif,image/webp,image/png,image/jpeg,image/gif',origin,undefined,undefined,signal));signal?.throwIfAborted();authorize?.();const mime=response.type.split(';')[0].trim().toLowerCase();const ext=MIME_EXT[mime];if(!ext)throw Error('不支持此图片格式');const bytes=response.bytes;if(!bytes.length)throw Error('图片为空');
    mkdirSync(this.directory,{recursive:true});const fileName=`${createHash('sha256').update(url).digest('hex')}.${ext}`;const target=join(this.directory,fileName);const temp=`${target}.${randomUUID()}.tmp`;let renamed=false,indexed=false;
    try{await this.awaitExternal(()=>writeFile(temp,bytes,{signal}));signal?.throwIfAborted();authorize?.();await this.awaitExternal(()=>rm(target,{force:true}));authorize?.();renameSync(temp,target);renamed=true;this.db.saveCachedImage(url,fileName,mime,bytes.length);indexed=true;}
    catch(error){if(renamed&&!indexed)await this.awaitExternal(()=>rm(target,{force:true}));throw error;}
    finally{await this.awaitExternal(()=>rm(temp,{force:true}));}
    await this.enforceLimit();return {cached:true,bytes:bytes.length};
  }
  private async enforceLimit(){
    try{if(this.directory&&this.settings.maxBytes!==0){const rows=this.db.cachedImages();let total=rows.reduce((n,row)=>n+row.bytes,0);for(const row of rows){if(total<=this.settings.maxBytes)break;if(validFileName(row.file_name))await this.awaitExternal(()=>rm(join(this.directory!,row.file_name),{force:true}));this.db.deleteCachedImage(row.url);total-=row.bytes;}}this.cleanupError=null;}
    catch(cause){this.cleanupError='缓存限额清理未完成';throw cause;}
  }
  async stats(){const rows=this.db.cachedImages(),indexedBytes=rows.reduce((sum,row)=>sum+row.bytes,0);let onDisk=0;if(this.directory)for(const row of rows){if(!validFileName(row.file_name))continue;try{const info=await this.awaitExternal(()=>stat(join(this.directory!,row.file_name)));if(info.isFile())onDisk+=info.size;}catch{}}return {count:rows.length,bytes:onDisk,cleanupError:this.cleanupError,needsCleanup:!!this.directory&&(this.cleanupError!==null||this.settings.maxBytes>0&&indexedBytes>this.settings.maxBytes)};}
}
