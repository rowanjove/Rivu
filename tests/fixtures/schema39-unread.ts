import type {DatabaseSync} from 'node:sqlite';

// All entry points are SQL triggers: a batch, its visibility effects and its
// counters therefore commit or roll back together on every application writer.
const blocked=(entry:string)=>`CASE WHEN (
 EXISTS(SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=${entry}.id AND r.enabled=1 AND r.action_type='block')
 OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=${entry}.id AND a.decision='block')
) THEN 1 ELSE 0 END`;
const visible=(entry:string)=>`CASE WHEN ${entry}.read=0 AND NOT (
 EXISTS(SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=${entry}.id AND r.enabled=1 AND r.action_type IN ('block','mute'))
 OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=${entry}.id AND a.decision IN ('block','mute'))
) THEN 1 ELSE 0 END`;
const reconcile=(ids:string)=>`UPDATE rivu_entry_visibility SET (feed_id,visible,sort_time,blocked,sort_bucket)=(
 SELECT e.feed_id,${visible('e')},COALESCE(e.published_at,e.fetched_at),${blocked('e')},substr(COALESCE(e.published_at,e.fetched_at),1,10) FROM entries e INDEXED BY entries_list_metadata WHERE e.id=rivu_entry_visibility.entry_id
) WHERE entry_id IN (${ids}) AND EXISTS(SELECT 1 FROM entries e WHERE e.id=rivu_entry_visibility.entry_id);`;
const affectedRule=(id:string)=>`SELECT entry_id FROM rule_matches WHERE rule_id=${id}`;
const feedCounter=(id:string)=>`INSERT INTO rivu_feed_unread_counts(feed_id,unread_count)
 SELECT ${id},count(*) FROM rivu_entry_visibility WHERE feed_id=${id} AND visible=1
 ON CONFLICT(feed_id) DO UPDATE SET unread_count=excluded.unread_count;`;

export const unreadCountTriggerNames=[
 'rivu_unread_state_insert','rivu_unread_state_update','rivu_unread_state_delete',
 'rivu_unread_entry_insert','rivu_unread_entry_update','rivu_unread_entry_delete',
 'rivu_unread_feed_insert','rivu_unread_feed_update','rivu_unread_feed_delete',
 'rivu_unread_match_insert','rivu_unread_match_delete','rivu_unread_match_update',
 'rivu_unread_rule_insert','rivu_unread_rule_update','rivu_unread_rule_delete',
 'rivu_unread_ai_insert','rivu_unread_ai_delete','rivu_unread_ai_update'
] as const;

// The caller owns the schema migration transaction and must retain its existing
// pre-migration backup policy. This function never changes user_version itself.
export function installUnreadCounts(db:DatabaseSync){
 if(!db.isTransaction)throw Error('未读统计迁移必须在事务内执行');
 for(const name of unreadCountTriggerNames)db.exec(`DROP TRIGGER IF EXISTS ${name}`);
 db.exec('DROP INDEX IF EXISTS rivu_visibility_timeline; DROP INDEX IF EXISTS rivu_visibility_unread');
 db.exec(`CREATE TABLE IF NOT EXISTS rivu_entry_visibility (
   entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
   feed_id TEXT NOT NULL,visible INTEGER NOT NULL CHECK(visible IN (0,1)),
   sort_time TEXT NOT NULL DEFAULT '',blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),sort_bucket TEXT NOT NULL DEFAULT ''
 );
 `);
 const columns=new Set(db.prepare('PRAGMA table_info(rivu_entry_visibility)').all().map(row=>String(row.name)));
 if(!columns.has('sort_time'))db.exec("ALTER TABLE rivu_entry_visibility ADD COLUMN sort_time TEXT NOT NULL DEFAULT ''");
 if(!columns.has('sort_bucket'))db.exec("ALTER TABLE rivu_entry_visibility ADD COLUMN sort_bucket TEXT NOT NULL DEFAULT ''");
 if(!columns.has('blocked'))db.exec('ALTER TABLE rivu_entry_visibility ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))');
 db.exec(`
 CREATE INDEX IF NOT EXISTS rivu_visibility_feed ON rivu_entry_visibility(feed_id,visible);
 CREATE TABLE IF NOT EXISTS rivu_feed_unread_counts (
   feed_id TEXT PRIMARY KEY NOT NULL REFERENCES feeds(id) ON DELETE CASCADE ON UPDATE CASCADE,
   unread_count INTEGER NOT NULL CHECK(unread_count>=0)
 );
 CREATE TABLE IF NOT EXISTS rivu_source_entry_counts (
   feed_id TEXT PRIMARY KEY NOT NULL,entry_count INTEGER NOT NULL CHECK(entry_count>=0)
 );
 CREATE TABLE IF NOT EXISTS rivu_timeline_bucket_counts (
   sort_bucket TEXT PRIMARY KEY NOT NULL,
   entry_count INTEGER NOT NULL CHECK(entry_count>=0),
   visible_count INTEGER NOT NULL CHECK(visible_count>=0),
   blocked_count INTEGER NOT NULL CHECK(blocked_count>=0),
   CHECK(visible_count+blocked_count<=entry_count)
 );
 DELETE FROM rivu_entry_visibility; DELETE FROM rivu_feed_unread_counts; DELETE FROM rivu_source_entry_counts; DELETE FROM rivu_timeline_bucket_counts;
 INSERT INTO rivu_entry_visibility(entry_id,feed_id,visible,sort_time,blocked,sort_bucket)
 SELECT e.id,e.feed_id,${visible('e')},COALESCE(e.published_at,e.fetched_at),${blocked('e')},substr(COALESCE(e.published_at,e.fetched_at),1,10) FROM entries e INDEXED BY entries_list_metadata;
 INSERT INTO rivu_feed_unread_counts(feed_id,unread_count)
 SELECT f.id,(SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=f.id AND v.visible=1) FROM feeds f;
 INSERT INTO rivu_source_entry_counts(feed_id,entry_count)
 SELECT feed_id,count(*) FROM rivu_entry_visibility GROUP BY feed_id;
 INSERT INTO rivu_timeline_bucket_counts(sort_bucket,entry_count,visible_count,blocked_count)
 SELECT sort_bucket,count(*),sum(visible),sum(blocked) FROM rivu_entry_visibility GROUP BY sort_bucket;
 CREATE INDEX rivu_visibility_timeline ON rivu_entry_visibility(blocked,sort_bucket DESC,sort_time DESC,entry_id DESC);
 CREATE INDEX rivu_visibility_unread ON rivu_entry_visibility(sort_bucket DESC,sort_time DESC,entry_id DESC) WHERE visible=1;

 CREATE TRIGGER rivu_unread_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count+NEW.visible WHERE feed_id=NEW.feed_id;
   INSERT INTO rivu_source_entry_counts(feed_id,entry_count) VALUES(NEW.feed_id,1)
   ON CONFLICT(feed_id) DO UPDATE SET entry_count=entry_count+1;
   INSERT INTO rivu_timeline_bucket_counts(sort_bucket,entry_count,visible_count,blocked_count) VALUES(NEW.sort_bucket,1,NEW.visible,NEW.blocked)
   ON CONFLICT(sort_bucket) DO UPDATE SET entry_count=entry_count+1,visible_count=visible_count+excluded.visible_count,blocked_count=blocked_count+excluded.blocked_count;
 END;
 CREATE TRIGGER rivu_unread_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count-OLD.visible WHERE feed_id=OLD.feed_id;
   UPDATE rivu_source_entry_counts SET entry_count=entry_count-1 WHERE feed_id=OLD.feed_id;
   DELETE FROM rivu_source_entry_counts WHERE feed_id=OLD.feed_id AND entry_count=0;
   UPDATE rivu_timeline_bucket_counts SET entry_count=entry_count-1,visible_count=visible_count-OLD.visible,blocked_count=blocked_count-OLD.blocked WHERE sort_bucket=OLD.sort_bucket;
   DELETE FROM rivu_timeline_bucket_counts WHERE sort_bucket=OLD.sort_bucket AND entry_count=0;
 END;
 CREATE TRIGGER rivu_unread_state_update AFTER UPDATE OF feed_id,visible,blocked,sort_bucket ON rivu_entry_visibility
 WHEN OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible OR OLD.blocked IS NOT NEW.blocked OR OLD.sort_bucket IS NOT NEW.sort_bucket BEGIN
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count-OLD.visible WHERE feed_id=OLD.feed_id AND (OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible);
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count+NEW.visible WHERE feed_id=NEW.feed_id AND (OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible);
   UPDATE rivu_source_entry_counts SET entry_count=entry_count-1 WHERE feed_id=OLD.feed_id AND OLD.feed_id IS NOT NEW.feed_id;
   DELETE FROM rivu_source_entry_counts WHERE feed_id=OLD.feed_id AND entry_count=0 AND OLD.feed_id IS NOT NEW.feed_id;
   INSERT INTO rivu_source_entry_counts(feed_id,entry_count) SELECT NEW.feed_id,1 WHERE OLD.feed_id IS NOT NEW.feed_id
   ON CONFLICT(feed_id) DO UPDATE SET entry_count=entry_count+1;
   UPDATE rivu_timeline_bucket_counts SET entry_count=entry_count-1,visible_count=visible_count-OLD.visible,blocked_count=blocked_count-OLD.blocked WHERE sort_bucket=OLD.sort_bucket AND OLD.sort_bucket IS NOT NEW.sort_bucket;
   DELETE FROM rivu_timeline_bucket_counts WHERE sort_bucket=OLD.sort_bucket AND entry_count=0 AND OLD.sort_bucket IS NOT NEW.sort_bucket;
   INSERT INTO rivu_timeline_bucket_counts(sort_bucket,entry_count,visible_count,blocked_count) SELECT NEW.sort_bucket,1,NEW.visible,NEW.blocked WHERE OLD.sort_bucket IS NOT NEW.sort_bucket
   ON CONFLICT(sort_bucket) DO UPDATE SET entry_count=entry_count+1,visible_count=visible_count+excluded.visible_count,blocked_count=blocked_count+excluded.blocked_count;
   UPDATE rivu_timeline_bucket_counts SET visible_count=visible_count+NEW.visible-OLD.visible,blocked_count=blocked_count+NEW.blocked-OLD.blocked WHERE sort_bucket=NEW.sort_bucket AND OLD.sort_bucket IS NEW.sort_bucket AND (OLD.visible IS NOT NEW.visible OR OLD.blocked IS NOT NEW.blocked);
 END;
 CREATE TRIGGER rivu_unread_entry_insert AFTER INSERT ON entries BEGIN
   INSERT INTO rivu_entry_visibility(entry_id,feed_id,visible,sort_time,blocked,sort_bucket) SELECT e.id,e.feed_id,${visible('e')},COALESCE(e.published_at,e.fetched_at),${blocked('e')},substr(COALESCE(e.published_at,e.fetched_at),1,10) FROM entries e WHERE e.id=NEW.id
   ON CONFLICT(entry_id) DO UPDATE SET feed_id=excluded.feed_id,visible=excluded.visible,sort_time=excluded.sort_time,blocked=excluded.blocked,sort_bucket=excluded.sort_bucket;
 END;
 CREATE TRIGGER rivu_unread_entry_update AFTER UPDATE OF read,feed_id,id,published_at,fetched_at ON entries BEGIN
   UPDATE rivu_entry_visibility SET entry_id=NEW.id WHERE entry_id=OLD.id AND OLD.id IS NOT NEW.id;
   ${reconcile('SELECT NEW.id')}
 END;
 CREATE TRIGGER rivu_unread_entry_delete AFTER DELETE ON entries BEGIN DELETE FROM rivu_entry_visibility WHERE entry_id=OLD.id; END;
 CREATE TRIGGER rivu_unread_feed_insert AFTER INSERT ON feeds BEGIN ${feedCounter('NEW.id')} END;
 CREATE TRIGGER rivu_unread_feed_update AFTER UPDATE OF id ON feeds WHEN OLD.id IS NOT NEW.id BEGIN
   DELETE FROM rivu_feed_unread_counts WHERE feed_id=OLD.id; ${feedCounter('NEW.id')}
 END;
 CREATE TRIGGER rivu_unread_feed_delete AFTER DELETE ON feeds BEGIN DELETE FROM rivu_feed_unread_counts WHERE feed_id=OLD.id; END;
 CREATE TRIGGER rivu_unread_match_insert AFTER INSERT ON rule_matches BEGIN ${reconcile('SELECT NEW.entry_id')} END;
 CREATE TRIGGER rivu_unread_match_delete AFTER DELETE ON rule_matches BEGIN ${reconcile('SELECT OLD.entry_id')} END;
 CREATE TRIGGER rivu_unread_match_update AFTER UPDATE OF entry_id,rule_id ON rule_matches BEGIN
   ${reconcile('SELECT OLD.entry_id UNION SELECT NEW.entry_id')}
 END;
 CREATE TRIGGER rivu_unread_rule_insert AFTER INSERT ON rules BEGIN ${reconcile(affectedRule('NEW.id'))} END;
 CREATE TRIGGER rivu_unread_rule_delete AFTER DELETE ON rules BEGIN ${reconcile(affectedRule('OLD.id'))} END;
 CREATE TRIGGER rivu_unread_rule_update AFTER UPDATE OF id,enabled,action_type ON rules BEGIN
   ${reconcile(`${affectedRule('OLD.id')} UNION ${affectedRule('NEW.id')}`)}
 END;
 CREATE TRIGGER rivu_unread_ai_insert AFTER INSERT ON ai_filter_decisions BEGIN ${reconcile('SELECT NEW.entry_id')} END;
 CREATE TRIGGER rivu_unread_ai_delete AFTER DELETE ON ai_filter_decisions BEGIN ${reconcile('SELECT OLD.entry_id')} END;
 CREATE TRIGGER rivu_unread_ai_update AFTER UPDATE OF entry_id,decision ON ai_filter_decisions BEGIN
   ${reconcile('SELECT OLD.entry_id UNION SELECT NEW.entry_id')}
 END;`);
}

export function validateVisibilityIndexes(db:DatabaseSync){
 // The offset shortcut requires exactly one BINARY key per bucket, including
 // after restoring a database whose column names alone appear valid.
 const columns=db.prepare('PRAGMA table_info(rivu_timeline_bucket_counts)').all();
 const keys=columns.filter(row=>Number(row.pk)>0);
 const primary=db.prepare('PRAGMA index_list(rivu_timeline_bucket_counts)').all().find(row=>row.origin==='pk');
 const keyDetail=primary?db.prepare('SELECT * FROM pragma_index_xinfo(?)').all(primary.name).filter(row=>row.key===1):[];
 if(keys.length!==1||keys[0].name!=='sort_bucket'||keys[0].type!=='TEXT'||keys[0].notnull!==1||primary?.unique!==1||primary?.partial!==0||keyDetail.length!==1||keyDetail[0].name!=='sort_bucket'||keyDetail[0].coll!=='BINARY'||keyDetail[0].desc!==0)throw Error('数据库时间分桶主键无效');
 for(const [name,expected,partial] of [
  ['rivu_visibility_timeline','blocked:0,sort_bucket:1,sort_time:1,entry_id:1',0],
  ['rivu_visibility_unread','sort_bucket:1,sort_time:1,entry_id:1',1]
 ] as const){
  const index=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='rivu_entry_visibility'").get(name);
  const detail=db.prepare(`PRAGMA index_xinfo(${name})`).all().filter(row=>row.key===1);
  const definition=detail.map(row=>`${row.name}:${row.desc}`).join(',');
  const flags=db.prepare('PRAGMA index_list(rivu_entry_visibility)').all().find(row=>row.name===name);
  if(!index||definition!==expected||detail.some(row=>row.coll!=='BINARY')||flags?.partial!==partial||(partial&&!/\bWHERE\s+visible\s*=\s*1\s*$/i.test(String(index.sql))))throw Error(`数据库排序索引无效：${name}`);
 }
}

export function validateUnreadCounts(db:DatabaseSync){
 validateVisibilityIndexes(db);
 for(const name of unreadCountTriggerNames)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error(`未读统计触发器缺失：${name}`);
 const mismatch=db.prepare(`SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_entry_visibility v ON v.entry_id=e.id
 WHERE v.entry_id IS NULL OR v.feed_id IS NOT e.feed_id OR v.visible IS NOT (${visible('e')})
 OR v.sort_bucket IS NOT substr(COALESCE(e.published_at,e.fetched_at),1,10) OR v.sort_time IS NOT COALESCE(e.published_at,e.fetched_at) OR v.blocked IS NOT (${blocked('e')}) LIMIT 1`).get();
 if(mismatch||db.prepare('SELECT 1 FROM rivu_entry_visibility v LEFT JOIN entries e ON e.id=v.entry_id WHERE e.id IS NULL LIMIT 1').get())throw Error('文章可见状态与原数据不一致');
 // Aggregate once: checking every bucket with a separate full scan would be O(B*N).
 if(db.prepare(`WITH expected AS MATERIALIZED (
 SELECT sort_bucket,count(*) entry_count,sum(visible) visible_count,sum(blocked) blocked_count FROM rivu_entry_visibility GROUP BY sort_bucket
 ) SELECT e.sort_bucket FROM expected e LEFT JOIN rivu_timeline_bucket_counts c ON c.sort_bucket=e.sort_bucket
 WHERE c.sort_bucket IS NULL OR c.entry_count IS NOT e.entry_count OR c.visible_count IS NOT e.visible_count OR c.blocked_count IS NOT e.blocked_count
 UNION ALL SELECT c.sort_bucket FROM rivu_timeline_bucket_counts c LEFT JOIN expected e ON e.sort_bucket=c.sort_bucket WHERE e.sort_bucket IS NULL LIMIT 1`).get())throw Error('时间分桶计数与文章状态不一致');
 if(db.prepare(`SELECT c.feed_id FROM rivu_source_entry_counts c
 WHERE c.entry_count<=0 OR c.entry_count IS NOT (SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=c.feed_id)
 UNION ALL SELECT v.feed_id FROM rivu_entry_visibility v LEFT JOIN rivu_source_entry_counts c ON c.feed_id=v.feed_id WHERE c.feed_id IS NULL LIMIT 1`).get())throw Error('来源条目计数与文章状态不一致');
 if(db.prepare(`SELECT f.id FROM feeds f LEFT JOIN rivu_feed_unread_counts c ON c.feed_id=f.id WHERE c.feed_id IS NULL OR c.unread_count IS NOT
 (SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=f.id AND v.visible=1) LIMIT 1`).get()
 ||db.prepare('SELECT 1 FROM rivu_feed_unread_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL LIMIT 1').get())throw Error('订阅未读计数与文章状态不一致');
}
