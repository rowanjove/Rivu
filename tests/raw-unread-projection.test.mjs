import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {buildSync} from 'esbuild';
import {RivuDatabase} from '../dist-server/database.cjs';
import {validateUnreadCounts} from '../dist-server/unread-counts.js';
const moduleDir=mkdtempSync(join(tmpdir(),'rivu-raw-projection-module-')),modulePath=join(moduleDir,'module.mjs');
buildSync({entryPoints:['server/raw-unread-projection.ts'],outfile:modulePath,bundle:true,platform:'node',format:'esm'});
const {installRawUnreadProjection,validateRawUnreadProjection}=await import(pathToFileURL(modulePath));
test.after(()=>rmSync(moduleDir,{recursive:true,force:true}));
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-raw-projection-')),model=new RivuDatabase(join(directory,'rivu.db')),feed=model.addFeed({title:'Source',url:'https://example.invalid/feed'});model.addEntries(feed.id,Array.from({length:12},(_,n)=>({title:String(n),content:'original',hash:'hash'+n})));return {directory,model,feed,ids:model.entries().map(row=>row.id),close(){model.close();rmSync(directory,{recursive:true,force:true});}};}
function install(f){f.model.db.exec('BEGIN');try{installRawUnreadProjection(f.model.db);validateRawUnreadProjection(f.model.db);f.model.db.exec('COMMIT');}catch(error){f.model.db.exec('ROLLBACK');throw error;}}
function count(f){validateRawUnreadProjection(f.model.db);validateUnreadCounts(f.model.db);return f.model.db.prepare('SELECT count(*) n FROM rivu_raw_unread_entries').get().n;}
function removeProjection(f){for(const name of ['rivu_raw_unread_state_insert','rivu_raw_unread_state_update','rivu_raw_unread_state_delete'])f.model.db.exec(`DROP TRIGGER IF EXISTS ${name}`);f.model.db.exec('DROP TABLE rivu_raw_unread_entries');}
function rule(f,id,type,entry){f.model.db.prepare("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES (?,?,'{}',?,'2026','2026')").run(id,id,type);f.model.db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,'2026')").run(id,entry);}
test('prototype installation is transactional, idempotent and leaves schema version and article bytes untouched',()=>{
 const f=fixture();try{
  const before=f.model.db.prepare('SELECT * FROM entries ORDER BY id').all();removeProjection(f);
  assert.throws(()=>installRawUnreadProjection(f.model.db),/事务/);
  f.model.db.exec('BEGIN');installRawUnreadProjection(f.model.db);f.model.db.exec('ROLLBACK');assert.equal(f.model.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rivu_raw_unread_entries'").get(),undefined);
  install(f);install(f);assert.equal(count(f),12);assert.equal(f.model.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(f.model.db.prepare('SELECT * FROM entries ORDER BY id').all(),before);
 }finally{f.close();}
});
test('muted read flips, rule and AI overlap/undo, body updates, external writes and rollback stay exact',()=>{
 const f=fixture();try{
  install(f);rule(f,'mute','mute',f.ids[0]);assert.equal(count(f),12);
  f.model.updateEntry(f.ids[0],{read:true});assert.equal(count(f),11);f.model.updateEntry(f.ids[0],{read:false});assert.equal(count(f),12);
  rule(f,'block','block',f.ids[0]);assert.equal(count(f),11);f.model.db.exec("UPDATE rules SET enabled=0 WHERE id='block'");assert.equal(count(f),12);
  f.model.setFilterDecision(f.ids[1],{decision:'block',reason:'test',criteria:'test',provider:'local',model:'test',content_hash:'test'});assert.equal(count(f),11);
  f.model.db.prepare('UPDATE entries SET content=? WHERE id=?').run('new body retains explicit filter decision',f.ids[1]);assert.equal(count(f),11);
  f.model.setFilterDecision(f.ids[1],{decision:'keep',reason:'',criteria:'',provider:'',model:'',content_hash:''});assert.equal(count(f),12);
  f.model.db.exec('BEGIN');try{f.model.db.exec("UPDATE rules SET enabled=1 WHERE id='block'");assert.equal(count(f),11);}finally{f.model.db.exec('ROLLBACK');}assert.equal(count(f),12);
  const external=new DatabaseSync(f.model.path);try{external.prepare('UPDATE entries SET read=1 WHERE id=?').run(f.ids[2]);external.prepare('DELETE FROM entries WHERE id=?').run(f.ids[3]);}finally{external.close();}assert.equal(count(f),10);
 }finally{f.close();}
});
test('identity/date/feed changes and independent corruption checks do not trust the projection source blindly',()=>{
 const f=fixture();try{
  install(f);const other=f.model.addFeed({title:'Other',url:'https://example.invalid/other'});
  f.model.db.prepare('DELETE FROM entry_identities WHERE entry_id=?').run(f.ids[0]);f.model.db.prepare('UPDATE entries SET feed_id=?,published_at=? WHERE id=?').run(other.id,'2020-01-02',f.ids[0]);assert.equal(count(f),12);
  assert.equal(f.model.db.prepare('SELECT feed_id FROM rivu_raw_unread_entries WHERE entry_id=?').get(f.ids[0]).feed_id,other.id);
  const replacement=randomUUID();f.model.db.prepare('UPDATE entries SET id=? WHERE id=?').run(replacement,f.ids[0]);assert.equal(f.model.db.prepare('SELECT 1 FROM rivu_raw_unread_entries WHERE entry_id=?').get(f.ids[0]),undefined);f.ids[0]=replacement;assert.equal(count(f),12);
  f.model.db.prepare('UPDATE rivu_entry_visibility SET visible=0,blocked=1 WHERE entry_id=?').run(f.ids[0]);assert.throws(()=>validateRawUnreadProjection(f.model.db),/不一致/);
  f.model.db.prepare('UPDATE rivu_entry_visibility SET visible=1,blocked=0 WHERE entry_id=?').run(f.ids[0]);assert.equal(count(f),12);
  f.model.db.exec('DROP INDEX rivu_raw_unread_feed; CREATE INDEX rivu_raw_unread_feed ON rivu_raw_unread_entries(entry_id)');assert.throws(()=>validateRawUnreadProjection(f.model.db),/索引/);
 }finally{f.close();}
});
test('malformed foreign keys, nullable identity and partial index definitions fail closed',()=>{
 for(const identity of ['TEXT PRIMARY KEY NOT NULL','TEXT PRIMARY KEY']){
  const f=fixture();try{
   removeProjection(f);
   f.model.db.exec(`CREATE TABLE rivu_raw_unread_entries(entry_id ${identity},feed_id TEXT NOT NULL,sort_time TEXT NOT NULL,sort_bucket TEXT NOT NULL)`);
   assert.throws(()=>install(f),/外键|列约束/);assert.equal(f.model.db.prepare('SELECT count(*) n FROM rivu_raw_unread_entries').get().n,0);
  }finally{f.close();}
 }
 const f=fixture();try{install(f);f.model.db.exec('DROP INDEX rivu_raw_unread_feed;CREATE INDEX rivu_raw_unread_feed ON rivu_raw_unread_entries(feed_id,sort_bucket DESC,sort_time DESC,entry_id DESC) WHERE entry_id IS NOT NULL');assert.throws(()=>validateRawUnreadProjection(f.model.db),/索引标志/);}finally{f.close();}
});
