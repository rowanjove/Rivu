import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase,SCHEMA_VERSION} from '../dist-server/database.cjs';
import {validateRawUnreadProjection,rawUnreadTriggerNames} from '../dist-server/raw-unread-projection.js';
import {createBackup,inspectBackup} from '../dist-server/backup.js';
const rows=db=>db.prepare('SELECT * FROM entries ORDER BY id').all();
const schema=db=>db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
function old41(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-raw-migration-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path);
 try{
  const feed=db.addFeed({title:'Old source',url:'https://example.invalid/old'});db.addEntries(feed.id,[{title:'Plain',content:'原始😀\u0000字节',hash:'plain'},{title:'Muted',content:'静音仍未读',hash:'muted'},{title:'Blocked',content:'屏蔽内容',hash:'blocked'},{title:'Read',content:'已读',hash:'read'}]);
  const ids=Object.fromEntries(db.entries({view:'all'}).map(row=>[row.title,row.id]));db.updateEntry(ids.Read,{read:true,starred:true,saved:true});
  for(const [name,type]of [['Muted','mute'],['Blocked','block']]){db.db.prepare("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES (?,?,'{}',?,'2026','2026')").run(type,type,type);db.db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,'2026')").run(type,ids[name]);}
  for(const name of rawUnreadTriggerNames)db.db.exec(`DROP TRIGGER ${name}`);db.db.exec('DROP TABLE rivu_raw_unread_entries;PRAGMA user_version=41');
  return {directory,path,before:rows(db.db),schema:schema(db.db),ids};
 }finally{db.close();}
}
test('genuine41 raw-unread migration preserves original snapshot, bytes and muted semantics on reopen',async ()=>{
 const f=old41();let db;try{
  const stages=[];db=await RivuDatabase.open(f.path,stage=>stages.push(stage));assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(stages,['snapshot','schema','index','verify','done']);assert.deepEqual(rows(db.db),f.before);validateRawUnreadProjection(db.db);
  assert.deepEqual(new Set(db.entries({query:'is:unread'}).map(row=>row.id)),new Set([f.ids.Plain,f.ids.Muted]));assert.deepEqual(db.entries({view:'unread'}).map(row=>row.id),[f.ids.Plain]);
  const snapshots=readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-'));assert.equal(snapshots.length,1);const original=new DatabaseSync(join(f.directory,snapshots[0]),{readOnly:true});try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,41);assert.deepEqual(rows(original),f.before);assert.deepEqual(schema(original),f.schema);}finally{original.close();}
  db.close();db=await RivuDatabase.open(f.path);assert.equal(readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-')).length,1);
 }finally{db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('late41 migration failure rolls back new structures and retains old schema/version/rows before retry',async ()=>{
 const f=old41(),prepare=DatabaseSync.prototype.prepare;let db;try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('raw migration late failure');return prepare.call(this,sql);};await assert.rejects(()=>RivuDatabase.open(f.path),/raw migration late failure/);DatabaseSync.prototype.prepare=prepare;
  const original=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,41);assert.deepEqual(rows(original),f.before);assert.deepEqual(schema(original),f.schema);}finally{original.close();}
  db=await RivuDatabase.open(f.path);validateRawUnreadProjection(db.db);
 }finally{DatabaseSync.prototype.prepare=prepare;db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('current malformed raw index fails without remigration and backup inspection rejects stale raw membership',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-raw-backup-')),path=join(directory,'rivu.db');let db=await RivuDatabase.open(path);try{
  const feed=db.addFeed({title:'Source',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'One',hash:'one'}]);db.db.exec('DELETE FROM rivu_raw_unread_entries');
  await assert.rejects(async()=>{const zip=join(directory,'invalid.zip');await createBackup(db,directory,zip);await inspectBackup(zip);},/原始未读/);
  db.db.exec('DROP INDEX rivu_raw_unread_feed;CREATE INDEX rivu_raw_unread_feed ON rivu_raw_unread_entries(entry_id)');db.close();db=null;
  await assert.rejects(()=>RivuDatabase.open(path),/原始未读索引/);assert.equal(readdirSync(directory).filter(name=>name.startsWith('pre-migration-')).length,0);
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});
