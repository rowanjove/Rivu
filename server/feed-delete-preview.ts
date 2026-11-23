import type {DatabaseSync} from 'node:sqlite';

const invalid=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
export function selectedFeedIds(input:unknown){
 const ids=(input as {ids?:unknown}|undefined)?.ids;
 if(!Array.isArray(ids)||ids.length<1||ids.length>2000||ids.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))||new Set(ids).size!==ids.length)throw invalid('请选择 1–2000 个不重复的订阅');
 return ids as string[];
}
export function ensureSelectedFeeds(connection:DatabaseSync,ids:string[]){
 const rows=connection.prepare(`SELECT id FROM feeds WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
 if(rows.length!==ids.length)throw invalid('所选订阅已变化，请刷新后重试',409);
}
export function feedDeletionCounts(connection:DatabaseSync,ids:string[]){
 const marks=ids.map(()=>'?').join(',');
 const entriesToDelete=(connection.prepare(`SELECT count(*) count FROM entries WHERE feed_id IN (${marks})`).get(...ids) as {count:number}).count;
 const archivesPreserved=(connection.prepare(`SELECT count(*) count FROM permanent_archives WHERE feed_id IN (${marks})`).get(...ids) as {count:number}).count;
 return {entriesToDelete,archivesPreserved};
}
export function queryBulkFeedDeletionPreview(connection:DatabaseSync,input:unknown){
 const ids=selectedFeedIds(input);ensureSelectedFeeds(connection,ids);
 const marks=ids.map(()=>'?').join(',');
 // Schema41 maintains exact raw article totals, independently of read/filter
 // visibility. Destructive commits still re-count the primary entries table.
 const entriesToDelete=(connection.prepare(`SELECT coalesce(sum(entry_count),0) count FROM rivu_source_entry_counts WHERE feed_id IN (${marks})`).get(...ids) as {count:number}).count;
 const archivesPreserved=(connection.prepare(`SELECT count(*) count FROM permanent_archives WHERE feed_id IN (${marks})`).get(...ids) as {count:number}).count;
 return {feedsToDelete:ids.length,entriesToDelete,archivesPreserved};
}

export function queryFeedDeletionPreview(connection:DatabaseSync,id:string){
 const feed=connection.prepare('SELECT title FROM feeds WHERE id=?').get(id) as {title:string}|undefined;
 if(!feed)throw Object.assign(Error('订阅不存在'),{statusCode:404});
 const entries=(connection.prepare('SELECT entry_count FROM rivu_source_entry_counts WHERE feed_id=?').get(id) as {entry_count:number}|undefined)?.entry_count??0;
 const archives=(connection.prepare('SELECT count(*) count FROM permanent_archives WHERE feed_id=?').get(id) as {count:number}).count;
 return {feedId:id,title:String(feed.title),entriesToDelete:entries,archivesPreserved:archives};
}
