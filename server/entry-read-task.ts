import {DatabaseSync} from 'node:sqlite';
import type {RivuDatabase} from './database';
import {queryEntry,queryEntries,type EntryQueryOptions} from './entry-query';
import {previewSmartFolder,smartFolderEntries} from './smart-folders';
import {queryFeedMetadata} from './feed-metadata-query';
import {queryFeedDeletionPreview,queryBulkFeedDeletionPreview} from './feed-delete-preview';
import {statSync} from 'node:fs';
import {EntryJsonCache} from './entry-json-cache';
import {randomUUID} from 'node:crypto';
import {querySerializedEntry,hasImageHint} from './entry-serialized-query';
export {EntryJsonCache};
export {universalSearchProof} from './search-universal-proof';

// A connection owns one physical database. Each request still starts and ends
// its own transaction, so retaining the handle never retains an old snapshot.
export class EntryReadConnection{
  private connection:DatabaseSync|undefined;
  private path:string|undefined;
  generation='';
  constructor(private pageCacheKiB=2048){if(!Number.isInteger(pageCacheKiB)||pageCacheKiB<1||pageCacheKiB>131072)throw Error('Invalid reader cache budget');}
  get(path:string){
    if(this.path!==path||!this.connection){
      this.close();
      const connection=new DatabaseSync(path,{readOnly:true,timeout:10000});
      // Budget belongs to this Worker role; detail/metadata retain a 2 MiB cache.
      try{connection.exec(`PRAGMA query_only=ON; PRAGMA cache_size=-${this.pageCacheKiB}`);}catch(error){connection.close();throw error;}
      this.connection=connection;this.path=path;this.generation=randomUUID();
    }
    return this.connection;
  }
  close(){const connection=this.connection;this.connection=undefined;this.path=undefined;this.generation='';connection?.close();}
}

export type EntryReadInput={databasePath:string}&(
  {kind:'entry';entryId:string;serialize?:boolean}|
  {kind:'image_presence';entryId:string;bodyRevision:string;cover:string|null}|
  {kind:'feed_metadata'}|
  {kind:'feed_delete_preview';feedId:string}|
  {kind:'feeds_delete_preview';selection:unknown}|
  {kind:'entries';options:EntryQueryOptions|undefined}|
  {kind:'smart_folder';folderId:string;limit:number;offset:number;cursor?:{sortTime:string;id:string}}|
  {kind:'smart_preview';query:unknown}
);

export function readEntrySnapshot(input:EntryReadInput,onSnapshot?:()=>void,jsonCache?:EntryJsonCache,reader?:EntryReadConnection){
  const fileIdentity=()=>{const file=statSync(input.databasePath,{bigint:true});return [file.dev,file.ino,file.birthtimeNs].map(String).join(':');};
  const before=(input.kind==='image_presence'||input.kind==='entry'&&input.serialize)&&jsonCache&&!reader?fileIdentity():undefined;
  const generation=reader?.generation;
  const connection=reader?reader.get(input.databasePath):new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
  if(reader&&generation!==reader.generation)jsonCache?.clear();
  try{
    connection.exec('PRAGMA query_only=ON; BEGIN');
    connection.prepare('SELECT 1 FROM entries LIMIT 1').get();onSnapshot?.();
    // Reuse query semantics without running a constructor, migrations or startup writes.
    const db={db:connection,entries:(options?:EntryQueryOptions)=>queryEntries(connection,options)} as RivuDatabase;
    switch(input.kind){
      case 'image_presence':{
        const metadata=queryEntry(connection,input.entryId,true);
        if(!metadata||metadata.body_revision!==input.bodyRevision||(metadata.cover??null)!==input.cover)return undefined;
        const stable=!!reader||before===fileIdentity(),key=JSON.stringify([input.databasePath,reader?.generation??before,input.entryId]);
        const cached=stable?jsonCache?.imageHint(key,JSON.stringify(metadata)):undefined;
        if(cached!==undefined)return cached;
        const row=queryEntry(connection,input.entryId);return row?hasImageHint(row):undefined;
      }
      case 'entry':{
        if(!input.serialize||!jsonCache)return queryEntry(connection,input.entryId);
        const stable=!!reader||before===fileIdentity(),key=JSON.stringify([input.databasePath,reader?.generation??before,input.entryId]);
        const metadata=queryEntry(connection,input.entryId,true);
        if(!metadata){jsonCache.delete(key);return undefined;}
        const signature=JSON.stringify(metadata),cached=stable?jsonCache.get(key,signature):undefined;
        if(cached)return {json:cached.buffer,imageHint:jsonCache.imageHint(key,signature)};
        const result=querySerializedEntry(connection,input.entryId,metadata);if(!result){jsonCache.delete(key);return undefined;}
        const {json,imageHint}=result;
        if(stable)jsonCache.put(key,signature,json,imageHint);return {json:json.buffer,imageHint};
      }
      case 'feed_metadata':return queryFeedMetadata(connection);
      case 'feed_delete_preview':return queryFeedDeletionPreview(connection,input.feedId);
      case 'feeds_delete_preview':return queryBulkFeedDeletionPreview(connection,input.selection);
      case 'entries':return db.entries(input.options);
      case 'smart_folder':return smartFolderEntries(db,input.folderId,input.limit,input.offset,input.cursor);
      case 'smart_preview':return previewSmartFolder(db,input.query);
      default:throw Error('文章读取任务无效');
    }
  }finally{try{if(connection.isTransaction)connection.exec('ROLLBACK');}finally{if(!reader)connection.close();}}
}
