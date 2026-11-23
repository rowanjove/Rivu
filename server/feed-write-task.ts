import {createHash} from 'node:crypto';
import {RivuDatabase,type EntryInput} from './database';
import {applyEnabledRules} from './rules';
import {assertEntrySourceUnchanged} from './entry-source';
import {commitNewsletterScan} from './newsletter-scan';
import type {NewsletterScan} from './newsletter';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {commitArchiveWrite,type ArchiveWriteInput} from './archive-write';
export {writeBulkRead} from './bulk-read-write';
export {writeFeedCategory} from './feed-category-write';
export {writeFeedDelete,readFeedDeleteReceipt} from './feed-delete-write';
export {writeFeedMetadata,readFeedMetadataReceipt} from './feed-metadata-write';
export function writeArchiveBatch(input:ArchiveWriteInput){const db=new RivuDatabase(input.databasePath,undefined,true);try{db.db.exec('PRAGMA busy_timeout=10000');return commitArchiveWrite(db,input);}finally{db.close();}}
export type EntryStateWriteInput={kind:'entry_state';databasePath:string;entryId:string;patch:{read?:boolean;starred?:boolean;saved?:boolean;archived?:boolean};operationId?:string};
export type EntryStateWriteResult={added:0;total:0|1;json?:ArrayBuffer};
export function writeEntryState(input:EntryStateWriteInput):EntryStateWriteResult{
  const db=new RivuDatabase(input.databasePath,undefined,true);
  try{
    db.db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    try{
      const entry=db.updateEntry(input.entryId,input.patch);
      // Encode before commit: a read/encoding failure must roll back the status change.
      const json=entry?new TextEncoder().encode(JSON.stringify(entry)).buffer:undefined;
      const total=entry?1:0;
      if(input.operationId&&entry)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`entry-state-write:${input.entryId}`,JSON.stringify({operationId:input.operationId,total}));
      db.db.exec('COMMIT');return {added:0,total,...(json?{json}:{})};
    }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
}
export type FullTextWriteInput={kind:'full_text';databasePath:string;entryId:string;expected:Record<string,unknown>;html:string;canonicalUrl:string;operationId?:string};
export function writeFullTextBatch(input:FullTextWriteInput){
  const db=new RivuDatabase(input.databasePath,undefined,true);
  try{
    db.db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    try{
      const entry=assertEntrySourceUnchanged(db,input.entryId,input.expected);
      db.setFullContent(input.entryId,input.html,input.canonicalUrl,true);
      applyEnabledRules(db,String(entry.feed_id),true);
      const result={added:0,total:1};
      if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`full-text-write:${input.entryId}`,JSON.stringify({operationId:input.operationId,result}));
      db.db.exec('COMMIT');return result;
    }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
}

const snapshotFields=['id','url','type','allow_private','json_mapping','folder_authorized','enabled'] as const;
export type FeedWriteSnapshot=Record<typeof snapshotFields[number],unknown>;
export type FeedWriteInput={databasePath:string;expected:FeedWriteSnapshot;items:EntryInput[];operationId?:string;newsletter?:NewsletterScan};
export function feedWriteSnapshot(feed:Record<string,unknown>):FeedWriteSnapshot{
  return Object.fromEntries(snapshotFields.map(field=>[field,feed[field]??null])) as FeedWriteSnapshot;
}
export function writeFeedBatch(input:FeedWriteInput){
  const db=new RivuDatabase(input.databasePath,undefined,true);
  try{
    db.db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
    try{
      const feed=db.feed(String(input.expected.id));
      if(!feed)throw Object.assign(Error('订阅已删除，本批次未写入'),{statusCode:404});
      const current=feedWriteSnapshot(feed);
      if(snapshotFields.some(field=>current[field]!==input.expected[field]))throw Object.assign(Error('来源或授权已变化，请重新刷新'),{statusCode:409});
      if(!['rss','rsshub','custom_json','newsletter'].includes(String(current.type))||(current.type==='newsletter'&&!input.newsletter)||(current.type!=='newsletter'&&input.newsletter))throw Object.assign(Error('此来源不支持后台批次写入'),{statusCode:400});
      if(input.newsletter){const directory=resolve(fileURLToPath(String(current.url)));if(realpathSync(directory)!==directory)throw Object.assign(Error('Newsletter 文件夹路径已变更，请重新选择文件夹'),{statusCode:409});}
      const entries=input.items.map(item=>({...item,hash:createHash('sha256').update(item.guid||item.url||`${item.title}\n${item.content||item.description||''}`).digest('hex')}));
      const added=db.addEntries(String(current.id),entries,true);
      if(input.newsletter)commitNewsletterScan(db,String(current.id),input.newsletter);
      applyEnabledRules(db,String(current.id),true);
      db.markFetch(String(current.id));
      if(input.newsletter){const failed=(db.db.prepare('SELECT count(*) count FROM newsletter_files WHERE feed_id=? AND failed=1').get(String(current.id)) as {count:number}).count;if(failed)db.db.prepare('UPDATE feeds SET last_error=? WHERE id=?').run(`${failed} 个 .eml 文件无法导入，请检查大小或格式`,String(current.id));}
      if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`feed-write:${current.id}`,JSON.stringify({operationId:input.operationId,result:{added,total:entries.length}}));
      db.db.exec('COMMIT');
      return {added,total:entries.length};
    }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
}
