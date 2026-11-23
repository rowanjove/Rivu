export type RuntimeDiagnostics={build:{version:string;buildId:string;builtAt:string;sourceHash:string};schemaVersion:number;runtime:{electron:string;node:string;chrome:string;undici:string};fetchImplementation:string};
export type Feed={id:string;title:string;url:string;site_url?:string;description?:string;icon?:string|null;iconKey?:string|null;category_id?:string|null;category_name?:string;unread_count:number;last_error?:string;last_fetched_at?:string;last_success_at?:string|null;next_fetch_at?:string;failure_count:number;fetch_interval:number;enabled:number;allow_private:number;folder_authorized:number;health:'healthy'|'retrying'|'error'|'paused';type:'rss'|'rsshub'|'custom_json'|'newsletter';json_mapping?:string|null};
export type JsonMapping={itemsPath:string;titlePath:string;idPath:string;urlPath:string;datePath:string;contentPath:string;summaryPath:string;authorPath:string;imagePath:string};
export type Category={id:string;name:string};
export type Tag={id:string;name:string;color:string;manual?:number;rule_based?:number};
export type RsshubInstance={id:string;name:string;base_url:string;enabled:number;allow_private:number};
export type SmartFolder={id:string;name:string;query:string;sort:number;created_at:string;updated_at:string};
export type Entry={id:string;feed_id:string;feed_title:string;title:string;author?:string;url?:string;published_at?:string;fetched_at:string;content?:string;full_content?:string;full_content_fetched_at?:string;description?:string;read:number;starred:number;saved:number;rule_saved?:number;rule_muted?:number;rule_blocked?:number;cover?:string};
export type EntryMedia={kind:'image'|'audio'|'video';url:string;mime:string|null;source:'cover'|'body'|'enclosure'|'metadata';title:string|null};
export type OfflineStatus={saved:boolean;feedBody:boolean;fullText:boolean;images:{cached:number;total:number};status:'none'|'running'|'ready'|'partial'|'failed'|'interrupted';requestedImages:boolean;lastError:string|null;updatedAt:string|null};
export type Preview={title:string;url:string;siteUrl?:string;description?:string;icon?:string;items:Partial<Entry>[]};
export type OpmlItem={index:number;title:string;url:string;sourceCategory:string;status:'new'|'duplicate'|'invalid';reason?:string;jsonMapping?:string};
export type OpmlPreview={items:OpmlItem[];newCount:number;duplicateCount:number;invalidCount:number};
export type OpmlImportResult={imported:number;skipped:number;failed:number;results:{index:number;status:'imported'|'skipped'|'failed';reason?:string}[]};
declare global { interface Window { rivu:{diagnostics?:()=>Promise<RuntimeDiagnostics>;accessibilitySupportEnabled?:()=>boolean;onAccessibilitySupportChanged?:(callback:(enabled:boolean)=>void)=>()=>void;setWindowTheme?:(theme:'light'|'dark')=>Promise<void>;cancelImageUrl:(url:string)=>Promise<void>;readImageUrl:(url:string)=>Promise<{bytes:Uint8Array<ArrayBuffer>;mime:string}|null>;imageUrl:(entryId:string,url:string,mode?:'lookup'|'load')=>Promise<string>;request:(method:string,path:string,body?:unknown)=>Promise<any>;chooseFile:(kind:'backup')=>Promise<any>;previewOpml:()=>Promise<{id:string;preview:OpmlPreview}|null>;importOpml:(id:string,options:{selected:number[];categoryMap:Record<string,string|null>})=>Promise<OpmlImportResult>;previewNewsletter:()=>Promise<{id:string;folder:string;count:number;samples:{file:string;title:string;sender:string}[];skipped:number}|null>;subscribeNewsletter:(id:string,title:string,categoryId?:string)=>Promise<Feed>;reconnectNewsletter:(id:string)=>Promise<Feed|null>;saveFile:(kind:'opml'|'backup'|'archive',options?:{includeSecrets?:boolean;archiveId?:string})=>Promise<any>;openExternal:(url:string)=>Promise<void>;onExternalError:(callback:(message:string)=>void)=>()=>void;openBackupDirectory:()=>Promise<void>}} }
export const api={
  cancelImageUrl:(url:string)=>window.rivu.cancelImageUrl(url),
  readImageUrl:(url:string)=>window.rivu.readImageUrl(url),
  imageUrl:(entryId:string,url:string,mode:'lookup'|'load'='load')=>window.rivu.imageUrl(entryId,url,mode),
  get:<T>(path:string)=>window.rivu.request('GET',path) as Promise<T>,
  post:<T>(path:string,body?:unknown)=>window.rivu.request('POST',path,body) as Promise<T>,
  patch:<T>(path:string,body:unknown)=>window.rivu.request('PATCH',path,body) as Promise<T>,
  put:<T>(path:string,body:unknown)=>window.rivu.request('PUT',path,body) as Promise<T>,
  del:<T>(path:string)=>window.rivu.request('DELETE',path) as Promise<T>
};
