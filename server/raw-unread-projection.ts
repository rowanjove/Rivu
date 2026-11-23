import type {DatabaseSync} from 'node:sqlite';

// Rebuilt within schema migrations and maintained by transactional SQL triggers.
// Raw unread deliberately retains muted entries; visible unread is a different set.
export const rawUnreadTriggerNames=['rivu_raw_unread_state_insert','rivu_raw_unread_state_update','rivu_raw_unread_state_delete'] as const;
const eligible=`e.read=0 AND NOT EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='block') AND NOT EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='block')`;
const reconcile=`DELETE FROM rivu_raw_unread_entries WHERE entry_id=NEW.entry_id AND (NEW.blocked<>0 OR NOT EXISTS(SELECT 1 FROM entries e INDEXED BY entries_list_metadata WHERE e.id=NEW.entry_id AND e.read=0));
 INSERT INTO rivu_raw_unread_entries(entry_id,feed_id,sort_time,sort_bucket)
 SELECT NEW.entry_id,NEW.feed_id,NEW.sort_time,NEW.sort_bucket FROM entries e INDEXED BY entries_list_metadata WHERE e.id=NEW.entry_id AND e.read=0 AND NEW.blocked=0
 ON CONFLICT(entry_id) DO UPDATE SET feed_id=excluded.feed_id,sort_time=excluded.sort_time,sort_bucket=excluded.sort_bucket;`;

export function installRawUnreadProjection(db:DatabaseSync){
 if(!db.isTransaction)throw Error('原始未读投影必须在迁移事务内安装');
 for(const name of rawUnreadTriggerNames)db.exec(`DROP TRIGGER IF EXISTS ${name}`);
 db.exec(`CREATE TABLE IF NOT EXISTS rivu_raw_unread_entries(
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
  feed_id TEXT NOT NULL,sort_time TEXT NOT NULL,sort_bucket TEXT NOT NULL
 );
 DELETE FROM rivu_raw_unread_entries;
 INSERT INTO rivu_raw_unread_entries(entry_id,feed_id,sort_time,sort_bucket)
 SELECT v.entry_id,v.feed_id,v.sort_time,v.sort_bucket FROM rivu_entry_visibility v CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=v.entry_id WHERE v.blocked=0 AND e.read=0;
 CREATE INDEX IF NOT EXISTS rivu_raw_unread_timeline ON rivu_raw_unread_entries(sort_bucket DESC,sort_time DESC,entry_id DESC,feed_id);
 CREATE INDEX IF NOT EXISTS rivu_raw_unread_feed ON rivu_raw_unread_entries(feed_id,sort_bucket DESC,sort_time DESC,entry_id DESC);
 CREATE TRIGGER rivu_raw_unread_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN ${reconcile} END;
 CREATE TRIGGER rivu_raw_unread_state_update AFTER UPDATE OF entry_id,feed_id,visible,blocked,sort_time,sort_bucket ON rivu_entry_visibility BEGIN
  DELETE FROM rivu_raw_unread_entries WHERE entry_id=OLD.entry_id AND OLD.entry_id IS NOT NEW.entry_id;
  ${reconcile}
 END;
 CREATE TRIGGER rivu_raw_unread_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN DELETE FROM rivu_raw_unread_entries WHERE entry_id=OLD.entry_id; END;`);
 validateRawUnreadStructure(db);
}

export function validateRawUnreadStructure(db:DatabaseSync){
 const columns=db.prepare('PRAGMA table_info(rivu_raw_unread_entries)').all();
 for(const name of ['entry_id','feed_id','sort_time','sort_bucket']){
  const column=columns.find(row=>row.name===name);
  if(!column||column.type!=='TEXT'||column.notnull!==1||column.pk!==(name==='entry_id'?1:0))throw Error('原始未读列约束无效：'+name);
 }
 const foreign=db.prepare('PRAGMA foreign_key_list(rivu_raw_unread_entries)').all();
 if(foreign.length!==1||foreign[0].table!=='entries'||foreign[0].from!=='entry_id'||foreign[0].to!=='id'||foreign[0].on_update!=='CASCADE'||foreign[0].on_delete!=='CASCADE')throw Error('原始未读身份外键无效');
 const indexes=db.prepare('PRAGMA index_list(rivu_raw_unread_entries)').all(),primary=indexes.find(row=>row.origin==='pk');
 if(!primary||primary.unique!==1||primary.partial!==0||indexes.some(row=>row.unique===1&&row.origin!=='pk'))throw Error('原始未读主键无效');
 const primaryKeys=db.prepare('SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(primary.name);
 if(primaryKeys.length!==1||primaryKeys[0].name!=='entry_id'||primaryKeys[0].coll!=='BINARY')throw Error('原始未读主键排序无效');
 for(const name of rawUnreadTriggerNames)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error('原始未读触发器缺失：'+name);
 for(const [name,expected]of [['rivu_raw_unread_timeline','sort_bucket:1,sort_time:1,entry_id:1,feed_id:0'],['rivu_raw_unread_feed','feed_id:0,sort_bucket:1,sort_time:1,entry_id:1']]){
  const index=indexes.find(row=>row.name===name);
  if(!index||index.unique!==0||index.partial!==0)throw Error('原始未读索引标志无效：'+name);
  const keys=db.prepare('SELECT name,desc,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(name);
  if(keys.map(row=>`${row.name}:${row.desc}`).join(',')!==expected||keys.some(row=>row.coll!=='BINARY'))throw Error('原始未读索引无效：'+name);
 }
}

export function validateRawUnreadProjection(db:DatabaseSync){
 validateRawUnreadStructure(db);
 if(db.prepare(`SELECT r.entry_id FROM rivu_raw_unread_entries r LEFT JOIN entries e INDEXED BY entries_list_metadata ON e.id=r.entry_id
  WHERE e.id IS NULL OR r.feed_id IS NOT e.feed_id OR r.sort_time IS NOT COALESCE(e.published_at,e.fetched_at) OR r.sort_bucket IS NOT substr(COALESCE(e.published_at,e.fetched_at),1,10) OR NOT (${eligible})
  UNION ALL SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_raw_unread_entries r ON r.entry_id=e.id WHERE ${eligible} AND r.entry_id IS NULL LIMIT 1`).get())throw Error('原始未读投影与文章或屏蔽状态不一致');
}
