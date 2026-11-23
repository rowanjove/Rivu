import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{universalSearchProof}=require('../dist-server/entry-read-task.cjs'),{RivuDatabase}=require('../dist-server/database.cjs');
import {queryEntries as legacy} from './fixtures/schema36-entry-query.mjs';

test('universal proof requires a snapshot and rejects equal counts with an uncovered rowid',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE TABLE entries(id TEXT);CREATE VIRTUAL TABLE entry_fts USING fts5(body);INSERT INTO entries(rowid,id) VALUES(1,'a'),(2,'b'),(3,'c');INSERT INTO entry_fts(rowid,body) VALUES(1,'common'),(2,'common'),(3,'common')");
  assert.throws(()=>universalSearchProof(db),/快照/);
  db.exec('BEGIN');assert.equal(universalSearchProof(db)('entry_fts','common'),true);db.exec('ROLLBACK');
  db.exec("DELETE FROM entry_fts WHERE rowid=2;INSERT INTO entry_fts(rowid,body) VALUES(0,'common');BEGIN");
  assert.equal(universalSearchProof(db)('entry_fts','common'),false);
  db.exec('ROLLBACK');
  db.exec('DELETE FROM entries WHERE rowid=2;BEGIN');assert.equal(universalSearchProof(db)('entry_fts','common'),false);db.exec('ROLLBACK');
 }finally{db.close();}
});

test('universal proof handles empty tables and exact 64-bit integer intervals',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE entries(id TEXT);CREATE VIRTUAL TABLE entry_fts USING fts5(body);BEGIN');assert.equal(universalSearchProof(db)('entry_fts','common'),true);db.exec('ROLLBACK');
  for(const rowid of [9007199254740992n,9007199254740993n]){db.prepare('INSERT INTO entries(rowid,id) VALUES(?,?)').run(rowid,String(rowid));db.prepare('INSERT INTO entry_fts(rowid,body) VALUES(?,?)').run(rowid,'common');}
  db.exec('BEGIN');assert.equal(universalSearchProof(db)('entry_fts','common'),true);db.exec('ROLLBACK');
 }finally{db.close();}
});

test('a missing endpoint rejects coverage without counting the posting list',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE TABLE entries(id TEXT);CREATE VIRTUAL TABLE entry_pair_fts USING fts5(body);INSERT INTO entries(rowid,id) VALUES(1,'a'),(2,'b'),(3,'c');INSERT INTO entry_pair_fts(rowid,body) VALUES(1,'other'),(2,'common'),(3,'common');BEGIN");
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{assert.doesNotMatch(sql,/count\(\*\)/i);return prepare(sql);};
  assert.equal(universalSearchProof(db)('entry_pair_fts','common'),false);
 }finally{db.close();}
});

test('universal and near-universal terms preserve frozen query fields, filters and transaction state',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-universal-search-')),model=new RivuDatabase(join(directory,'rivu.db'));
 try{
  const feed=model.addFeed({title:'source',url:'https://example.invalid/all'});
  model.addEntries(feed.id,Array.from({length:1200},(_,i)=>({title:'共同词 '+i,content:'共同词 full body',hash:String(i),publishedAt:'2026-01-01T00:00:00Z'})));
  const compare=options=>{for(const listOnly of [true,false])assert.deepEqual(JSON.parse(JSON.stringify(model.entries({...options,listOnly}))),JSON.parse(JSON.stringify(legacy(model.db,{...options,listOnly}))));};
  for(const query of ['共同词','共同','共同词 is:unread','共同词 after:2025-01-01','共同词 %','共同词 共同','共同词 1199'])compare({query,offset:1100,limit:17});
  const id=model.entries({limit:1})[0].id;model.db.prepare("UPDATE entries SET title='different',content='different' WHERE id=?").run(id);
  compare({query:'共同词',offset:1100,limit:17});
  model.db.exec('BEGIN');model.db.prepare("UPDATE entries SET title='共同词',content='共同词' WHERE id=?").run(id);compare({query:'共同词',offset:1100,limit:17});assert.equal(model.db.isTransaction,true);model.db.exec('ROLLBACK');
  assert.throws(()=>model.entries({query:'共同词',offset:-1}),/分页/);assert.equal(model.db.isTransaction,false);
  assert.throws(()=>model.entries({query:'共同词',offset:1,cursor:{sortTime:'2026-01-01',id}}),/游标/);assert.equal(model.db.isTransaction,false);
  assert.throws(()=>model.entries({query:'a'.repeat(257),offset:1}),/过长/);assert.equal(model.db.isTransaction,false);
 }finally{model.close();rmSync(directory,{recursive:true,force:true});}
});
