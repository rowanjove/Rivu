import type {DatabaseSync} from 'node:sqlite';

// Independent next-schema component. Installing it never changes user_version.
export const searchRowidTriggers=['rivu_search_state_insert','rivu_search_state_update','rivu_search_state_delete','rivu_search_rowid_update'] as const;
const reconcile=`INSERT INTO rivu_search_entries(entry_rowid,entry_id,feed_id,sort_time,blocked,visible,read)
 SELECT e.rowid,NEW.entry_id,NEW.feed_id,NEW.sort_time,NEW.blocked,NEW.visible,e.read FROM entries e INDEXED BY entries_list_metadata WHERE e.id=NEW.entry_id
 ON CONFLICT(entry_id) DO UPDATE SET entry_rowid=excluded.entry_rowid,feed_id=excluded.feed_id,sort_time=excluded.sort_time,blocked=excluded.blocked,visible=excluded.visible,read=excluded.read;`;
const blocked=`EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='block') OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='block')`;
const muted=`EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='mute') OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='mute')`;

export function installSearchRowidProjection(db:DatabaseSync){
 if(!db.isTransaction)throw Error('搜索行号投影必须在迁移事务内安装');
 for(const name of searchRowidTriggers)db.exec(`DROP TRIGGER IF EXISTS ${name}`);
 db.exec(`CREATE TABLE IF NOT EXISTS rivu_search_entries(
  entry_rowid INTEGER PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
  feed_id TEXT NOT NULL,sort_time TEXT NOT NULL,
  blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),visible INTEGER NOT NULL CHECK(visible IN (0,1)),read INTEGER NOT NULL
 );
 DELETE FROM rivu_search_entries;
 INSERT INTO rivu_search_entries SELECT e.rowid,e.id,v.feed_id,v.sort_time,v.blocked,v.visible,e.read FROM rivu_entry_visibility v CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=v.entry_id;
 CREATE INDEX IF NOT EXISTS rivu_search_timeline ON rivu_search_entries(blocked,sort_time DESC,entry_id DESC,entry_rowid,feed_id,visible,read);
 CREATE INDEX IF NOT EXISTS rivu_search_unscoped ON rivu_search_entries(blocked,sort_time DESC,entry_id DESC,entry_rowid,visible,read);
 CREATE INDEX IF NOT EXISTS rivu_search_feed ON rivu_search_entries(feed_id,blocked,sort_time DESC,entry_id DESC,entry_rowid,visible,read);
 CREATE TRIGGER rivu_search_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN ${reconcile} END;
 CREATE TRIGGER rivu_search_state_update AFTER UPDATE OF entry_id,feed_id,sort_time,blocked,visible ON rivu_entry_visibility BEGIN
  DELETE FROM rivu_search_entries WHERE entry_id=OLD.entry_id AND OLD.entry_id IS NOT NEW.entry_id;
  ${reconcile}
 END;
 CREATE TRIGGER rivu_search_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN DELETE FROM rivu_search_entries WHERE entry_id=OLD.entry_id; END;
 CREATE TRIGGER rivu_search_rowid_update AFTER UPDATE OF rowid,_rowid_,oid ON entries BEGIN UPDATE rivu_search_entries SET entry_rowid=NEW.rowid WHERE entry_id=NEW.id; END;`);
 validateSearchRowidStructure(db);
}

export function validateSearchRowidStructure(db:DatabaseSync){
 const columns=db.prepare('PRAGMA table_info(rivu_search_entries)').all();
 for(const name of ['entry_rowid','entry_id','feed_id','sort_time','blocked','visible','read']){
  const column=columns.find(row=>row.name===name),type=['entry_id','feed_id','sort_time'].includes(name)?'TEXT':'INTEGER';
  if(!column||column.type!==type||column.notnull!==1||column.pk!==(name==='entry_rowid'?1:0))throw Error('搜索行号列约束无效：'+name);
 }
 const foreign=db.prepare('PRAGMA foreign_key_list(rivu_search_entries)').all();
 if(foreign.length!==1||foreign[0].table!=='entries'||foreign[0].from!=='entry_id'||foreign[0].to!=='id'||foreign[0].on_update!=='CASCADE'||foreign[0].on_delete!=='CASCADE')throw Error('搜索行号身份外键无效');
 const indexes=db.prepare('PRAGMA index_list(rivu_search_entries)').all(),unique=indexes.filter(row=>row.unique===1);
 if(unique.length!==1||unique[0].partial!==0)throw Error('搜索文章身份唯一约束无效');
 const identity=db.prepare('SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(unique[0].name);
 if(identity.length!==1||identity[0].name!=='entry_id'||identity[0].coll!=='BINARY')throw Error('搜索文章身份索引无效');
 for(const [name,expected]of [['rivu_search_timeline','blocked:0,sort_time:1,entry_id:1,entry_rowid:0,feed_id:0,visible:0,read:0'],['rivu_search_unscoped','blocked:0,sort_time:1,entry_id:1,entry_rowid:0,visible:0,read:0'],['rivu_search_feed','feed_id:0,blocked:0,sort_time:1,entry_id:1,entry_rowid:0,visible:0,read:0']]){
  const index=indexes.find(row=>row.name===name);
  const keys=db.prepare('SELECT name,desc,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(name);
  if(!index||index.unique!==0||index.partial!==0||keys.map(row=>`${row.name}:${row.desc}`).join(',')!==expected||keys.some(row=>row.coll!=='BINARY'))throw Error('搜索时间索引无效：'+name);
 }
 for(const name of searchRowidTriggers)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error('搜索行号触发器缺失：'+name);
}

export function validateSearchRowidProjection(db:DatabaseSync){
 validateSearchRowidStructure(db);
 const mismatch=db.prepare(`SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_search_entries s ON s.entry_id=e.id
 WHERE s.entry_id IS NULL OR s.entry_rowid IS NOT e.rowid OR s.feed_id IS NOT e.feed_id OR s.sort_time IS NOT COALESCE(e.published_at,e.fetched_at)
 OR s.read IS NOT e.read OR s.blocked IS NOT CASE WHEN (${blocked}) THEN 1 ELSE 0 END
 OR s.visible IS NOT CASE WHEN e.read=0 AND NOT (${blocked}) AND NOT (${muted}) THEN 1 ELSE 0 END
 UNION ALL SELECT s.entry_id FROM rivu_search_entries s LEFT JOIN entries e INDEXED BY entries_list_metadata ON e.id=s.entry_id WHERE e.id IS NULL LIMIT 1`).get();
 if(mismatch)throw Error('搜索行号投影与原始文章或规则不一致');
}
