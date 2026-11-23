import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase as OldDatabase} from './fixtures/schema43-startup.cjs';
import {RivuDatabase,SCHEMA_VERSION} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
import {createBackup,restoreBackup} from '../dist-server/backup.js';
const anchor={version:1,revision:'a'.repeat(64),path:[1,0],tag:'P',head:'begin',tail:'end',offset:-12.5};
const schema=db=>db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name<>'reading_positions' ORDER BY type,name").all();
const rows=db=>Object.fromEntries(['entries','rivu_entry_visibility','rivu_raw_unread_entries','rivu_source_entry_counts'].map(name=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()]));
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-anchor44-')),path=join(directory,'rivu.db'),old=new OldDatabase(path),feed=old.addFeed({title:'旧库',url:'https://example.invalid/old'});
 old.addEntries(feed.id,[{title:'anchor source',hash:'one',content:'<p>begin end</p>'},{title:'second',hash:'two'}]);const id=old.entries().find(row=>row.hash==='one')?.id||old.entries().find(row=>row.title==='anchor source').id;
 old.saveReadingPosition(id,.42);const before={schema:schema(old.db),rows:rows(old.db),position:old.readingPosition(id)};
 assert.equal(old.db.prepare('PRAGMA user_version').get().user_version,43);old.close();
 return {directory,path,id,before};
}
test('43 additive migration preserves progress, business rows, indexes and triggers with a standalone old snapshot',async()=>{
 const f=fixture(),exec=DatabaseSync.prototype.exec,executed=[];let db;
 try{
  DatabaseSync.prototype.exec=function(sql){executed.push(sql);return exec.call(this,sql);};
  db=await RivuDatabase.open(f.path);DatabaseSync.prototype.exec=exec;
  assert.equal(SCHEMA_VERSION,44);assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,44);
  assert.deepEqual(schema(db.db),f.before.schema);assert.deepEqual(rows(db.db),f.before.rows);assert.deepEqual(db.readingPosition(f.id),{...f.before.position});
  assert.equal(executed.some(sql=>/\b(?:DROP|CREATE)\s+(?:UNIQUE\s+)?INDEX\b|DROP TRIGGER|REBUILD/i.test(sql)),false);
  const snapshots=readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-'));assert.equal(snapshots.length,1);
  const before=new DatabaseSync(join(f.directory,snapshots[0]),{readOnly:true});try{assert.equal(before.prepare('PRAGMA user_version').get().user_version,43);assert.ok(!before.prepare('PRAGMA table_info(reading_positions)').all().some(row=>row.name==='anchor'));assert.deepEqual(rows(before),f.before.rows);}finally{before.close();}
  db.updateEntry(f.id,{read:true});assert.equal(db.db.prepare('SELECT 1 FROM rivu_raw_unread_entries WHERE entry_id=?').get(f.id),undefined);
 }finally{DatabaseSync.prototype.exec=exec;db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('failed43 migration rolls back the new field, schema version, data and triggers',async()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare;
 try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('anchor migration injected');return prepare.call(this,sql);};
  await assert.rejects(RivuDatabase.open(f.path),/anchor migration injected/);DatabaseSync.prototype.prepare=prepare;
  const raw=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(raw.prepare('PRAGMA user_version').get().user_version,43);assert.ok(!raw.prepare('PRAGMA table_info(reading_positions)').all().some(row=>row.name==='anchor'));assert.deepEqual(schema(raw),f.before.schema);assert.deepEqual(rows(raw),f.before.rows);}finally{raw.close();}
  assert.equal(readdirSync(f.directory).filter(name=>name.startsWith('pre-migration-')).length,1);
 }finally{DatabaseSync.prototype.prepare=prepare;rmSync(f.directory,{recursive:true,force:true});}
});
test('anchor API saves atomically, supports ratio clients, fails invalid writes and survives backup restore',async()=>{
 const f=fixture();let db=await RivuDatabase.open(f.path),service=createService(db,'token');
 const request=(method,payload)=>service.app.inject({method,url:`/api/entries/${f.id}/reading-position`,payload,headers:{'x-rivu-token':'token'}});
 try{
  db.entry=()=>{throw Error('Body must not be loaded');};
  let result=await request('PUT',{progress:.61,anchor});assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json().anchor,anchor);
  const saved=(await request('GET')).json();
  for(const patch of [{anchor:{...anchor,path:[-1]}},{anchor:''},{anchor:[]},{progress:2}]){
   result=await request('PUT',{progress:.8,anchor,...patch});assert.equal(result.statusCode,400,result.body);assert.deepEqual((await request('GET')).json(),saved);
  }
  for(const payload of [{progress:.7},{progress:.8,anchor:null}]){await request('PUT',payload);assert.equal((await request('GET')).json().anchor,undefined);await request('PUT',{progress:.61,anchor});}
  assert.equal((await service.app.inject({method:'PUT',url:`/api/entries/${f.id}/reading-position`,payload:{progress:.3,anchor}})).statusCode,401);
  await service.stop();service=null;db.close();db=await RivuDatabase.open(f.path);assert.deepEqual(db.readingPosition(f.id).anchor,anchor);
  const zip=join(f.directory,'small.zip'),restored=join(f.directory,'restored');await createBackup(db,f.directory,zip);await restoreBackup(zip,restored);
  const copy=await RivuDatabase.open(join(restored,'rivu.db'));try{assert.equal(copy.readingPosition(f.id).progress,.61);assert.deepEqual(copy.readingPosition(f.id).anchor,anchor);}finally{copy.close();}
  db.db.prepare('UPDATE reading_positions SET anchor=? WHERE entry_id=?').run('{"version":999}',f.id);assert.equal(db.readingPosition(f.id).anchor,undefined);assert.equal(db.readingPosition(f.id).progress,.61);
 }finally{await service?.stop();db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
