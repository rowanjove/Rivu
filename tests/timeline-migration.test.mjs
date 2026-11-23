import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {validateUnreadCounts,unreadCountTriggerNames} from '../dist-server/unread-counts.js';
const require=createRequire(import.meta.url);
// Frozen schema36 installer SHA256: 9AFD76B1D1E6AB0F5DEC8C88FC3E7A4ABDB358BC544585502C6491ABC727FCC7.
function legacy(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-timeline-migration-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),outfile=join(directory,'schema36.cjs');
 buildSync({entryPoints:['tests/fixtures/schema36-unread.ts'],outfile,bundle:true,platform:'node',format:'cjs'});
 try{
  const feed=db.addFeed({title:'Original',url:'https://example.invalid/timeline'});db.addEntries(feed.id,[{title:'Old',content:'原文😀\u0000字节',hash:'a',publishedAt:'2025-01-01'},{title:'New',content:'原文二',hash:'b'}]);
  const ids=db.entries().map(row=>row.id);db.updateEntry(ids[0],{read:true});db.setFilterDecision(ids[1],{decision:'block',reason:'old',criteria:'old',provider:'fixture',model:'fixture',content_hash:'a'});
  db.db.exec('BEGIN');for(const name of unreadCountTriggerNames)db.db.exec(`DROP TRIGGER ${name}`);db.db.exec('DROP TABLE IF EXISTS rivu_raw_unread_entries;DROP TABLE rivu_entry_visibility; DROP TABLE rivu_feed_unread_counts; DROP TABLE rivu_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_feed_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_category_timeline_bucket_counts; DROP TABLE rivu_source_entry_counts');require(outfile).installUnreadCounts(db.db);db.db.exec('PRAGMA user_version=36; COMMIT');
  const before=db.db.prepare('SELECT * FROM entries ORDER BY id').all(),triggers=db.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'rivu_unread_%' ORDER BY name").all();
  assert.deepEqual(db.db.prepare('PRAGMA table_info(rivu_entry_visibility)').all().map(row=>row.name),['entry_id','feed_id','visible']);
  return {directory,path,before,triggers,close(){rmSync(directory,{recursive:true,force:true});}};
 }finally{db.close();}
}
test('genuine schema36 gains ordered visibility atomically with original snapshots and unchanged article bytes',async ()=>{
 const f=legacy();let db;
 try{const stages=[];db=await RivuDatabase.open(f.path,stage=>stages.push(stage));assert.deepEqual(stages,['snapshot','schema','index','verify','done']);assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(db.db.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);validateUnreadCounts(db.db);
  const snapshots=readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-'));assert.equal(snapshots.length,1);const old=new DatabaseSync(join(f.directory,snapshots[0]),{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,36);assert.deepEqual(old.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);assert.deepEqual(old.prepare('PRAGMA table_info(rivu_entry_visibility)').all().map(row=>row.name),['entry_id','feed_id','visible']);}finally{old.close();}
  db.close();db=await RivuDatabase.open(f.path);assert.equal(readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-')).length,1);
 }finally{db?.close();f.close();}
});
test('schema36 upgrade failure restores original columns, triggers, version and rows before retry',async ()=>{
 const f=legacy(),prepare=DatabaseSync.prototype.prepare;let db;
 try{DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('timeline verification failure');return prepare.call(this,sql);};await assert.rejects(()=>RivuDatabase.open(f.path),/timeline verification failure/);DatabaseSync.prototype.prepare=prepare;
  const old=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,36);assert.deepEqual(old.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);assert.deepEqual(old.prepare('PRAGMA table_info(rivu_entry_visibility)').all().map(row=>row.name),['entry_id','feed_id','visible']);assert.deepEqual(old.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'rivu_unread_%' ORDER BY name").all(),f.triggers);assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name='rivu_visibility_timeline'").get(),undefined);}finally{old.close();}
  db=await RivuDatabase.open(f.path);validateUnreadCounts(db.db);
 }finally{DatabaseSync.prototype.prepare=prepare;db?.close();f.close();}
});
test('timestamp changes, hidden decisions and rollback maintain ordered projections and reject wrong named indexes',async ()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-timeline-state-')),path=join(directory,'rivu.db'),db=await RivuDatabase.open(path);let closed=false;
 try{const feed=db.addFeed({title:'Fixture',url:'https://example.invalid/state'});db.addEntries(feed.id,[{title:'One',hash:'a',publishedAt:'2020-01-01'}]);const id=db.entries()[0].id;
  for(const [published,fetched] of [[null,'2026-01-01'],['2027-01-01','2026-01-01'],['2027-01-01','2028-01-01']]){db.db.prepare('UPDATE entries SET published_at=?,fetched_at=? WHERE id=?').run(published,fetched,id);validateUnreadCounts(db.db);assert.equal(db.db.prepare('SELECT sort_time FROM rivu_entry_visibility WHERE entry_id=?').get(id).sort_time,published??fetched);}
  db.setFilterDecision(id,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'local',content_hash:'a'});assert.equal(db.db.prepare('SELECT blocked FROM rivu_entry_visibility WHERE entry_id=?').get(id).blocked,1);validateUnreadCounts(db.db);
  db.db.exec('BEGIN');db.db.prepare("UPDATE entries SET published_at='2030' WHERE id=?").run(id);db.db.prepare("UPDATE ai_filter_decisions SET decision='mute' WHERE entry_id=?").run(id);validateUnreadCounts(db.db);assert.equal(db.db.prepare('SELECT blocked FROM rivu_entry_visibility WHERE entry_id=?').get(id).blocked,0);db.db.exec('ROLLBACK');validateUnreadCounts(db.db);assert.equal(db.db.prepare('SELECT sort_time,blocked FROM rivu_entry_visibility WHERE entry_id=?').get(id).sort_time,'2027-01-01');
  db.db.exec('DROP INDEX rivu_visibility_unread; CREATE INDEX rivu_visibility_unread ON rivu_entry_visibility(entry_id)');db.close();closed=true;await assert.rejects(()=>RivuDatabase.open(path),/排序索引无效/);assert.equal(readdirSync(directory).filter(name=>name.startsWith('pre-migration-')).length,0);
 }finally{if(!closed)db.close();rmSync(directory,{recursive:true,force:true});}
});
