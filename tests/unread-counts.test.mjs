import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {installUnreadCounts,validateUnreadCounts,unreadCountTriggerNames} from '../dist-server/unread-counts.js';
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-count-state-')),db=new RivuDatabase(join(directory,'rivu.db')),a=db.addFeed({title:'A',url:'https://example.invalid/a'}),b=db.addFeed({title:'B',url:'https://example.invalid/b'});db.addEntries(a.id,Array.from({length:12},(_,i)=>({title:`Entry ${i}`,content:'original',hash:`e${i}`})));return {db,a,b,ids:db.entries().map(e=>e.id),close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
function install(f){f.db.db.exec('BEGIN IMMEDIATE');try{installUnreadCounts(f.db.db);validateUnreadCounts(f.db.db);f.db.db.exec('COMMIT');}catch(error){f.db.db.exec('ROLLBACK');throw error;}}
function check(f){validateUnreadCounts(f.db.db);const actual=new Map(f.db.db.prepare('SELECT * FROM rivu_feed_unread_counts').all().map(r=>[r.feed_id,r.unread_count]));for(const row of f.db.feeds())assert.equal(actual.get(row.id),row.unread_count);}
function rule(f,id,type='mute',enabled=1){f.db.db.prepare('INSERT INTO rules(id,name,priority,enabled,conditions,action_type,created_at,updated_at) VALUES (?,?,0,?,?,?, ?,?)').run(id,id,enabled,'{}',type,'2026','2026');}
function match(f,rule,id){f.db.db.prepare('INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,?)').run(rule,id,'2026');}
function ai(f,id,decision){f.db.setFilterDecision(id,{decision,reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'fixture'});}

test('transactional installer backfills existing overlaps and can roll back/rebuild without changing schema version',()=>{
 const f=fixture();try{
  rule(f,'mute');rule(f,'block','block');rule(f,'disabled','mute',0);match(f,'mute',f.ids[0]);match(f,'block',f.ids[0]);match(f,'disabled',f.ids[1]);ai(f,f.ids[0],'block');ai(f,f.ids[2],'mute');f.db.updateEntry(f.ids[3],{read:true});
  for(const name of unreadCountTriggerNames)f.db.db.exec(`DROP TRIGGER ${name}`);
  f.db.db.exec('DROP TABLE IF EXISTS rivu_raw_unread_entries;DROP TABLE rivu_entry_visibility; DROP TABLE rivu_feed_unread_counts');
  assert.throws(()=>installUnreadCounts(f.db.db),/事务/);
  f.db.db.exec('BEGIN IMMEDIATE');installUnreadCounts(f.db.db);check(f);f.db.db.exec('ROLLBACK');
  assert.equal(f.db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rivu_feed_unread_counts'").get(),undefined);
  install(f);check(f);assert.equal(f.db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  install(f);check(f);assert.equal(f.db.db.prepare('SELECT sum(unread_count) n FROM rivu_feed_unread_counts').get().n,9);
 }finally{f.close();}
});

test('incremental states handle read/move, overlapping rule changes, AI/body invalidation and nested rollback',()=>{
 const f=fixture();try{
  install(f);rule(f,'mute');rule(f,'block','block');rule(f,'save','save');
  for(const id of f.ids){match(f,'mute',id);match(f,'block',id);match(f,'save',id);}check(f);
  f.db.db.prepare("UPDATE rules SET enabled=0 WHERE id='mute'").run();check(f);
  f.db.db.prepare("UPDATE rules SET action_type='save' WHERE id='block'").run();check(f);
  ai(f,f.ids[0],'mute');ai(f,f.ids[1],'block');check(f);
  f.db.db.prepare('UPDATE entries SET read=1,content=? WHERE id=?').run('body and read together',f.ids[0]);check(f);
  f.db.db.prepare('UPDATE entries SET read=0,content=? WHERE id=?').run('another body',f.ids[1]);check(f);
  f.db.db.prepare('DELETE FROM entry_identities WHERE entry_id=?').run(f.ids[1]);
  f.db.db.prepare('UPDATE entries SET feed_id=? WHERE id=?').run(f.b.id,f.ids[1]);check(f);
  f.db.db.exec('SAVEPOINT count_rollback');f.db.db.exec("UPDATE rules SET enabled=1,action_type='mute' WHERE id='block'");f.db.db.exec('UPDATE entries SET read=1');check(f);f.db.db.exec('ROLLBACK TO count_rollback; RELEASE count_rollback');check(f);
  f.db.db.prepare("DELETE FROM rules WHERE id='block'").run();check(f);
  f.db.db.prepare('DELETE FROM entries WHERE id=?').run(f.ids[2]);check(f);
  f.db.deleteFeed(f.a.id);check(f);assert.equal(f.db.db.prepare('SELECT count(*) n FROM rivu_entry_visibility').get().n,1);
 }finally{f.close();}
});

test('direct rule-match/AI reassignment, all-read undo and external ordinary SQL stay transactional',()=>{
 const f=fixture();try{
  install(f);rule(f,'mute');rule(f,'save','save');match(f,'mute',f.ids[0]);check(f);
  f.db.db.prepare("UPDATE rule_matches SET entry_id=?,rule_id='save' WHERE rule_id='mute'").run(f.ids[1]);check(f);
  ai(f,f.ids[0],'mute');f.db.db.prepare('UPDATE ai_filter_decisions SET entry_id=?,decision=? WHERE entry_id=?').run(f.ids[2],'block',f.ids[0]);check(f);
  const ids=f.db.markRead({feedId:f.a.id});check(f);f.db.undoMarkRead(ids);check(f);
  const external=new DatabaseSync(f.db.path);try{external.prepare('UPDATE entries SET read=1 WHERE id=?').run(f.ids[4]);external.prepare('DELETE FROM entries WHERE id=?').run(f.ids[5]);}finally{external.close();}check(f);
  f.db.db.exec('PRAGMA foreign_keys=OFF');f.db.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(f.ids[6]);check(f);f.db.db.prepare('UPDATE entries SET feed_id=? WHERE id=?').run(f.b.id,f.ids[6]);check(f);f.db.db.exec('PRAGMA foreign_keys=ON');
 }finally{f.close();}
});

test('every mutation and its counters roll back when a later trigger fails; corruption is detected',()=>{
 const f=fixture();try{
  install(f);rule(f,'mute');
  f.db.db.exec("CREATE TRIGGER fail_count AFTER UPDATE ON rivu_feed_unread_counts BEGIN SELECT RAISE(ABORT,'counter failure'); END");
  assert.throws(()=>f.db.updateEntry(f.ids[0],{read:true}),/counter failure/);check(f);assert.equal(f.db.entryState(f.ids[0]).read,0);
  assert.throws(()=>match(f,'mute',f.ids[1]),/counter failure/);check(f);assert.equal(f.db.db.prepare('SELECT count(*) n FROM rule_matches').get().n,0);
  f.db.db.exec('DROP TRIGGER fail_count; UPDATE rivu_feed_unread_counts SET unread_count=999');assert.throws(()=>validateUnreadCounts(f.db.db),/计数/);install(f);check(f);
  f.db.db.exec('UPDATE rivu_entry_visibility SET visible=0');assert.throws(()=>validateUnreadCounts(f.db.db),/可见状态/);
 }finally{f.close();}
});
