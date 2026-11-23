import {createHash,randomUUID} from 'node:crypto';
import type {RivuDatabase} from './database';
import {assertEntrySourceUnchanged,entrySourceSnapshot} from './entry-source';

export const ARCHIVE_LIMIT=1024*1024*1024;
type Base={databasePath:string;entryId:string;expected:Record<string,unknown>;operationId?:string};
export type ArchiveBodyWriteInput=Base&{kind:'archive_body';expectedArchiveId:string|null};
export type ArchiveAssetWriteInput=Base&{kind:'archive_asset';archiveId:string;versionId:string;assetKind:'image'|'audio'|'video'|'snapshot';url:string;mime:string;data:Uint8Array};
export type ArchiveWriteInput=ArchiveBodyWriteInput|ArchiveAssetWriteInput;
export type ArchiveWriteResult={added:number;total:number;archiveId:string;versionId:string;newVersion:boolean};
const bad=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
export function archiveSourceSnapshot(entry:Record<string,unknown>){return {...entrySourceSnapshot(entry),title:entry.title,feed_title:entry.feed_title};}
export function assertArchiveSourceUnchanged(db:RivuDatabase,id:string,expected:Record<string,unknown>){const current=assertEntrySourceUnchanged(db,id,expected);if(current.title!==expected.title||current.feed_title!==expected.feed_title)throw bad('文章或订阅标题已变化，请重新归档',409);return current;}
function usedBytes(db:RivuDatabase){return Number((db.db.prepare('SELECT (SELECT COALESCE(sum(bytes),0) FROM archive_assets)+(SELECT COALESCE(sum(octet_length(body_html)),0) FROM archive_versions) bytes').get() as {bytes:number}).bytes);}

export function commitArchiveWrite(db:RivuDatabase,input:ArchiveWriteInput):ArchiveWriteResult{
  db.db.exec('BEGIN IMMEDIATE');
  try{
    const entry=assertArchiveSourceUnchanged(db,input.entryId,input.expected),now=new Date().toISOString();let result:ArchiveWriteResult;
    if(input.kind==='archive_body'){
      const body=String(entry.full_content||entry.content||entry.description||'');if(!body.replace(/<[^>]*>/g,'').trim())throw bad('这篇文章尚无可归档正文，请先获取全文');
      const existing=db.db.prepare('SELECT id FROM permanent_archives WHERE source_entry_id=?').get(input.entryId) as {id:string}|undefined;
      if(input.expectedArchiveId&& !existing)throw bad('永久归档已删除，请重新确认保存',404);
      if((existing?.id||null)!==input.expectedArchiveId)throw bad('永久归档已变化，请重新确认保存',409);
      const archiveId=existing?.id||randomUUID(),digest=createHash('sha256').update(body).digest('hex');
      const latest=db.db.prepare('SELECT id,content_hash FROM archive_versions WHERE archive_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(archiveId) as {id:string;content_hash:string}|undefined;
      const newVersion=!latest||latest.content_hash!==digest,versionId=newVersion?randomUUID():latest.id;
      if(newVersion&&usedBytes(db)+Buffer.byteLength(body)>ARCHIVE_LIMIT)throw bad('永久归档已达到 1 GiB 容量上限');
      if(existing)db.db.prepare('UPDATE permanent_archives SET feed_title=?,title=?,url=?,updated_at=? WHERE id=?').run(entry.feed_title,entry.title,entry.url,now,archiveId);
      else db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(archiveId,input.entryId,entry.feed_id,entry.feed_title,entry.title,entry.url,now,now);
      if(newVersion)db.db.prepare('INSERT INTO archive_versions(id,archive_id,content_hash,body_html,created_at) VALUES (?,?,?,?,?)').run(versionId,archiveId,digest,body,now);
      result={added:Number(newVersion),total:1,archiveId,versionId,newVersion};
    }else{
      const archive=db.db.prepare('SELECT source_entry_id FROM permanent_archives WHERE id=?').get(input.archiveId) as {source_entry_id:string}|undefined;
      if(!archive)throw bad('永久归档已删除',404);
      const latest=db.db.prepare('SELECT id,content_hash FROM archive_versions WHERE archive_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(input.archiveId) as {id:string;content_hash:string}|undefined;
      if(archive.source_entry_id!==input.entryId||latest?.id!==input.versionId||latest.content_hash!==createHash('sha256').update(String(entry.full_content||entry.content||entry.description||'')).digest('hex'))throw bad('归档版本已变化，请重新保存资源',409);
      const existing=db.db.prepare('SELECT 1 FROM archive_assets WHERE version_id=? AND kind=? AND url=?').get(input.versionId,input.assetKind,input.url);
      const max=input.assetKind==='image'?8*1024*1024:input.assetKind==='snapshot'?5*1024*1024:25*1024*1024;
      const valid=input.assetKind==='image'?['image/avif','image/webp','image/png','image/jpeg','image/gif'].includes(input.mime):input.assetKind==='snapshot'?input.mime==='text/html':input.mime.startsWith(`${input.assetKind}/`)||input.mime==='application/octet-stream';
      if(!valid||!input.data.byteLength||input.data.byteLength>max)throw bad('资源类型不受支持或大小无效');
      if(!existing){if(usedBytes(db)+input.data.byteLength>ARCHIVE_LIMIT)throw bad('永久归档容量不足');db.db.prepare('INSERT INTO archive_assets(id,archive_id,version_id,kind,url,mime,bytes,data) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),input.archiveId,input.versionId,input.assetKind,input.url,input.mime,input.data.byteLength,input.data);}
      result={added:Number(!existing),total:1,archiveId:input.archiveId,versionId:input.versionId,newVersion:false};
    }
    if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`archive-write:${input.entryId}`,JSON.stringify({operationId:input.operationId,result}));
    db.db.exec('COMMIT');return result;
  }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
}
