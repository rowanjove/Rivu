import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase,SCHEMA_VERSION} from './fixtures/schema42-startup.cjs';
import {installStableStorageKeys,validateStableStorageKeys} from '../dist-server/stable-storage.js';
import {installSearchRowidProjection,validateSearchRowidProjection} from '../dist-server/search-rowid-projection.js';
const pair=value=>'g'+Buffer.from(value).toString('hex');
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-stable-storage-')),path=join(directory,'rivu.db'),model=new RivuDatabase(path);
 const feed=model.addFeed({title:'source',url:'https://example.invalid/stable'});
 model.addEntries(feed.id,Array.from({length:8},(_,i)=>({title:'共同词 '+i,content:'正文 '+i,hash:String(i)})));
 const ids=model.entries({limit:20}).map(row=>row.id);
 for(const [index,id]of ids.entries())model.saveAI(id,'summary','','local','test','summary 摘要 '+index,'hash','v1');
 model.db.prepare('DELETE FROM entries WHERE id=?').run(ids[3]);
 const tag=model.addTag('tag');model.setEntryTags(ids[0],[tag.id]);model.saveReadingPosition(ids[0],0.3);
 return {directory,path,model,id:ids[0],close(){model.close();rmSync(directory,{recursive:true,force:true});}};
}
function rows(db,table,columns){const statement=db.prepare(`SELECT ${columns.map(name=>'"'+name+'"').join(',')} FROM ${table} ORDER BY id`);statement.setReadBigInts(true);return statement.all();}
function identities(db,table){const statement=db.prepare(`SELECT id,rowid physical FROM ${table} ORDER BY id`);statement.setReadBigInts(true);return statement.all();}
function matches(db){return [['entry_fts','"共同词"'],['entry_pair_fts',pair('共')],['ai_result_fts','"summary"'],['ai_result_pair_fts',pair('摘')]].map(([table,term])=>{const statement=db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`);statement.setReadBigInts(true);return statement.all(term);});}
function migrate(db,action=()=>{}){
 db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
 try{installStableStorageKeys(db);action();assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON');}
}

test('stable entries and AI keys preserve raw columns, dependent rows, FTS and public fields across VACUUM',async()=>{
 const f=fixture();try{
  const db=f.model.db;
  db.prepare('UPDATE entries SET rowid=?,title=title WHERE id=?').run(9007199254740993n,f.id);
  db.prepare('UPDATE ai_results SET rowid=?,content=content WHERE entry_id=?').run(9223372036854775806n,f.id);
  const columns=Object.fromEntries(['entries','ai_results'].map(table=>[table,db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name)]));
  const before=Object.fromEntries(Object.entries(columns).map(([table,names])=>[table,rows(db,table,names)])),keys=Object.fromEntries(['entries','ai_results'].map(table=>[table,identities(db,table)]));
  const posting=matches(db),children=db.prepare('SELECT * FROM entry_identities ORDER BY entry_id,kind,value').all(),ai=JSON.parse(JSON.stringify(f.model.aiResult(f.id,'summary','')));
  db.exec('PRAGMA wal_autocheckpoint=0');db.prepare("UPDATE entries SET title=title||' wal' WHERE id=?").run(f.id);before.entries=rows(db,'entries',columns.entries);
  assert.equal(existsSync(f.path+'-wal'),true);
  const onlinePath=join(f.directory,'online-before.db');await backup(db,onlinePath);
  const online=new DatabaseSync(onlinePath,{readOnly:true});try{for(const table of ['entries','ai_results']){assert.deepEqual(identities(online,table),keys[table]);assert.deepEqual(rows(online,table,columns[table]),before[table]);}assert.deepEqual(matches(online),posting);}finally{online.close();}
  migrate(db,()=>installSearchRowidProjection(db));validateStableStorageKeys(db);validateSearchRowidProjection(db);
  for(const table of ['entries','ai_results']){assert.deepEqual(identities(db,table),keys[table]);assert.deepEqual(rows(db,table,columns[table]),before[table]);}
  assert.deepEqual(db.prepare('SELECT * FROM entry_identities ORDER BY entry_id,kind,value').all(),children);
  assert.deepEqual(JSON.parse(JSON.stringify(f.model.aiResult(f.id,'summary',''))),ai);assert.equal('storage_id' in f.model.validAIResult(f.id,'summary','','local','test','hash','v1'),false);assert.equal('storage_id' in f.model.entry(f.id),false);
  const publicAI=f.model.saveAI(f.id,'summary','','local','test','summary 摘要 replaced','hash','v1');assert.equal('storage_id' in publicAI,false);
  const finalPosting=matches(db);db.exec('VACUUM');validateSearchRowidProjection(db);validateStableStorageKeys(db);assert.deepEqual(matches(db),finalPosting);
  const vacuumPath=join(f.directory,'after-vacuum.db');db.exec(`VACUUM INTO '${vacuumPath.replaceAll("'","''")}'`);
  const vacuum=new DatabaseSync(vacuumPath,{readOnly:true});try{for(const table of ['entries','ai_results'])assert.deepEqual(identities(vacuum,table),keys[table]);validateStableStorageKeys(vacuum);validateSearchRowidProjection(vacuum);assert.deepEqual(matches(vacuum),finalPosting);assert.equal(vacuum.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);}finally{vacuum.close();}
 }finally{f.close();}
});

test('stable migration rolls back all DDL and rejects physical key changes including combined body updates',()=>{
 const f=fixture();try{
  const db=f.model.db,original=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),keys=identities(db,'entries');
  assert.throws(()=>installStableStorageKeys(db),/迁移/);
  assert.throws(()=>migrate(db,()=>{throw Error('injected');}),/injected/);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),original);assert.deepEqual(identities(db,'entries'),keys);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  migrate(db);const posting=matches(db);
  for(const alias of ['storage_id','rowid','_rowid_','oid']){
   assert.throws(()=>db.prepare(`UPDATE entries SET ${alias}=${alias}+1000,content='changed' WHERE id=?`).run(f.id),/不可更改/);
   assert.throws(()=>db.prepare(`UPDATE ai_results SET ${alias}=${alias}+1000,content='changed' WHERE entry_id=?`).run(f.id),/不可更改/);
  }
  assert.deepEqual(matches(db),posting);db.prepare('UPDATE entries SET storage_id=storage_id WHERE id=?').run(f.id);validateStableStorageKeys(db);
 }finally{f.close();}
});
