import { isRecoveredFeed, RivuDatabase } from './database';
import {selectedFeedIds as selectedIds,ensureSelectedFeeds,feedDeletionCounts,queryBulkFeedDeletionPreview} from './feed-delete-preview';

const invalid=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
type Selection={ids:string[]};
export type FeedCategoryChange=Selection&{action:'category';categoryId:string|null};
export type FeedDeleteChange=Selection&{action:'delete';expected:{entriesToDelete:number;archivesPreserved:number}};
type Change=Selection&({action:'category';categoryId:string|null}|{action:'interval';fetchInterval:number}|{action:'pause';enabled:boolean}|{action:'delete';expected:{entriesToDelete:number;archivesPreserved:number}});

const ensureFeeds=(db:RivuDatabase,ids:string[])=>ensureSelectedFeeds(db.db,ids);
const deletionCounts=(db:RivuDatabase,ids:string[])=>feedDeletionCounts(db.db,ids);
export function previewBulkFeedDelete(db:RivuDatabase,input:unknown){
  return queryBulkFeedDeletionPreview(db.db,input);
}
export function validateFeedCategoryChange(input:unknown):FeedCategoryChange{
  const ids=selectedIds(input),change=input as FeedCategoryChange;
  if(change.action!=='category')throw invalid('批量操作无效');
  if(!(change.categoryId===null||typeof change.categoryId==='string'&&/^[0-9a-f-]{36}$/i.test(change.categoryId)))throw invalid('分类无效');
  return {ids:[...ids],action:'category',categoryId:change.categoryId};
}
export function validateFeedDeleteChange(input:unknown):FeedDeleteChange{
  const ids=selectedIds(input),change=input as FeedDeleteChange;
  if(change.action!=='delete')throw invalid('批量操作无效');
  if(!change.expected||!Number.isSafeInteger(change.expected.entriesToDelete)||!Number.isSafeInteger(change.expected.archivesPreserved))throw invalid('删除确认已失效，请重新预览');
  return {ids:[...ids],action:'delete',expected:{entriesToDelete:change.expected.entriesToDelete,archivesPreserved:change.expected.archivesPreserved}};
}
export function changeFeeds(db:RivuDatabase,input:unknown,insideTransaction=false){
  const ids=selectedIds(input),change=input as Change;
  const marks=ids.map(()=>'?').join(',');
  if(!['category','interval','pause','delete'].includes(change.action))throw invalid('批量操作无效');
  if(change.action==='category'&&!(change.categoryId===null||typeof change.categoryId==='string'&&/^[0-9a-f-]{36}$/i.test(change.categoryId)))throw invalid('分类无效');
  if(change.action==='interval'&&(!Number.isInteger(change.fetchInterval)||![0,15,30,60,180,360,720].includes(change.fetchInterval)))throw invalid('刷新频率无效');
  if(change.action==='pause'&&typeof change.enabled!=='boolean')throw invalid('订阅状态无效');
  if(change.action==='delete'&&(!change.expected||!Number.isSafeInteger(change.expected.entriesToDelete)||!Number.isSafeInteger(change.expected.archivesPreserved)))throw invalid('删除确认已失效，请重新预览');
  if(insideTransaction){if(!db.db.isTransaction)throw Error('批量订阅写入需要事务');}
  else db.db.exec('BEGIN IMMEDIATE');
  try{
    ensureFeeds(db,ids);
    if(change.action==='category'){
      if(change.categoryId&&!db.db.prepare('SELECT 1 FROM categories WHERE id=?').get(change.categoryId))throw invalid('分类不存在',404);
      db.db.prepare(`UPDATE feeds SET category_id=? WHERE id IN (${marks})`).run(change.categoryId,...ids);
    }else if(change.action==='interval')db.db.prepare(`UPDATE feeds SET fetch_interval=?,next_fetch_at=? WHERE id IN (${marks})`).run(change.fetchInterval,change.fetchInterval===0?null:new Date(Date.now()+change.fetchInterval*60_000).toISOString(),...ids);
    else if(change.action==='pause'){
      if(change.enabled&&ids.some(id=>isRecoveredFeed(db.feed(id)!)))throw invalid('所选订阅中有来源地址缺失的恢复项，无法启用');
      db.db.prepare(`UPDATE feeds SET enabled=? WHERE id IN (${marks})`).run(Number(change.enabled),...ids);
    }
    else {
      const current=deletionCounts(db,ids);
      if(current.entriesToDelete!==change.expected.entriesToDelete||current.archivesPreserved!==change.expected.archivesPreserved)throw invalid('删除影响范围已变化，请重新预览',409);
      const entryIds=`SELECT id FROM entries WHERE feed_id IN (${marks})`;
      db.db.prepare(`DELETE FROM ai_results WHERE entry_id IN (${entryIds})`).run(...ids);
      db.db.prepare(`DELETE FROM entry_tags WHERE entry_id IN (${entryIds})`).run(...ids);
      db.db.prepare(`DELETE FROM entries WHERE feed_id IN (${marks})`).run(...ids);
      db.db.prepare(`DELETE FROM feeds WHERE id IN (${marks})`).run(...ids);
      db.db.prepare(`DELETE FROM app_meta WHERE key IN (${marks})`).run(...ids.map(id=>`newsletter_audit:${id}`));
      db.db.prepare('DELETE FROM app_meta WHERE key=?').run('feed-metadata-write');
    }
    if(!insideTransaction)db.db.exec('COMMIT');
    return {changed:ids.length,action:change.action};
  }catch(error){if(!insideTransaction)db.db.exec('ROLLBACK');throw error;}
}
