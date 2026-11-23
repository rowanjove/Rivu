import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {RivuDatabase} from '../dist-server/database.cjs';
import {EntryReader} from '../dist-server/entry-reader.js';
import {createService} from '../dist-server/service.js';
const worker=resolve('dist-server/entry-read-worker.cjs'),modulePath=resolve('dist-server/entry-read-task.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'entry reader did not reach snapshot barrier');await delay(10);}}
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-entry-reader-')),db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'Local',url:'https://example.invalid/local'});db.addEntries(feed.id,Array.from({length:25},(_,i)=>({title:`Local ${i}`,content:`<p>中文😀 common ${i}</p>`,description:'description',publishedAt:'2026-01-01',hash:`row-${i}`})));return {directory,db,feed,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}

test('entry worker preserves rich fields, excerpts, search, scope and pagination errors',async()=>{
  const f=fixture(),reader=new EntryReader(worker);
  try{
    const first=f.db.entries()[0];f.db.updateEntry(first.id,{read:true,saved:true,starred:true});
    for(const options of [{},{listOnly:true},{view:'unread',listOnly:true},{query:'common',limit:10},{feedId:f.feed.id,offset:5,limit:5,listOnly:true},{view:'today',listOnly:true}]){
      assert.deepEqual(await reader.read({databasePath:f.db.path,kind:'entries',options}),JSON.parse(JSON.stringify(f.db.entries(options))));
    }
    for(const options of [{limit:501},{offset:-1},{query:'x'.repeat(257)},{cursor:{sortTime:'2026-01-01',id:first.id},offset:1}])await assert.rejects(reader.read({databasePath:f.db.path,kind:'entries',options}),error=>error.statusCode===400);
  }finally{await reader.stop();f.close();}
});

test('entry snapshot remains coherent during WAL commits, bounded queue and stop drain accepted reads',async()=>{
  const f=fixture(),gate=new SharedArrayBuffer(8),flags=new Int32Array(gate),custom=join(f.directory,'snapshot-task.cjs');
  writeFileSync(custom,`const {readEntrySnapshot}=require(${JSON.stringify(modulePath)});exports.readEntrySnapshot=input=>readEntrySnapshot(input,()=>{if(input.hold){const flags=new Int32Array(input.gate);Atomics.store(flags,0,1);Atomics.wait(flags,1,0);}});`);
  const reader=new EntryReader(worker,custom,1,10000),expected=JSON.parse(JSON.stringify(f.db.entries({listOnly:true})));
  try{
    const first=reader.read({databasePath:f.db.path,kind:'entries',options:{listOnly:true},hold:true,gate});await until(()=>Atomics.load(flags,0)===1);
    f.db.deleteFeed(f.feed.id);
    const second=reader.read({databasePath:f.db.path,kind:'entries',options:{listOnly:true}});
    await assert.rejects(reader.read({databasePath:f.db.path,kind:'entries',options:{}}),error=>error.statusCode===503&&error.resourceBusy);
    let stopped=false;const drain=reader.stop().then(()=>stopped=true);await delay(20);assert.equal(stopped,false);
    await assert.rejects(reader.read({databasePath:f.db.path,kind:'entries',options:{}}),error=>error.statusCode===503);
    Atomics.store(flags,1,1);Atomics.notify(flags,1);assert.deepEqual(await first,expected);assert.deepEqual(await second,[]);await drain;
  }finally{Atomics.store(flags,1,1);Atomics.notify(flags,1);await reader.stop();f.close();}
});

test('list, search and smart folder APIs use only the worker, retain validation and auth',async()=>{
  const f=fixture(),folder={id:'local-search'},expected=JSON.parse(JSON.stringify(f.db.entries({query:'common',listOnly:true})));
  f.db.db.prepare('INSERT INTO smart_folders VALUES (?,?,?,?,?,?)').run(folder.id,'Local search','common',0,'2026','2026');
  f.db.entries=()=>{throw Error('main-thread article list query forbidden');};
  const service=createService(f.db,'token'),request=(method,url,payload,token='token')=>service.app.inject({method,url,payload,headers:{'x-rivu-token':token}});
  try{
    for(const url of ['/api/entries?q=common','/api/search?q=common',`/api/smart-folders/${folder.id}/entries`]){const response=await request('GET',url);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),expected);}
    const preview=await request('POST','/api/smart-folders/preview',{query:'common'});assert.equal(preview.statusCode,200,preview.body);assert.deepEqual(preview.json().sample,expected.slice(0,20));assert.equal(preview.json().hasMore,true);
    assert.equal((await request('GET','/api/entries?limit=501')).statusCode,400);
    assert.equal((await request('GET','/api/entries?beforeTime=2026&beforeId=invalid')).statusCode,400);
    assert.equal((await request('GET','/api/smart-folders/missing/entries')).statusCode,404);
    assert.equal((await request('POST','/api/smart-folders/preview',{query:'after:invalid'})).statusCode,400);
    assert.equal((await request('GET','/api/entries',undefined,'wrong')).statusCode,401);
  }finally{await service.stop();f.close();}
});

test('held smart preview releases its main lease so Feed Worker commits and other APIs respond',async()=>{
  const f=fixture(),custom=join(f.directory,'held-preview.cjs');
  writeFileSync(custom,`const {readEntrySnapshot}=require(${JSON.stringify(modulePath)});exports.readEntrySnapshot=input=>readEntrySnapshot(input,()=>{if(input.kind==='smart_preview'){const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(f.directory,'ready'))},'ready');while(!fs.existsSync(${JSON.stringify(join(f.directory,'release'))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});`);
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>Fixture</title>'+Array.from({length:80},(_,i)=>`<item><guid>new-${i}</guid><title>Fresh ${i}</title><description>fixture</description></item>`).join('')+'</channel></rss>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const remote=f.db.addFeed({title:'Fixture',url:`http://127.0.0.1:${server.address().port}/feed`,allowPrivate:true});
  const service=createService(f.db,'token',...Array(14).fill(undefined),worker,custom),request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
  let held;
  try{
    const {existsSync}=await import('node:fs');held=request('POST','/api/smart-folders/preview',{query:'common'});await until(()=>existsSync(join(f.directory,'ready')));
    assert.equal((await request('GET','/api/categories')).statusCode,200);
    const refresh=await Promise.race([request('POST',`/api/feeds/${remote.id}/refresh`),delay(10000).then(()=>{throw Error('Feed commit blocked by read preview');})]);
    assert.equal(refresh.statusCode,200,refresh.body);assert.equal(refresh.json().added,80);
    writeFileSync(join(f.directory,'release'),'release');assert.equal((await held).statusCode,200);
  }finally{writeFileSync(join(f.directory,'release'),'release');await held?.catch(()=>{});await service.stop();await new Promise(resolve=>server.close(resolve));f.close();}
});
