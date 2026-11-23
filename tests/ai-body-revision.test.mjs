import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {AIService} from '../dist-server/ai.js';
import {unreadCountTriggerNames} from '../dist-server/unread-counts.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-body-revision-')),path=join(dir,'rivu.db'),db=new RivuDatabase(path),feed=db.addFeed({title:'Local',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Title',content:'<p>Body</p>',hash:'one'}]);return {dir,path,db,feed,id:db.entries()[0].id};}
function downgrade(f){for(const name of unreadCountTriggerNames)f.db.db.exec(`DROP TRIGGER ${name}`);f.db.db.exec('DROP TABLE IF EXISTS rivu_raw_unread_entries;DROP TABLE rivu_entry_visibility; DROP TABLE rivu_feed_unread_counts; DROP TABLE rivu_source_entry_counts; DROP TABLE rivu_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_feed_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_category_timeline_bucket_counts; DROP INDEX IF EXISTS entries_ai_identity; DROP INDEX IF EXISTS entries_list_metadata; DROP TRIGGER entry_body_revision_insert; DROP TRIGGER entry_body_revision_update; ALTER TABLE entries DROP COLUMN body_revision; PRAGMA user_version=32');f.db.close();}
test('body revisions change for every input field, survive ABA, ignore reading state and roll back with content',()=>{
  const f=fixture();try{const revision=()=>f.db.aiBodyIdentity(f.id).body_revision;let prior=revision();assert.match(prior,/^[0-9a-f]{32}$/);f.db.db.exec('PRAGMA recursive_triggers=ON');
    for(const [field,value] of [['title','Other'],['content','<p>Changed</p>'],['description','Description'],['full_content','<p>Full</p>']]){f.db.db.prepare(`UPDATE entries SET ${field}=? WHERE id=?`).run(value,f.id);assert.notEqual(revision(),prior);prior=revision();}
    f.db.updateEntry(f.id,{read:true,starred:true,saved:true});f.db.db.prepare('UPDATE entries SET full_content=full_content WHERE id=?').run(f.id);assert.equal(revision(),prior);
    f.db.db.exec('BEGIN');f.db.db.prepare('UPDATE entries SET full_content=? WHERE id=?').run('Transient',f.id);assert.notEqual(revision(),prior);f.db.db.exec('ROLLBACK');assert.equal(revision(),prior);assert.equal(f.db.aiBodySnapshot(f.id).html,'<p>Full</p>');
    f.db.setFullContent(f.id,'Other');f.db.setFullContent(f.id,'<p>Full</p>');assert.notEqual(revision(),prior);
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('same ID reinsert during preparation rejects the old result even with identical title and HTML',async()=>{
  const f=fixture();let release,ready;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>ready=resolve);let acted=false;
  const ai=new AIService(f.db,undefined,undefined,async()=>{ready();await gate;return 'Body';});
  try{const before=f.db.aiBodyIdentity(f.id).body_revision,pending=ai.withPreparedBodies([f.id],()=>{acted=true;return ai.previewAction(f.id,'summary');});await started;f.db.db.prepare('DELETE FROM entries WHERE id=?').run(f.id);f.db.db.prepare('INSERT INTO entries(id,feed_id,title,content,hash,fetched_at) VALUES (?,?,?,?,?,?)').run(f.id,f.feed.id,'Title','<p>Body</p>','one','2026-01-01');assert.notEqual(f.db.aiBodyIdentity(f.id).body_revision,before);release();await assert.rejects(pending,error=>error.statusCode===409);assert.equal(acted,false);
  }finally{release();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('prepared previews read HTML once and use only metadata for subsequent validation',async()=>{
  const f=fixture();let snapshots=0,identities=0;const snapshot=f.db.aiBodySnapshot.bind(f.db),identity=f.db.aiBodyIdentity.bind(f.db);f.db.aiBodySnapshot=id=>{snapshots++;return snapshot(id);};f.db.aiBodyIdentity=id=>{identities++;return identity(id);};f.db.entry=()=>{throw Error('Rich body read is forbidden during prepared previews');};const ai=new AIService(f.db,undefined,undefined,async()=> 'Body');
  try{await ai.withPreparedBodies([f.id],()=>{for(let i=0;i<10;i++)assert.equal(ai.previewAction(f.id,'summary').body,'Body');assert.equal(ai.preview([f.id]).sources[0].excerpt,'Body');f.db.db.prepare('UPDATE entries SET description=? WHERE id=?').run('Changed',f.id);assert.throws(()=>ai.previewAction(f.id,'summary'),error=>error.statusCode===409);});assert.equal(snapshots,1);assert.ok(identities>=13);
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('real schema32 upgrade preserves article bytes and states, snapshots the old schema and initializes revisions',async ()=>{
  const f=fixture();f.db.setFullContent(f.id,'<p>中文😀 Full</p>');f.db.updateEntry(f.id,{read:true,starred:true,saved:true});const {body_revision,...before}=f.db.db.prepare('SELECT * FROM entries WHERE id=?').get(f.id);downgrade(f);
  try{const db=await RivuDatabase.open(f.path);try{assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);const {body_revision:revision,...after}=db.db.prepare('SELECT * FROM entries WHERE id=?').get(f.id);assert.deepEqual(after,before);assert.match(revision,/^[0-9a-f]{32}$/);db.setFullContent(f.id,'Changed');assert.notEqual(db.aiBodyIdentity(f.id).body_revision,revision);}finally{db.close();}
    const files=readdirSync(f.dir).filter(name=>name.startsWith('pre-migration-'));assert.equal(files.length,1);const old=new DatabaseSync(join(f.dir,files[0]),{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,32);assert.deepEqual({...old.prepare('SELECT * FROM entries WHERE id=?').get(f.id)},before);assert.ok(!old.prepare('PRAGMA table_info(entries)').all().some(row=>row.name==='body_revision'));}finally{old.close();}
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('schema33 verification failure rolls back the new column and triggers without changing schema32 data',async ()=>{
  const f=fixture();const {body_revision,...before}=f.db.db.prepare('SELECT * FROM entries WHERE id=?').get(f.id);f.db.db.exec("UPDATE app_meta SET value='invalid' WHERE key='archive_revision'");downgrade(f);
  try{await assert.rejects(()=>RivuDatabase.open(f.path),/归档修订记录无效/);const raw=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(raw.prepare('PRAGMA user_version').get().user_version,32);assert.deepEqual({...raw.prepare('SELECT * FROM entries WHERE id=?').get(f.id)},before);assert.ok(!raw.prepare('PRAGMA table_info(entries)').all().some(row=>row.name==='body_revision'));assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'entry_body_revision_%'").get().n,0);}finally{raw.close();}
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('current schema refuses missing revision triggers and rejects malformed revision values',async ()=>{
  const f=fixture();try{assert.throws(()=>f.db.db.prepare('UPDATE entries SET body_revision=? WHERE id=?').run('invalid',f.id),/CHECK/);f.db.db.exec('DROP TRIGGER entry_body_revision_update');f.db.close();await assert.rejects(()=>RivuDatabase.open(f.path),/entry_body_revision_update/);assert.equal(readdirSync(f.dir).filter(name=>name.startsWith('pre-migration-')).length,0);}finally{rmSync(f.dir,{recursive:true,force:true});}
});
