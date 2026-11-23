import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';

test('deep offset preserves full fields, tie order and orphan-feed exclusion without opening skipped bodies',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-deep-offset-')),db=new RivuDatabase(join(directory,'rivu.db'));
  try{
    const feed=db.addFeed({title:'Kept',url:'https://example.invalid/deep-kept'}),orphan=db.addFeed({title:'Orphan',url:'https://example.invalid/deep-orphan'});
    db.addEntries(feed.id,Array.from({length:10200},(_,index)=>({title:`Deep ${index}`,publishedAt:'2026-01-01',content:`正文 ${index}`,hash:`deep-${index}`})));
    db.addEntries(orphan.id,[{title:'Orphan recent',publishedAt:'2026-02-01',content:'Excluded',hash:'orphan'}]);
    const tag=db.addTag('Deep tag');
    db.db.prepare('INSERT INTO entry_tags(entry_id,tag_id) SELECT id,? FROM entries WHERE feed_id=?').run(tag.id,feed.id);
    db.db.prepare("INSERT INTO entry_media(entry_id,kind,url,mime,source,title,created_at) SELECT id,'image','https://example.invalid/image/'||id,NULL,'body',NULL,'2026-01-01' FROM entries WHERE feed_id=?").run(feed.id);
    const prepare=db.db.prepare.bind(db.db);let plan,lastSql,catalogPlan;
    db.db.prepare=sql=>{lastSql=sql;if(sql.startsWith('SELECT NOT EXISTS (SELECT 1 FROM rivu_source_entry_counts'))catalogPlan=prepare('EXPLAIN QUERY PLAN '+sql).all();const statement=prepare(sql);if(sql.startsWith('WITH selected')||sql.startsWith('WITH proof')){const all=statement.all;statement.all=function(...args){plan=prepare('EXPLAIN QUERY PLAN '+sql).all(...args);return all.apply(this,args);};}return statement;};
    const notBlocked="NOT EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='block') AND NOT EXISTS (SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='block')";
    const verify=()=>{
      const expected=prepare(`SELECT e.* FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${notBlocked} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET 10000`).all();
      const rich=db.entries({offset:10000,limit:100}),list=db.entries({offset:10000,limit:100,listOnly:true});
      assert.equal(rich.length,100);assert.deepEqual(rich.map(row=>row.id),expected.map(row=>row.id));assert.deepEqual(list.map(row=>row.id),expected.map(row=>row.id));
      for(let index=0;index<rich.length;index++)for(const [field,value] of Object.entries(expected[index]).filter(([name])=>name!=='storage_id'))assert.equal(rich[index][field],value,field);
      for(const row of rich)assert.ok(!('_rivu_page_order' in row));
      assert.ok(plan.some(row=>/SEARCH v USING (?:COVERING )?INDEX rivu_visibility_timeline/.test(row.detail)));
      assert.ok(catalogPlan.some(row=>/SCAN c/.test(row.detail)));assert.ok(!lastSql.includes('rivu_feed_catalog'), 'catalog proof must not run for each skipped entry');
      const scoped=prepare(`SELECT e.id FROM entries e WHERE e.feed_id=? AND ${notBlocked} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET 10000`).all(feed.id).map(row=>row.id);
      for(const options of [{tagId:tag.id},{view:'images'}])for(const listOnly of [true,false])assert.deepEqual(db.entries({...options,offset:10000,listOnly}).map(row=>row.id),scoped);
      for(const view of ['audio','video','summary','blocked'])assert.equal(db.entries({view,offset:10000}).length,0);
      const today=prepare(`SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${notBlocked} AND substr(e.published_at,1,10)=date('now','localtime') ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET 10000`).all().map(row=>row.id);
      assert.deepEqual(db.entries({view:'today',offset:10000}).map(row=>row.id),today);assert.ok(!lastSql.startsWith('WITH'));
    };
    verify();
    // Clean source/rule proof preserves mixed reading state and pagination validation.
    prepare('UPDATE entries SET read=1 WHERE id IN (SELECT id FROM entries ORDER BY id LIMIT 50)').run();
    for(const view of ['all','unread'])for(const listOnly of [true,false]){
      const predicate=view==='unread'?'AND e.read=0':'';
      const expected=prepare(`SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${notBlocked} ${predicate} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET 10000`).all().map(row=>row.id);
      assert.deepEqual(db.entries({view,listOnly,offset:10000}).map(row=>row.id),expected);
      const cursor={sortTime:'2026-01-01',id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};
      assert.throws(()=>db.entries({view,listOnly,offset:10000,cursor}),error=>error.statusCode===400);
    }
    prepare('UPDATE entries SET read=0').run();
    db.db.exec('PRAGMA foreign_keys=OFF');prepare('DELETE FROM feeds WHERE id=?').run(orphan.id);verify();
    const blockedIds=prepare('SELECT id FROM entries WHERE feed_id=? ORDER BY id DESC LIMIT 2').all(feed.id).map(row=>row.id);
    prepare("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES ('deep-block','Block','{}','block','2026','2026')").run();
    prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES ('deep-block',?,'2026')").run(blockedIds[0]);verify();
    prepare("INSERT INTO ai_filter_decisions(entry_id,decision,reason,criteria,provider,model,content_hash,updated_at) VALUES (?,'block','','','fixture','fixture','','2026')").run(blockedIds[1]);verify();
    prepare("UPDATE rules SET enabled=0 WHERE id='deep-block'").run();verify();
    assert.equal(db.entries({offset:10200,limit:100}).length,0);
    // Stateful views remain filtered exactly as before and use the original fallback.
    const ids=prepare(`SELECT e.id FROM entries e WHERE e.feed_id=? AND ${notBlocked} ORDER BY e.id DESC LIMIT 10100`).all(feed.id).map(row=>row.id);
    const star=prepare('UPDATE entries SET starred=1 WHERE id=?');db.db.exec('BEGIN');for(const id of ids)star.run(id);db.db.exec('COMMIT');
    assert.deepEqual(db.entries({view:'starred',offset:10000}).map(row=>row.id),ids.slice(10000));
    prepare('UPDATE entries SET read=1 WHERE id IN (SELECT id FROM entries WHERE feed_id=? ORDER BY id DESC LIMIT 100)').run(feed.id);
    const muteIds=prepare(`SELECT e.id FROM entries e WHERE e.feed_id=? AND e.read=0 AND ${notBlocked} ORDER BY e.id DESC LIMIT 2`).all(feed.id).map(row=>row.id);
    prepare("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES ('deep-mute','Mute','{}','mute','2026','2026')").run();
    prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES ('deep-mute',?,'2026')").run(muteIds[0]);
    prepare("INSERT INTO ai_filter_decisions(entry_id,decision,reason,criteria,provider,model,content_hash,updated_at) VALUES (?,'mute','','','fixture','fixture','','2026')").run(muteIds[1]);
    const notMuted="NOT EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='mute') AND NOT EXISTS (SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision='mute')";
    const verifyUnread=()=>{
      const expected=prepare(`SELECT e.* FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE e.read=0 AND ${notBlocked} AND ${notMuted} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET 10000`).all();
      for(const listOnly of [true,false]){
        const rows=db.entries({view:'unread',offset:10000,listOnly});assert.deepEqual(rows.map(row=>row.id),expected.map(row=>row.id));
        if(!listOnly)for(let index=0;index<rows.length;index++)for(const [field,value] of Object.entries(expected[index]).filter(([name])=>name!=='storage_id'))assert.equal(rows[index][field],value,field);
        assert.ok(plan.some(row=>/USING (?:COVERING )?INDEX rivu_visibility_unread/.test(row.detail)));
        assert.ok(!plan.some(row=>/USING COVERING INDEX entries_feed_unread/.test(row.detail)));
      }
    };
    verifyUnread();prepare("UPDATE rules SET enabled=0 WHERE id='deep-mute'").run();verifyUnread();
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
