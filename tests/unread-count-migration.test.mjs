import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {unreadCountTriggerNames,validateUnreadCounts} from '../dist-server/unread-counts.js';
import {createBackup,inspectBackup,restoreBackup} from '../dist-server/backup.js';
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-count-migrate-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),feed=db.addFeed({title:'Preserved',url:'https://example.invalid/old'});db.addEntries(feed.id,[{title:'Read',content:'<p>Original 😀</p>',hash:'one'},{title:'Hidden',content:'<p>Hidden body</p>',hash:'two'}]);const ids=db.entries().map(r=>r.id);db.updateEntry(ids[0],{read:true,starred:true,saved:true});db.setFilterDecision(ids[1],{decision:'mute',reason:'old',criteria:'old',provider:'local',model:'local',content_hash:'two'});for(const name of unreadCountTriggerNames)db.db.exec(`DROP TRIGGER ${name}`);db.db.exec('DROP TABLE IF EXISTS rivu_raw_unread_entries;DROP TABLE rivu_entry_visibility; DROP TABLE rivu_feed_unread_counts; DROP TABLE rivu_source_entry_counts; DROP TABLE rivu_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_feed_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_category_timeline_bucket_counts; PRAGMA user_version=35');const before=db.db.prepare('SELECT * FROM entries ORDER BY id').all();db.close();return {directory,path,before,close(){rmSync(directory,{recursive:true,force:true});}};}

test('genuine schema35 upgrades atomically with one original snapshot, stable article bytes and no historical index rebuild',async ()=>{
 const f=fixture();let db;
 try{
  const stages=[];db=await RivuDatabase.open(f.path,stage=>stages.push(stage));assert.deepEqual(stages,['snapshot','schema','index','verify','done']);
  assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(db.db.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);validateUnreadCounts(db.db);
  const snapshots=readdirSync(f.directory).filter(n=>n.startsWith('pre-migration-'));assert.equal(snapshots.length,1);const old=new DatabaseSync(join(f.directory,snapshots[0]),{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,35);assert.deepEqual(old.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='rivu_feed_unread_counts'").get(),undefined);}finally{old.close();}
  db.close();db=await RivuDatabase.open(f.path);assert.equal(readdirSync(f.directory).filter(n=>n.startsWith('pre-migration-')).length,1);
 }finally{db?.close();f.close();}
});

test('post-backfill migration failure rolls back version, both tables, triggers and data before a safe retry',async ()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare;let db;
 try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('injected verify failure');return prepare.call(this,sql);};
  await assert.rejects(()=>RivuDatabase.open(f.path),/injected verify failure/);DatabaseSync.prototype.prepare=prepare;
  const old=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,35);assert.deepEqual(old.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='rivu_feed_unread_counts'").get(),undefined);}finally{old.close();}
  db=await RivuDatabase.open(f.path);validateUnreadCounts(db.db);
 }finally{DatabaseSync.prototype.prepare=prepare;db?.close();f.close();}
});

test('backup inspection and restore reject semantically corrupt counters before replacing existing data',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-count-backup-')),source=await RivuDatabase.open(join(directory,'rivu.db')),target=join(directory,'target');let current;
 try{
  source.addFeed({title:'Source',url:'https://example.invalid/source'});source.db.exec('UPDATE rivu_feed_unread_counts SET unread_count=777');const archive=join(directory,'corrupt.zip');await createBackup(source,directory,archive);
  await assert.rejects(inspectBackup(archive),/计数/);current=await RivuDatabase.open(join(target,'rivu.db'));current.addFeed({title:'Keep target',url:'https://example.invalid/keep'});current.close();current=null;
  await assert.rejects(restoreBackup(archive,target),/计数/);current=await RivuDatabase.open(join(target,'rivu.db'));assert.equal(current.feeds()[0].title,'Keep target');validateUnreadCounts(current.db);
 }finally{current?.close();source.close();rmSync(directory,{recursive:true,force:true});}
});
