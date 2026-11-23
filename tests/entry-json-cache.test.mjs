import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,copyFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {RivuDatabase} from '../dist-server/database.cjs';
import {DatabaseSync} from 'node:sqlite';
const {EntryJsonCache,readEntrySnapshot}=createRequire(import.meta.url)('../dist-server/entry-read-task.cjs');
const bytes=value=>new TextEncoder().encode(value),parse=result=>result?JSON.parse(new TextDecoder().decode(result.json)):result;

test('image presence is revision/cover guarded and recognizes the HTML image alias',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-presence-')),db=new RivuDatabase(join(directory,'rivu.db')),cache=new EntryJsonCache();
 try{
  const feed=db.addFeed({title:'Presence',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Plain',hash:'plain',content:'<p>plain</p>'}]);const id=db.entries()[0].id;
  const input=row=>({databasePath:db.path,kind:'image_presence',entryId:id,bodyRevision:row.body_revision,cover:row.cover??null});
  const old=db.entry(id);readEntrySnapshot({databasePath:db.path,kind:'entry',entryId:id,serialize:true},undefined,cache);
  assert.equal(readEntrySnapshot(input(old),undefined,cache),false);
  db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('<image src="alias.png">',id);
  assert.equal(readEntrySnapshot(input(old),undefined,cache),undefined);
  const next=db.entry(id);assert.equal(readEntrySnapshot(input(next),undefined,cache),true);
  db.db.prepare('UPDATE entries SET cover=? WHERE id=?').run('/cover.png',id);
  assert.equal(readEntrySnapshot(input(next),undefined,cache),undefined);
  assert.equal(readEntrySnapshot(input(db.entry(id)),undefined,cache),true);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('off-main image hint follows effective body and cover across cache hits and revision changes without entering article JSON',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-hint-cache-')),db=new RivuDatabase(join(directory,'rivu.db')),cache=new EntryJsonCache();
 try{
  const feed=db.addFeed({title:'Hint',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Hint',content:'plain',hash:'hint'}]);const id=db.entries()[0].id;
  for(const [content,description,full,cover,expected] of [['plain','',null,null,false],['<IMG/>','',null,null,true],['<img src="old.png">','','plain full text',null,false],['<img src="old.png">','',null,null,true],['plain','',null,'/cover.png',true],['','<img src="description.png">',null,null,true],['plain','<img src="unused.png">',null,null,false]]){
   db.db.prepare('UPDATE entries SET content=?,description=?,full_content=?,cover=? WHERE id=?').run(content,description,full,cover,id);
   for(let i=0;i<2;i++){const result=readEntrySnapshot({databasePath:db.path,kind:'entry',entryId:id,serialize:true},undefined,cache);assert.equal(result.imageHint,expected);assert.equal('imageHint' in parse(result),false);}
  }
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
test('cache hits never materialize body columns and a changed revision forces a fresh body read',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-json-cache-columns-')),db=new RivuDatabase(join(directory,'rivu.db')),cache=new EntryJsonCache(),prepare=DatabaseSync.prototype.prepare;
 try{const feed=db.addFeed({title:'Source',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Title',content:'original body',hash:'one'}]);const id=db.entries()[0].id,input={databasePath:db.path,kind:'entry',entryId:id,serialize:true};const first=parse(readEntrySnapshot(input,undefined,cache));DatabaseSync.prototype.prepare=function(sql){if(/\be\.(content|description|full_content)\b/.test(sql))throw Error('fixture body columns forbidden');return prepare.call(this,sql);};assert.deepEqual(parse(readEntrySnapshot(input,undefined,cache)),first);db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('changed body',id);assert.throws(()=>readEntrySnapshot(input,undefined,cache),/body columns forbidden/);DatabaseSync.prototype.prepare=prepare;assert.equal(parse(readEntrySnapshot(input,undefined,cache)).content,'changed body');}finally{DatabaseSync.prototype.prepare=prepare;db.close();rmSync(directory,{recursive:true,force:true});}
});
test('serialized cache budgets metadata and bytes, evicts LRU, and survives transfer without exposing retained storage',()=>{
 const cache=new EntryJsonCache(2000,2),original=bytes('original');cache.put('a','one',original);structuredClone(original.buffer,{transfer:[original.buffer]});assert.equal(new TextDecoder().decode(cache.get('a','one')),'original');const copy=cache.get('a','one');copy.fill(0);assert.equal(new TextDecoder().decode(cache.get('a','one')),'original');cache.put('b','one',bytes('b'));cache.get('a','one');cache.put('c','one',bytes('c'));assert.equal(cache.get('b','one'),undefined);assert.ok(cache.bytes<=2000);assert.equal(cache.get('a','changed'),undefined);cache.delete('c');assert.equal(cache.bytes,0);cache.put('large','sig',bytes('x'.repeat(2001)));assert.equal(cache.bytes,0);cache.put('metadata','x'.repeat(2000),bytes('x'));assert.equal(cache.bytes,0);assert.throws(()=>new EntryJsonCache(0),/预算/);
});
test('every cache hit rechecks current metadata and revision, preserving source, states, body, rules, ABA and missing semantics',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-json-cache-')),db=new RivuDatabase(join(directory,'rivu.db')),cache=new EntryJsonCache();
 try{
  const feed=db.addFeed({title:'Source',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Title',content:'<p>Original 中文😀</p>',description:'description',hash:'one'}]);const id=db.entries()[0].id,input={databasePath:db.path,kind:'entry',entryId:id,serialize:true},expected=()=>JSON.parse(JSON.stringify(db.entry(id))),check=()=>assert.deepEqual(parse(readEntrySnapshot(input,undefined,cache)),expected());
  check();check();db.updateEntry(id,{read:true,starred:true,saved:true,archived:true});check();db.updateFeed(feed.id,{title:'Changed source',allowPrivate:true});check();db.db.prepare('UPDATE entries SET content=?,description=?,full_content=? WHERE id=?').run('New body','New description','Full text',id);check();
  db.db.prepare('INSERT INTO rules(id,name,priority,enabled,conditions,action_type,created_at,updated_at) VALUES (?,?,0,1,?,?,?,?)').run('cache-rule','Rule','{}','mute','2026','2026');db.db.prepare('INSERT INTO rule_matches VALUES (?,?,?)').run('cache-rule',id,'2026');check();db.db.prepare('UPDATE rules SET enabled=0 WHERE id=?').run('cache-rule');check();
  db.setFilterDecision(id,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'one'});check();
  const committed=expected();db.db.exec('BEGIN');try{db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('Uncommitted',id);assert.deepEqual(parse(readEntrySnapshot(input,undefined,cache)),committed);}finally{db.db.exec('ROLLBACK');}check();
  const old=db.entry(id);db.db.prepare('DELETE FROM entries WHERE id=?').run(id);assert.equal(readEntrySnapshot(input,undefined,cache),undefined);db.db.prepare('INSERT INTO entries(id,feed_id,title,content,hash,fetched_at) VALUES (?,?,?,?,?,?)').run(id,feed.id,'Recreated','New identity','two',old.fetched_at);check();assert.notEqual(db.entry(id).body_revision,old.body_revision);db.deleteFeed(feed.id);assert.equal(readEntrySnapshot(input,undefined,cache),undefined);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
test('cache observes coherent WAL snapshots and does not reuse entries after file replacement',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-json-cache-snapshot-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),cache=new EntryJsonCache();let closed=false;
 try{const feed=db.addFeed({title:'Source',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Title',content:'old body',hash:'one'}]);const id=db.entries()[0].id,input={databasePath:path,kind:'entry',entryId:id,serialize:true};const old=parse(readEntrySnapshot(input,undefined,cache));const held=parse(readEntrySnapshot(input,()=>db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('new body',id),cache));assert.deepEqual(held,old);assert.equal(parse(readEntrySnapshot(input,undefined,cache)).content,'new body');
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();closed=true;const replacement=join(directory,'replacement.db');copyFileSync(path,replacement);const copy=new RivuDatabase(replacement);try{copy.db.exec('DROP TRIGGER entry_body_revision_update');copy.db.prepare('UPDATE entries SET content=? WHERE id=?').run('replacement bytes',id);copy.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{copy.close();}renameSync(path,join(directory,'original.db'));renameSync(replacement,path);assert.equal(parse(readEntrySnapshot(input,undefined,cache)).content,'replacement bytes');
 }finally{if(!closed)db.close();rmSync(directory,{recursive:true,force:true});}
});
