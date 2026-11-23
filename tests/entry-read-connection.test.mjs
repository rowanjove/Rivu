import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {RivuDatabase} from '../dist-server/database.cjs';
import {EntryReader} from '../dist-server/entry-reader.js';
const {EntryReadConnection,EntryJsonCache,readEntrySnapshot}=createRequire(import.meta.url)('../dist-server/entry-read-task.cjs');
const parse=value=>JSON.parse(Buffer.from(value.json).toString('utf8'));
test('retained read connection uses fresh coherent snapshots and resets cache on connection generations',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-read-connection-')),db=new RivuDatabase(join(directory,'one.db')),other=new RivuDatabase(join(directory,'two.db')),reader=new EntryReadConnection(),cache=new EntryJsonCache();
 try{
  const feed=db.addFeed({title:'来源',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'文章',content:'old',hash:'one'}]);const id=db.entries()[0].id,input={databasePath:db.path,kind:'entry',entryId:id,serialize:true};
  const first=parse(readEntrySnapshot(input,undefined,cache,reader)),connection=reader.get(db.path),generation=reader.generation;
  assert.equal(connection.isTransaction,false);assert.equal(first.content,'old');
  const held=parse(readEntrySnapshot(input,()=>db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('new',id),cache,reader));assert.deepEqual(held,first);
  assert.equal(parse(readEntrySnapshot(input,undefined,cache,reader)).content,'new');assert.equal(reader.get(db.path),connection);assert.equal(reader.generation,generation);
  assert.throws(()=>connection.exec('UPDATE entries SET read=1'),/readonly|read.only/i);
  assert.throws(()=>readEntrySnapshot(input,()=>{throw Error('snapshot fixture');},cache,reader),/snapshot fixture/);assert.equal(connection.isTransaction,false);
  assert.equal(readEntrySnapshot({...input,databasePath:other.path},undefined,cache,reader),undefined);assert.notEqual(reader.generation,generation);assert.equal(cache.bytes,0);assert.throws(()=>connection.prepare('SELECT 1').get());
  const next=reader.get(other.path);assert.throws(()=>reader.get(directory));assert.equal(reader.generation,'');assert.throws(()=>next.prepare('SELECT 1').get());
  assert.equal(parse(readEntrySnapshot(input,undefined,cache,reader)).content,'new');reader.close();assert.equal(reader.generation,'');
 }finally{reader.close();db.close();other.close();rmSync(directory,{recursive:true,force:true});}
});

test('read worker observes committed changes and releases database handles before stop returns',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-read-close-')),db=new RivuDatabase(join(directory,'rivu.db')),reader=new EntryReader(resolve('dist-server/entry-read-worker.cjs'));let closed=false;
 try{const feed=db.addFeed({title:'来源',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'文章',content:'old',hash:'one'}]);const id=db.entries()[0].id,input={databasePath:db.path,kind:'entry',entryId:id,serialize:true};assert.equal(parse(await reader.read(input)).content,'old');db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('new',id);assert.equal(parse(await reader.read(input)).content,'new');await reader.stop();await assert.rejects(reader.read(input),/关闭/);db.close();closed=true;renameSync(db.path,join(directory,'released.db'));}finally{await reader.stop();if(!closed)db.close();rmSync(directory,{recursive:true,force:true});}
});


test('role page-cache budgets apply to native connections and survive Worker recreation',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-reader-budget-')),db=new RivuDatabase(join(directory,'rivu.db'));
 const modulePath=join(directory,'budget.cjs'),workerPath=resolve('dist-server/entry-read-worker.cjs');
 writeFileSync(modulePath,`const base=require(${JSON.stringify(resolve('dist-server/entry-read-task.cjs'))});module.exports={...base,readEntrySnapshot(input,onSnapshot,cache,reader){if(input.kind==='crash')process.exit(2);return reader.get(input.databasePath).prepare('PRAGMA cache_size').get().cache_size;}};`);
 const readers=[new EntryReader(workerPath,modulePath,16,120000,131072),new EntryReader(workerPath,modulePath),new EntryReader(workerPath,modulePath)];
 try{
  for(let index=0;index<readers.length;index++){
   const reader=readers[index],input={kind:'budget',databasePath:db.path},expected=index===0?-131072:-2048;
   assert.equal(await reader.read(input),expected);
   await assert.rejects(reader.read({...input,kind:'crash'}),/退出|exit/i);
   assert.equal(await reader.read(input),expected);
  }
 }finally{await Promise.all(readers.map(reader=>reader.stop()));db.close();rmSync(directory,{recursive:true,force:true});}
});
