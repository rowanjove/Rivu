import {RivuDatabase} from './database';
import {changeFeeds,validateFeedCategoryChange,type FeedCategoryChange} from './feed-bulk';

export const feedCategoryReceiptKey='feed-category-write';
export type FeedCategoryWriteInput={kind:'feed_category';databasePath:string;change:FeedCategoryChange;operationId?:string};
export type FeedCategoryWriteResult={added:0;total:number};
export function validFeedCategoryWriteResult(value:unknown,expected:number):value is FeedCategoryWriteResult{
 const result=value as FeedCategoryWriteResult|undefined;
 return !!result&&result.added===0&&Number.isInteger(result.total)&&result.total>=1&&result.total<=2000&&result.total===expected;
}
export function writeFeedCategory(input:FeedCategoryWriteInput):FeedCategoryWriteResult{
 const change=validateFeedCategoryChange(input.change),db=new RivuDatabase(input.databasePath,undefined,true);
 try{
  db.db.exec('PRAGMA busy_timeout=10000;BEGIN IMMEDIATE');
  try{
   const changed=changeFeeds(db,change,true),result:FeedCategoryWriteResult={added:0,total:changed.changed};
   if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(feedCategoryReceiptKey,JSON.stringify({operationId:input.operationId,result}));
   db.db.exec('COMMIT');return result;
  }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
 }finally{db.close();}
}
