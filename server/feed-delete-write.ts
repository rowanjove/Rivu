import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase,SCHEMA_VERSION} from './database';
import {changeFeeds,validateFeedDeleteChange,type FeedDeleteChange} from './feed-bulk';

export const feedDeleteReceiptKey='feed-delete-write';
export type FeedDeleteWriteInput={kind:'feed_delete';databasePath:string;change:FeedDeleteChange;operationId?:string};
export type FeedDeleteWriteResult={added:0;total:number};
export type FeedDeleteReceiptInput={kind:'feed_delete_receipt';databasePath:string;change:FeedDeleteChange;expectedOperationId:string;operationId?:string};
export type FeedDeleteReceiptResult=FeedDeleteWriteResult&{found:boolean};
const fingerprint=(change:FeedDeleteChange)=>createHash('sha256').update(JSON.stringify(change)).digest('hex');
export function validFeedDeleteWriteResult(value:unknown,expected:number):value is FeedDeleteWriteResult{
 const result=value as FeedDeleteWriteResult|undefined;
 return !!result&&result.added===0&&Number.isInteger(result.total)&&result.total>=1&&result.total<=2000&&result.total===expected;
}
export function validFeedDeleteReceiptResult(value:unknown,expected:number):value is FeedDeleteReceiptResult{
 const result=value as FeedDeleteReceiptResult|undefined;
 return !!result&&(result.found===false?result.added===0&&result.total===0:result.found===true&&validFeedDeleteWriteResult(result,expected));
}
export function writeFeedDelete(input:FeedDeleteWriteInput):FeedDeleteWriteResult{
 const change=validateFeedDeleteChange(input.change),db=new RivuDatabase(input.databasePath,undefined,true);
 try{
  db.db.exec('PRAGMA busy_timeout=10000;BEGIN IMMEDIATE');
  try{
   const changed=changeFeeds(db,change,true),result:FeedDeleteWriteResult={added:0,total:changed.changed};
   // A fixed-size receipt contains no source titles, URLs or article content.
   if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(feedDeleteReceiptKey,JSON.stringify({operationId:input.operationId,fingerprint:fingerprint(change),result}));
   db.db.exec('COMMIT');return result;
  }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
 }finally{db.close();}
}
export function readFeedDeleteReceipt(input:FeedDeleteReceiptInput):FeedDeleteReceiptResult{
 const change=validateFeedDeleteChange(input.change),missing:FeedDeleteReceiptResult={added:0,total:0,found:false},db=new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
 try{
  db.exec('PRAGMA query_only=ON;BEGIN');
  if(db.prepare('PRAGMA user_version').get()?.user_version!==SCHEMA_VERSION)return missing;
  const row=db.prepare('SELECT value FROM app_meta WHERE key=? AND length(CAST(value AS BLOB))<=4096').get(feedDeleteReceiptKey) as {value:string}|undefined;
  if(!row)return missing;
  const receipt=JSON.parse(row.value);
  if(!input.expectedOperationId||receipt.operationId!==input.expectedOperationId||receipt.fingerprint!==fingerprint(change)||!validFeedDeleteWriteResult(receipt.result,change.ids.length))return missing;
  return {added:0,total:receipt.result.total,found:true};
 }finally{try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}
}
