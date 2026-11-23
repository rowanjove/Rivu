import type {DatabaseSync} from 'node:sqlite';

// All entry points are SQL triggers: a batch, its visibility effects and its
// counters therefore commit or roll back together on every application writer.
const visible=(entry:string)=>`CASE WHEN ${entry}.read=0 AND NOT (
 EXISTS(SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=${entry}.id AND r.enabled=1 AND r.action_type IN ('block','mute'))
 OR EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=${entry}.id AND a.decision IN ('block','mute'))
) THEN 1 ELSE 0 END`;
const reconcile=(ids:string)=>`UPDATE rivu_entry_visibility SET (feed_id,visible)=(
 SELECT e.feed_id,${visible('e')} FROM entries e INDEXED BY entries_list_metadata WHERE e.id=rivu_entry_visibility.entry_id
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
 db.exec(`CREATE TABLE IF NOT EXISTS rivu_entry_visibility (
   entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE ON UPDATE CASCADE,
   feed_id TEXT NOT NULL,visible INTEGER NOT NULL CHECK(visible IN (0,1))
 );
 CREATE INDEX IF NOT EXISTS rivu_visibility_feed ON rivu_entry_visibility(feed_id,visible);
 CREATE TABLE IF NOT EXISTS rivu_feed_unread_counts (
   feed_id TEXT PRIMARY KEY NOT NULL REFERENCES feeds(id) ON DELETE CASCADE ON UPDATE CASCADE,
   unread_count INTEGER NOT NULL CHECK(unread_count>=0)
 );
 DELETE FROM rivu_entry_visibility; DELETE FROM rivu_feed_unread_counts;
 INSERT INTO rivu_entry_visibility(entry_id,feed_id,visible)
 SELECT e.id,e.feed_id,${visible('e')} FROM entries e INDEXED BY entries_list_metadata;
 INSERT INTO rivu_feed_unread_counts(feed_id,unread_count)
 SELECT f.id,(SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=f.id AND v.visible=1) FROM feeds f;

 CREATE TRIGGER rivu_unread_state_insert AFTER INSERT ON rivu_entry_visibility BEGIN
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count+NEW.visible WHERE feed_id=NEW.feed_id;
 END;
 CREATE TRIGGER rivu_unread_state_delete AFTER DELETE ON rivu_entry_visibility BEGIN
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count-OLD.visible WHERE feed_id=OLD.feed_id;
 END;
 CREATE TRIGGER rivu_unread_state_update AFTER UPDATE OF feed_id,visible ON rivu_entry_visibility
 WHEN OLD.feed_id IS NOT NEW.feed_id OR OLD.visible IS NOT NEW.visible BEGIN
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count-OLD.visible WHERE feed_id=OLD.feed_id;
   UPDATE rivu_feed_unread_counts SET unread_count=unread_count+NEW.visible WHERE feed_id=NEW.feed_id;
 END;
 CREATE TRIGGER rivu_unread_entry_insert AFTER INSERT ON entries BEGIN
   INSERT INTO rivu_entry_visibility(entry_id,feed_id,visible) SELECT e.id,e.feed_id,${visible('e')} FROM entries e WHERE e.id=NEW.id
   ON CONFLICT(entry_id) DO UPDATE SET feed_id=excluded.feed_id,visible=excluded.visible;
 END;
 CREATE TRIGGER rivu_unread_entry_update AFTER UPDATE OF read,feed_id,id ON entries BEGIN
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

export function validateUnreadCounts(db:DatabaseSync){
 for(const name of unreadCountTriggerNames)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error(`未读统计触发器缺失：${name}`);
 const mismatch=db.prepare(`SELECT e.id FROM entries e INDEXED BY entries_list_metadata LEFT JOIN rivu_entry_visibility v ON v.entry_id=e.id
 WHERE v.entry_id IS NULL OR v.feed_id IS NOT e.feed_id OR v.visible IS NOT (${visible('e')}) LIMIT 1`).get();
 if(mismatch||db.prepare('SELECT 1 FROM rivu_entry_visibility v LEFT JOIN entries e ON e.id=v.entry_id WHERE e.id IS NULL LIMIT 1').get())throw Error('文章可见状态与原数据不一致');
 if(db.prepare(`SELECT f.id FROM feeds f LEFT JOIN rivu_feed_unread_counts c ON c.feed_id=f.id WHERE c.feed_id IS NULL OR c.unread_count IS NOT
 (SELECT count(*) FROM rivu_entry_visibility v WHERE v.feed_id=f.id AND v.visible=1) LIMIT 1`).get()
 ||db.prepare('SELECT 1 FROM rivu_feed_unread_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL LIMIT 1').get())throw Error('订阅未读计数与文章状态不一致');
}
