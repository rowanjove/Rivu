import { JSDOM } from 'jsdom';
import type { RivuDatabase } from './database';
import type { ImageCache } from './image-cache';
import { fetchFullText,assertEntrySourceUnchanged,type FullTextParser } from './fulltext';
import type { MainWriteAccess } from './write-coordinator';

type OfflineEntry={id:string;body_revision?:string;url?:string;feed_url?:string;feed_allow_private?:number;content?:string;description?:string;full_content?:string;cover?:string;saved:number;rule_saved?:number};
type SaveStatus='none'|'running'|'ready'|'partial'|'failed'|'interrupted';
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export function imageUrls(entry:OfflineEntry){
  const source=entry.full_content||entry.content||entry.description||'';
  const page=new JSDOM(source);
  const raw=[entry.cover,...Array.from(page.window.document.querySelectorAll('img[src]'),image=>image.getAttribute('src'))];
  const urls=new Set<string>();
  for(const value of raw){if(!value)continue;try{const url=new URL(value,entry.url||entry.feed_url);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)urls.add(url.href);}catch{}}
  page.window.close();
  return [...urls];
}

export class OfflineSaver{
  private closed=false;
  private active=new Map<string,{includeImages:boolean;promise:Promise<unknown>}>();
  constructor(private db:RivuDatabase,private images:ImageCache,private parseFullText?:FullTextParser,private parseImages?:(entry:OfflineEntry)=>Promise<string[]>,private writeFullText?:Parameters<typeof fetchFullText>[3],private withMain:MainWriteAccess=async action=>action()){db.interruptOfflineSaves();}
  private async urls(entry:OfflineEntry){return this.parseImages?this.parseImages(entry):imageUrls(entry);}
  private entry(id:string){return this.db.entry(id) as OfflineEntry|undefined;}
  async status(id:string){
    const entry=this.entry(id);if(!entry)return undefined;
    const record=this.db.offlineSave(id);
    const urls=await this.urls(entry);
    let cached=0;for(const url of urls)if(await this.withMain(()=>this.images.isCached(url)))cached++;
    const feedBody=!!(entry.content?.trim()||entry.description?.trim());
    const fullText=!!entry.full_content?.trim();
    let status:SaveStatus='none';
    if(record){
      if(record.status==='running')status='running';
      else if(fullText&&(!record.include_images||cached===urls.length))status='ready';
      else if(record.status==='interrupted')status='interrupted';
      else status=fullText||feedBody||cached>0?'partial':'failed';
    }
    return {saved:!!(entry.saved||entry.rule_saved),feedBody,fullText,images:{cached,total:urls.length},status,requestedImages:!!record?.include_images,lastError:record?.last_error||((record?.include_images&&cached<urls.length&&record.status==='ready')?'部分图片已从缓存移除，请重试保存':null),updatedAt:record?.updated_at||null};
  }
  save(id:string,includeImages:boolean){
    if(this.closed)return Promise.reject(Object.assign(Error('离线保存正在停止'),{statusCode:503}));
    const existing=this.active.get(id);
    if(existing&&(!includeImages||existing.includeImages))return existing.promise;
    const task=existing?existing.promise.then(()=>this.saveInternal(id,true)):this.saveInternal(id,includeImages);
    const record={includeImages,promise:task};
    this.active.set(id,record);
    void task.then(()=>{if(this.active.get(id)===record)this.active.delete(id);},()=>{if(this.active.get(id)===record)this.active.delete(id);});
    return task;
  }
  async wait(){await Promise.allSettled([...this.active.values()].map(task=>task.promise));}
  async stop(){this.closed=true;await this.wait();}
  private async saveInternal(id:string,includeImages:boolean){
    const before=await this.withMain(()=>{
      const entry=this.entry(id);if(!entry)throw Object.assign(Error('文章不存在'),{statusCode:404});
      this.db.updateEntry(id,{saved:true});this.db.setOfflineSave(id,includeImages,'running');return entry;
    });
    try{
      const errors:string[]=[];
      if(!before.full_content){try{await fetchFullText(this.db,id,this.parseFullText,this.writeFullText);}catch(error){errors.push(`全文：${errorText(error)}`);}}
      const entry=this.entry(id);if(!entry)throw Object.assign(Error('文章已删除'),{statusCode:404});
      if(includeImages){
        const urls=await this.urls(entry);
        const origin=entry.feed_allow_private&&entry.feed_url?new URL(entry.feed_url).origin:undefined;
        let attempted=0;
        for(const url of urls){
          assertEntrySourceUnchanged(this.db,id,entry as unknown as Record<string,unknown>);
          if(await this.withMain(()=>this.images.isCached(url)))continue;
          if(attempted>=20)break;
          attempted++;
          try{const result=await this.withMain(()=>this.images.cache(url,origin,true,()=>{assertEntrySourceUnchanged(this.db,id,entry as unknown as Record<string,unknown>);return origin;}));if(!result.cached)errors.push(`图片：${url} 未保存`);}catch(error){errors.push(`图片：${errorText(error)}`);}
        }
      }
      const current=await this.status(id);
      const complete=!!current?.fullText&&(!includeImages||current.images.cached===current.images.total);
      if(!complete&&includeImages&&current&&current.images.total-current.images.cached>20)errors.push('还有更多图片未保存，可再次点击继续缓存');
      const resultStatus=complete?'ready':current?.fullText||current?.feedBody?'partial':'failed';
      await this.withMain(()=>{assertEntrySourceUnchanged(this.db,id,entry as unknown as Record<string,unknown>);this.db.setOfflineSave(id,includeImages,resultStatus,complete?undefined:errors.slice(0,3).join('；')||'离线内容尚未完整');});
      return this.status(id);
    }catch(error){
      await this.withMain(()=>{const latest=this.entry(id),partial=!!(latest?.full_content||latest?.content||latest?.description);this.db.setOfflineSave(id,includeImages,partial?'partial':'failed',errorText(error));});
      return this.status(id);
    }
  }
}
