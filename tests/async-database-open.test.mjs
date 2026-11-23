import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,rmSync,statSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase,SCHEMA_VERSION} from '../dist-server/database.cjs';
import {RivuDatabase as OldDatabase} from './fixtures/schema42-startup.cjs';
import {rawUnreadTriggerNames} from '../dist-server/raw-unread-projection.js';
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-async-open-')),path=join(directory,'rivu.db'),model=new OldDatabase(path);
 const feed=model.addFeed({title:'source',url:'https://example.invalid/async'});model.addEntries(feed.id,[{title:'原始共同词',content:'正文😀\0字节',hash:'one'},{title:'remove',hash:'two'},{title:'保留共同词',hash:'three'}]);
 const id=model.entries({limit:20}).find(row=>row.hash==='one').id;
 model.saveAI(id,'summary','','local','test','摘要 common summary','hash','v1');
 model.db.prepare('UPDATE entries SET rowid=?,title=title WHERE id=?').run(9007199254740993n,id);
 model.db.prepare('UPDATE ai_results SET rowid=?,content=content WHERE entry_id=?').run(9223372036854775806n,id);
 const removed=model.entries({limit:20}).find(row=>row.hash==='two');model.db.prepare('DELETE FROM entries WHERE id=?').run(removed.id);
 model.db.exec('PRAGMA wal_autocheckpoint=0');
 for(const name of rawUnreadTriggerNames)model.db.exec(`DROP TRIGGER ${name}`);model.db.exec('DROP TABLE rivu_raw_unread_entries;PRAGMA user_version=41');
 model.db.prepare('UPDATE entries SET description=? WHERE id=?').run('committed in WAL',id);
 return {directory,path,model,id,close(){model.close();rmSync(directory,{recursive:true,force:true});}};
}
function identities(db,table){const statement=db.prepare(`SELECT id,rowid physical FROM ${table} ORDER BY id`);statement.setReadBigInts(true);return statement.all();}
function posting(db){return [['entry_fts','"共同词"'],['entry_pair_fts','g'+Buffer.from('共').toString('hex')],['ai_result_fts','"summary"'],['ai_result_pair_fts','g'+Buffer.from('摘').toString('hex')]].map(([table,term])=>{const statement=db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`);statement.setReadBigInts(true);return statement.all(term);});}
const snapshots=f=>readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-'));

test('async open preserves committed WAL, exact64 article/AI rowids and four FTS posting sets in one standalone snapshot',async()=>{
 const f=fixture();let upgraded;try{
  const keys=Object.fromEntries(['entries','ai_results'].map(table=>[table,identities(f.model.db,table)])),terms=posting(f.model.db),raw=plain(f.model.db.prepare('SELECT * FROM entries ORDER BY id').all()),stages=[];let competingWrite;
  assert.ok(statSync(f.path+'-wal').size>0);
  upgraded=await RivuDatabase.open(f.path,stage=>{
   stages.push(stage);if(stage==='snapshot'){
    const competitor=new DatabaseSync(f.path,{timeout:1});try{competitor.prepare('UPDATE entries SET read=read WHERE id=?').run(f.id);competingWrite='unexpected-success';}catch(error){competingWrite={code:error.code,errcode:error.errcode};}finally{competitor.close();}
   }
  });
  assert.deepEqual(competingWrite,{code:'ERR_SQLITE_ERROR',errcode:5});assert.deepEqual(stages,['snapshot','schema','index','verify','done']);
  const files=snapshots(f);assert.equal(files.length,1);assert.ok(files[0].endsWith('.db'));
  const original=new DatabaseSync(join(f.directory,files[0]),{readOnly:true});try{
   assert.equal(original.prepare('PRAGMA user_version').get().user_version,41);assert.equal(original.prepare('PRAGMA journal_mode').get().journal_mode,'delete');
   for(const table of ['entries','ai_results'])assert.deepEqual(identities(original,table),keys[table]);assert.deepEqual(posting(original),terms);assert.deepEqual(plain(original.prepare('SELECT * FROM entries ORDER BY id').all()),raw);assert.equal(original.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{original.close();}
  assert.equal(snapshots(f).length,1);assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(posting(upgraded.db),terms);
 }finally{upgraded?.close();f.close();}
});

test('async snapshot validation failure releases the writer and removes only its incomplete snapshot',async()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare;try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA quick_check')throw Error('injected snapshot validation');return prepare.call(this,sql);};
  await assert.rejects(()=>RivuDatabase.open(f.path),/injected snapshot validation/);DatabaseSync.prototype.prepare=prepare;
  assert.deepEqual(snapshots(f),[]);assert.equal(f.model.db.prepare('PRAGMA user_version').get().user_version,41);
  assert.equal(readdirSync(f.directory).some(name=>name.endsWith('.partial')),false);
  f.model.db.prepare('UPDATE entries SET read=read WHERE id=?').run(f.id);
  const upgraded=await RivuDatabase.open(f.path);upgraded.close();assert.equal(snapshots(f).length,1);
 }finally{DatabaseSync.prototype.prepare=prepare;f.close();}
});

test('abandoned partial files stay distinct from validated published snapshots',async()=>{
 const f=fixture();let upgraded;try{
  const partial=join(f.directory,'.rivu-migration-00000000-0000-4000-8000-000000000000.partial');writeFileSync(partial,'interrupted copy');
  upgraded=await RivuDatabase.open(f.path);assert.equal(snapshots(f).length,1);assert.equal(readFileSync(partial,'utf8'),'interrupted copy');
  assert.equal(readdirSync(f.directory).filter(name=>name.endsWith('.partial')).length,1);
 }finally{upgraded?.close();f.close();}
});

test('sync constructors fail closed for old databases and background writers while async current opens never snapshot again',async()=>{
 const f=fixture();let upgraded;try{
  assert.throws(()=>new RivuDatabase(f.path),/异步/);assert.throws(()=>new RivuDatabase(f.path,undefined,true),/后台写入/);assert.deepEqual(snapshots(f),[]);
  upgraded=await RivuDatabase.open(f.path,()=>{throw Error('observer');});upgraded.close();upgraded=undefined;
  upgraded=await RivuDatabase.open(f.path);assert.equal(snapshots(f).length,1);upgraded.close();upgraded=undefined;
  f.model.db.exec(`PRAGMA user_version=${SCHEMA_VERSION+1}`);await assert.rejects(()=>RivuDatabase.open(f.path),/高于/);assert.equal(snapshots(f).length,1);
 }finally{upgraded?.close();f.close();}
});
