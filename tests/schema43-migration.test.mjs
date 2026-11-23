import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase as OldDatabase} from './fixtures/schema42-startup.cjs';
import {RivuDatabase,SCHEMA_VERSION} from '../dist-server/database.cjs';
import {validateSearchRowidProjection} from '../dist-server/search-rowid-projection.js';
function oldFixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-real42-')),path=join(directory,'rivu.db'),db=new OldDatabase(path),feed=db.addFeed({title:'old',url:'https://example.invalid/42'});
 db.addEntries(feed.id,[{title:'共同词',content:'正文😀\0bytes',hash:'one'},{title:'second',hash:'two'}]);const id=db.entries().find(row=>row.title==='共同词').id;
 db.saveAI(id,'summary','','local','test','旧摘要 shared','hash','v1');db.updateEntry(id,{read:true,starred:true,saved:true});
 const columns=Object.fromEntries(['entries','ai_results'].map(table=>[table,db.db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name)]));
 const state=raw(db.db,columns),schema=db.db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();db.close();return {directory,path,id,columns,state,schema};
}
function raw(db,columns){return Object.fromEntries(Object.entries(columns).map(([table,names])=>[table,db.prepare(`SELECT ${names.map(name=>'"'+name+'"').join(',')},CAST(rowid AS TEXT) physical FROM ${table} ORDER BY id`).all()]));}
test('genuine42 upgrades both integer identities and preserves snapshot, business fields and public results',async()=>{
 const f=oldFixture();let db;try{
  db=await RivuDatabase.open(f.path);assert.equal(SCHEMA_VERSION,44);assert.deepEqual(raw(db.db,f.columns),f.state);assert.equal(db.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.db.prepare('PRAGMA legacy_alter_table').get().legacy_alter_table,0);validateSearchRowidProjection(db.db);
  assert.equal('storage_id' in db.entry(f.id),false);assert.equal('storage_id' in db.aiResult(f.id,'summary',''),false);
  const snapshots=readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-'));assert.equal(snapshots.length,1);const original=new DatabaseSync(join(f.directory,snapshots[0]),{readOnly:true});try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,42);assert.deepEqual(raw(original,f.columns),f.state);assert.deepEqual(original.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),f.schema);}finally{original.close();}
  assert.throws(()=>db.db.prepare('UPDATE entries SET rowid=rowid+100,content=? WHERE id=?').run('changed',f.id),/不可更改/);
  db.db.exec('VACUUM');assert.deepEqual(raw(db.db,f.columns),f.state);validateSearchRowidProjection(db.db);db.close();db=null;
  db=await RivuDatabase.open(f.path);assert.equal(readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-')).length,1);
 }finally{db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('late43 failure restores the entire42 schema and old fields before a successful retry',async()=>{
 const f=oldFixture(),prepare=DatabaseSync.prototype.prepare;let db;try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('injected43');return prepare.call(this,sql);};await assert.rejects(()=>RivuDatabase.open(f.path),/injected43/);DatabaseSync.prototype.prepare=prepare;
  const original=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,42);assert.deepEqual(raw(original,f.columns),f.state);assert.deepEqual(original.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),f.schema);}finally{original.close();}
  db=await RivuDatabase.open(f.path);validateSearchRowidProjection(db.db);
 }finally{DatabaseSync.prototype.prepare=prepare;db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
