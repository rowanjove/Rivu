import {getArchive} from './archive-read';
import {queryFeedDeletionPreview} from './feed-delete-preview';
export {archiveStats,listArchives,getArchive,archiveVersion,archiveAsset} from './archive-read';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { JSDOM } from 'jsdom';
import createDOMPurify,{type WindowLike} from 'dompurify';
import {articleHtmlPolicy} from '../shared/article-policy';
import {archiveAssetExtension} from './archive-export-format';
import yazl from 'yazl';
import type { RivuDatabase } from './database';
import { requestBytes } from './network';
import { bodyImages, uniqueMedia,type EntryMedia } from './media';
import {ARCHIVE_LIMIT,archiveSourceSnapshot,assertArchiveSourceUnchanged,commitArchiveWrite,type ArchiveWriteInput,type ArchiveWriteResult} from './archive-write';
import type {MainWriteAccess} from './write-coordinator';

const LIMIT=ARCHIVE_LIMIT;
const bad=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
type Archive={id:string;source_entry_id:string;feed_id:string;feed_title:string;title:string;url:string|null;created_at:string;updated_at:string};
type Version={id:string;archive_id:string;content_hash:string;body_html:string;created_at:string};
type Asset={id:string;archive_id:string;version_id:string;kind:'image'|'audio'|'video'|'snapshot';url:string;mime:string;bytes:number;data:Uint8Array};
export type SaveOptions={images?:boolean;attachments?:boolean;snapshot?:boolean};
export type ArchiveSaveAccess={withMain:MainWriteAccess;parseImages:(html:string,base:string)=>Promise<EntryMedia[]>;write:(input:ArchiveWriteInput)=>Promise<ArchiveWriteResult>;fetch?:typeof requestBytes};
export function validateArchiveOptions(options:SaveOptions){if(!options||typeof options!=='object'||Array.isArray(options)||['images','attachments','snapshot'].some(key=>options[key as keyof SaveOptions]!==undefined&&typeof options[key as keyof SaveOptions]!=='boolean'))throw bad('归档选项无效');}

export function feedDeletionPreview(db:RivuDatabase,id:string){return queryFeedDeletionPreview(db.db,id);}

export async function saveArchive(db:RivuDatabase,entryId:string,options:SaveOptions={},access?:ArchiveSaveAccess){
  validateArchiveOptions(options);
  const main:MainWriteAccess=access?.withMain|| (async action=>action());
  const initial=await main(()=>{const entry=db.entry(entryId);if(!entry)throw bad('文章不存在',404);const archive=db.db.prepare('SELECT id FROM permanent_archives WHERE source_entry_id=?').get(entryId) as {id:string}|undefined;return {entry,expected:archiveSourceSnapshot(entry),expectedArchiveId:archive?.id||null,media:db.entryMedia(entryId)};});
  const {entry,expected,expectedArchiveId}=initial,body=String(entry.full_content||entry.content||entry.description||''),base=String(entry.url||entry.feed_url);
  const images=options.images?await (access?access.parseImages(body,base):bodyImages(body,base)):[];
  const write=access?.write||(async(input:ArchiveWriteInput)=>main(()=>commitArchiveWrite(db,input)));
  const committed=await write({kind:'archive_body',databasePath:db.path,entryId,expected,expectedArchiveId});
  const media=uniqueMedia([...initial.media,...images]).filter(item=>options.images&&item.kind==='image'||options.attachments&&(item.kind==='audio'||item.kind==='video'));
  const requests=[...media.map(item=>({kind:item.kind,url:item.url})),...(options.snapshot&&entry.url?[{kind:'snapshot' as const,url:String(entry.url)}]:[])];
  const privateOrigin=entry.feed_allow_private?new URL(String(entry.feed_url)).origin:undefined;
  const authorize=()=>{assertArchiveSourceUnchanged(db,entryId,expected);const latest=db.db.prepare('SELECT v.id FROM archive_versions v JOIN permanent_archives p ON p.id=v.archive_id WHERE p.id=? AND p.source_entry_id=? ORDER BY v.created_at DESC,v.rowid DESC LIMIT 1').get(committed.archiveId,entryId) as {id:string}|undefined;if(!latest)throw bad('永久归档已删除',404);if(latest.id!==committed.versionId)throw bad('归档版本已变化，请重新保存资源',409);};
  const errors:string[]=[];let added=0;
  for(const item of requests){
    const exists=await main(()=>{authorize();return !!db.db.prepare('SELECT 1 FROM archive_assets WHERE version_id=? AND kind=? AND url=?').get(committed.versionId,item.kind,item.url);});if(exists)continue;
    try{
      const max=item.kind==='image'?8*1024*1024:item.kind==='snapshot'?5*1024*1024:25*1024*1024;
      const result=await (access?.fetch||requestBytes)(item.url,max,item.kind==='image'?'image/avif,image/webp,image/png,image/jpeg,image/gif':item.kind==='snapshot'?'text/html':`${item.kind}/*,application/octet-stream`,privateOrigin,undefined,authorize);
      const mime=result.type.split(';')[0].trim().toLowerCase();
      const saved=await write({kind:'archive_asset',databasePath:db.path,entryId,expected,archiveId:committed.archiveId,versionId:committed.versionId,assetKind:item.kind,url:item.url,mime,data:result.bytes});added+=saved.added;
    }catch(error){const failure=error as {statusCode?:number;resourceBusy?:boolean;outcomeUnknown?:boolean};if(failure.statusCode===404||failure.statusCode===409||failure.resourceBusy||failure.outcomeUnknown)throw error;const label={image:'图片',audio:'音频',video:'视频',snapshot:'网页快照'}[item.kind];errors.push(`${label} · ${item.url}: ${error instanceof Error?error.message:String(error)}`);}
  }
  return main(()=>{authorize();return {...getArchive(db,committed.archiveId),newVersion:committed.newVersion,assetsAdded:added,errors};});
}

export function deleteArchive(db:RivuDatabase,id:string){return {deleted:db.db.prepare('DELETE FROM permanent_archives WHERE id=?').run(id).changes};}

function safeHtml(raw:string,base:string|null,assets:Map<string,string>){
  const dom=new JSDOM(''),doc=dom.window.document;
  try{
  doc.body.innerHTML=createDOMPurify(dom.window as unknown as WindowLike).sanitize(raw,articleHtmlPolicy(true));
  for(const element of doc.querySelectorAll('*')){
    for(const attr of [...element.attributes])if(attr.name.startsWith('on')||['style','srcset'].includes(attr.name))element.removeAttribute(attr.name);
    for(const name of ['src','poster','href']){const value=element.getAttribute(name);element.removeAttribute(name);if(!value?.trim())continue;try{const url=new URL(value,base||undefined);if(!['http:','https:'].includes(url.protocol)){element.removeAttribute(name);continue;}if(name!=='href'){
      const tag=element.tagName.toLowerCase(),parent=tag==='source'?element.parentElement?.tagName.toLowerCase():tag;
      const kind=name==='poster'||tag==='img'?'image':parent==='audio'||parent==='video'?parent:null;
      const path=kind?assets.get(`${kind}:${url.href}`):undefined;if(path)element.setAttribute(name,path);else element.removeAttribute(name);
    }else element.setAttribute(name,url.href);}catch{element.removeAttribute(name);}}
  }
  return doc.body.innerHTML;
  }finally{dom.window.close();}
}
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
type AssetMeta=Omit<Asset,'data'>;
const dataStream=(value:Uint8Array|string)=>Readable.from([Buffer.from(value)]);
export async function exportArchive(db:RivuDatabase,id:string,dest:string,temporaryPath?:string){
  const record=getArchive(db,id),zip=new yazl.ZipFile(),versions=db.db.prepare('SELECT id,archive_id,content_hash,created_at FROM archive_versions WHERE archive_id=? ORDER BY created_at ASC,rowid ASC').all(id) as Omit<Version,'body_html'>[];
  const temp=temporaryPath||`${dest}.${randomUUID()}.tmp`,output=zip.outputStream as Readable;
  zip.on('error',error=>output.destroy(error));
  const completion=pipeline(output,createWriteStream(temp));completion.catch(()=>{});
  const manifests:{versionId:string;createdAt:string;sha256:string;assets:{kind:string;mime:string;url:string;path:string;bytes:number}[]}[]=[];
  let committed=false;
  try{
    for(let index=0;index<versions.length;index++){
      const version=versions[index],assetPaths=new Map<string,string>(),listed:{kind:string;mime:string;url:string;path:string;bytes:number}[]=[];
      const assets=db.db.prepare('SELECT id,archive_id,version_id,kind,url,mime,bytes FROM archive_assets WHERE version_id=?').all(version.id) as AssetMeta[];
      for(const asset of assets){
        const ext=archiveAssetExtension(asset.kind,asset.mime),name=`assets/${asset.id}.${ext}`;
        zip.addReadStreamLazy(name,{},callback=>{
          try{
            const row=db.db.prepare('SELECT data FROM archive_assets WHERE id=? AND version_id=?').get(asset.id,version.id) as {data:Uint8Array}|undefined;
            if(!row)throw Error('归档资源在导出期间被删除');
            const value=asset.kind==='snapshot'?`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><body>${safeHtml(Buffer.from(row.data).toString('utf8'),asset.url,new Map())}</body>`:row.data;
            callback(null,dataStream(value));
          }catch(error){callback(error as Error,Readable.from([]));}
        });
        assetPaths.set(`${asset.kind}:${asset.url}`,name);listed.push({kind:asset.kind,mime:asset.mime,url:asset.url,path:name,bytes:asset.bytes});
      }
      const html=(root:boolean,body:string)=>{const paths=new Map([...assetPaths].map(([url,path])=>[url,root?path:`../${path}`]));const links=listed.filter(a=>a.kind!=='image').map(a=>`<li><a href="${root?a.path:`../${a.path}`}"${a.path.endsWith('.bin')?' download':''}>${escape(a.kind==='snapshot'?'来源网页快照':a.kind==='audio'?'音频附件':'视频附件')}</a> (${escape(a.url)})</li>`).join('');return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(record.title)}</title></head><body><h1>${escape(record.title)}</h1><p>${escape(record.feed_title)} · ${escape(record.url||'')}</p>${safeHtml(body,record.url,paths)}${links?`<h2>本地附件与快照</h2><ul>${links}</ul>`:''}</body></html>`;};
      const addPage=(name:string,root:boolean)=>zip.addReadStreamLazy(name,{},callback=>{
        try{const row=db.db.prepare('SELECT body_html FROM archive_versions WHERE id=? AND archive_id=?').get(version.id,id) as {body_html:string}|undefined;if(!row)throw Error('归档版本在导出期间被删除');callback(null,dataStream(html(root,row.body_html)));}catch(error){callback(error as Error,Readable.from([]));}
      });
      addPage(`versions/${String(index+1).padStart(3,'0')}.html`,false);
      if(index===versions.length-1)addPage('index.html',true);
      manifests.push({versionId:version.id,createdAt:version.created_at,sha256:version.content_hash,assets:listed});
    }
    zip.addBuffer(Buffer.from(JSON.stringify({title:record.title,url:record.url,feedTitle:record.feed_title,createdAt:record.created_at,versions:manifests},null,2)),'metadata.json');
    zip.end();await completion;await rename(temp,dest);committed=true;
    return dest;
  }catch(error){output.destroy(error as Error);await completion.catch(()=>{});throw error;}
  finally{if(!committed)await rm(temp,{force:true});}
}
