import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase,SCHEMA_VERSION} from './fixtures/schema42-startup.cjs';
import {installSearchRowidProjection,validateSearchRowidProjection,validateSearchRowidStructure} from '../dist-server/search-rowid-projection.js';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-search-rowid-')),model=new RivuDatabase(join(directory,'rivu.db'));
 const a=model.addFeed({title:'a',url:'https://example.invalid/a'}),b=model.addFeed({title:'b',url:'https://example.invalid/b'});
 model.addEntries(a.id,Array.from({length:8},(_,i)=>({title:'中文 '+i,content:'original '+i,hash:String(i),publishedAt:`2026-01-0${i+1}T00:00:00Z`})));
 const ids=model.entries({limit:20}).map(row=>row.id);
 return {model,a,b,ids,install(){model.db.exec('BEGIN');try{installSearchRowidProjection(model.db);model.db.exec('COMMIT');}catch(error){model.db.exec('ROLLBACK');throw error;}},check(){validateSearchRowidProjection(model.db);assert.deepEqual(model.db.prepare('PRAGMA foreign_key_check').all(),[]);},close(){model.close();rmSync(directory,{recursive:true,force:true});}};
}

test('search rowid installer is transactional and does not change the current schema version',()=>{
 const f=fixture();try{
  assert.throws(()=>installSearchRowidProjection(f.model.db),/事务/);
  f.model.db.exec('BEGIN');installSearchRowidProjection(f.model.db);f.check();f.model.db.exec('ROLLBACK');
  assert.equal(f.model.db.prepare("SELECT 1 FROM sqlite_master WHERE name='rivu_search_entries'").get(),undefined);
  assert.equal(f.model.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  f.install();f.check();assert.equal(f.model.db.prepare('SELECT count(*) n FROM rivu_search_entries').get().n,8);
 }finally{f.close();}
});

test('search rowid membership tracks rules, read state, identities, physical rowids, reuse and rollback',()=>{
 const f=fixture();try{
  f.install();const db=f.model.db,id=f.ids[0];
  for(const [rule,type]of [['mute','mute'],['block','block']])db.prepare("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES (?,?,'{}',?,'2026','2026')").run(rule,rule,type);
  db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES ('mute',?,'2026')").run(id);f.check();
  f.model.updateEntry(id,{read:true});f.check();assert.equal(db.prepare('SELECT read FROM rivu_search_entries WHERE entry_id=?').get(id).read,1);
  f.model.updateEntry(id,{read:false});f.check();
  db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES ('block',?,'2026')").run(id);f.check();
  f.model.setFilterDecision(id,{decision:'block',reason:'test',criteria:'test',provider:'local',model:'test',content_hash:'test'});f.check();
  db.exec("UPDATE rules SET enabled=0 WHERE id='block'");f.check();assert.equal(db.prepare('SELECT blocked FROM rivu_search_entries WHERE entry_id=?').get(id).blocked,1);
  f.model.setFilterDecision(id,{decision:'keep',reason:'test',criteria:'test',provider:'local',model:'test',content_hash:'test'});f.check();
  assert.throws(()=>db.prepare('UPDATE entries SET feed_id=? WHERE id=?').run(f.b.id,id),/FOREIGN KEY/);f.check();
  db.prepare('DELETE FROM entry_identities WHERE entry_id=?').run(id);
  db.prepare('UPDATE entries SET feed_id=?,published_at=NULL,fetched_at=?,read=2 WHERE id=?').run(f.b.id,'2027-02-01',id);f.check();
  db.prepare('UPDATE entries SET rowid=rowid+1000 WHERE id=?').run(id);f.check();
  db.prepare('UPDATE entries SET _rowid_=_rowid_+1000 WHERE id=?').run(id);f.check();
  db.prepare('UPDATE entries SET oid=oid+1000 WHERE id=?').run(id);f.check();
  db.prepare('DELETE FROM rule_matches WHERE entry_id=?').run(id);db.prepare('DELETE FROM ai_filter_decisions WHERE entry_id=?').run(id);
  const replacement='00000000-0000-4000-8000-000000000001';db.prepare('UPDATE entries SET id=? WHERE id=?').run(replacement,id);f.check();
  assert.equal(db.prepare('SELECT 1 FROM rivu_search_entries WHERE entry_id=?').get(id),undefined);
  const before=db.prepare('SELECT * FROM rivu_search_entries ORDER BY entry_id').all();db.exec('BEGIN');db.prepare('DELETE FROM entries WHERE id=?').run(replacement);f.check();db.exec('ROLLBACK');assert.deepEqual(db.prepare('SELECT * FROM rivu_search_entries ORDER BY entry_id').all(),before);
  const oldRowid=db.prepare('SELECT rowid FROM entries WHERE id=?').get(replacement).rowid;db.prepare('DELETE FROM entries WHERE id=?').run(replacement);f.check();
  f.model.addEntries(f.a.id,[{title:'reused',content:'new body',hash:'new-hash'}]);const next=f.model.entries({limit:20}).find(row=>row.title==='reused');db.prepare('UPDATE entries SET rowid=? WHERE id=?').run(oldRowid,next.id);f.check();
  db.prepare('DELETE FROM feeds WHERE id=?').run(f.a.id);f.check();assert.equal(db.prepare('SELECT count(*) n FROM rivu_search_entries').get().n,0);
 }finally{f.close();}
});

test('search rowid validation rejects missing members, corrupt upstream visibility and malformed indexes',()=>{
 const f=fixture();try{
  f.install();const db=f.model.db,id=f.ids[0];
  db.exec('BEGIN');db.prepare('DELETE FROM rivu_search_entries WHERE entry_id=?').run(id);assert.throws(()=>validateSearchRowidProjection(db),/原始/);db.exec('ROLLBACK');
  db.exec('BEGIN');db.prepare('UPDATE rivu_entry_visibility SET blocked=1,visible=0 WHERE entry_id=?').run(id);assert.throws(()=>validateSearchRowidProjection(db),/原始/);db.exec('ROLLBACK');
  db.exec('BEGIN');db.exec('DROP INDEX rivu_search_timeline; CREATE INDEX rivu_search_timeline ON rivu_search_entries(blocked,sort_time DESC,entry_id DESC,entry_rowid,feed_id,visible,read) WHERE blocked=0');assert.throws(()=>validateSearchRowidStructure(db),/索引/);db.exec('ROLLBACK');
  db.exec('BEGIN');db.exec('CREATE UNIQUE INDEX unexpected_search_unique ON rivu_search_entries(sort_time,entry_id)');assert.throws(()=>validateSearchRowidStructure(db),/唯一/);db.exec('ROLLBACK');f.check();
 }finally{f.close();}
});
