import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase,SCHEMA_VERSION,validateFetchInterval} from './database';

export const feedMetadataReceiptKey='feed-metadata-write';
export type FeedPatch=Parameters<RivuDatabase['updateFeed']>[1];
export type FeedMetadataWriteInput={databasePath:string;id:string;operationId?:string}&(
 {kind:'feed_patch';patch:FeedPatch}|{kind:'category_delete'}
);
export type FeedMetadataWriteResult={added:0;total:0|1;json?:ArrayBuffer};
export type FeedMetadataReceiptInput={kind:'feed_metadata_receipt';databasePath:string;id:string;targetKind:FeedMetadataWriteInput['kind'];expectedOperationId:string;operationId?:string};
export type FeedMetadataReceiptResult=FeedMetadataWriteResult&{found:boolean};

export function validateFeedPatch(input:unknown):FeedPatch{
 if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(Error('订阅修改无效'),{statusCode:400});
 const patch=input as Record<string,unknown>;
 if(patch.allowPrivate!==undefined&&typeof patch.allowPrivate!=='boolean')throw Object.assign(Error('本地网络授权无效'),{statusCode:400});
 if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw Object.assign(Error('订阅状态无效'),{statusCode:400});
 validateFetchInterval(patch.fetchInterval as number|undefined);
 return Object.fromEntries(['title','categoryId','enabled','fetchInterval','allowPrivate'].filter(key=>patch[key]!==undefined).map(key=>[key,patch[key]])) as FeedPatch;
}
export function validFeedMetadataWriteResult(value:unknown,kind:FeedMetadataWriteInput['kind']):value is FeedMetadataWriteResult{
 const result=value as FeedMetadataWriteResult|undefined;
 return !!result&&result.added===0&&(kind==='feed_patch'?result.total===1&&result.json instanceof ArrayBuffer:(result.total===0||result.total===1)&&result.json===undefined);
}
export function validFeedMetadataReceiptResult(value:unknown,kind:FeedMetadataWriteInput['kind']):value is FeedMetadataReceiptResult{
 const result=value as FeedMetadataReceiptResult|undefined;
 return !!result&&(result.found===false?result.added===0&&result.total===0&&result.json===undefined:result.found===true&&validFeedMetadataWriteResult(result,kind));
}
export function writeFeedMetadata(input:FeedMetadataWriteInput):FeedMetadataWriteResult{
 const patch=input.kind==='feed_patch'?validateFeedPatch(input.patch):undefined,db=new RivuDatabase(input.databasePath,undefined,true);
 try{
  db.db.exec('PRAGMA busy_timeout=10000;BEGIN IMMEDIATE');
  try{
   let total:0|1,response:string|undefined;
   if(input.kind==='feed_patch'){
    const feed=db.updateFeed(input.id,patch!);
    if(!feed)throw Object.assign(Error('订阅不存在'),{statusCode:404});
    total=1;response=JSON.stringify(feed);
   }else{
    // Preserve deleteCategory's UPDATE-before-DELETE behavior inside the receipt transaction.
    db.db.prepare('UPDATE feeds SET category_id=NULL WHERE category_id=?').run(input.id);
    total=Number(db.db.prepare('DELETE FROM categories WHERE id=?').run(input.id).changes) as 0|1;
   }
   const result:FeedMetadataWriteResult={added:0,total,...(response===undefined?{}:{json:new TextEncoder().encode(response).buffer})};
   if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(feedMetadataReceiptKey,JSON.stringify({operationId:input.operationId,kind:input.kind,id:input.id,result:{added:0,total},response}));
   db.db.exec('COMMIT');return result;
  }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
 }finally{db.close();}
}
export function readFeedMetadataReceipt(input:FeedMetadataReceiptInput):FeedMetadataReceiptResult{
 const missing:FeedMetadataReceiptResult={added:0,total:0,found:false},db=new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
 try{
  db.exec('PRAGMA query_only=ON;BEGIN');
  if(db.prepare('PRAGMA user_version').get()?.user_version!==SCHEMA_VERSION)return missing;
  const row=db.prepare('SELECT value FROM app_meta WHERE key=? AND length(CAST(value AS BLOB))<=33554432').get(feedMetadataReceiptKey) as {value:string}|undefined;
  if(!row)return missing;
  const receipt=JSON.parse(row.value);
  if(!input.expectedOperationId||receipt.operationId!==input.expectedOperationId||receipt.kind!==input.targetKind||receipt.id!==input.id||receipt.result?.added!==0)return missing;
  if(input.targetKind==='feed_patch'){
   if(receipt.result.total!==1||typeof receipt.response!=='string')return missing;
   const feed=JSON.parse(receipt.response);if(!feed||typeof feed!=='object'||Array.isArray(feed)||feed.id!==input.id)return missing;
   return {added:0,total:1,json:new TextEncoder().encode(receipt.response).buffer,found:true};
  }
  return receipt.result.total===0||receipt.result.total===1?{added:0,total:receipt.result.total,found:true}:missing;
 }finally{try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}
}
