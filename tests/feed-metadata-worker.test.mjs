import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
const require=createRequire(import.meta.url),{readEntrySnapshot}=require('../dist-server/entry-read-task.cjs');
const worker=resolve('dist-server/entry-read-worker.cjs'),task=resolve('dist-server/entry-read-task.cjs');
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-feed-metadata-')),db=new RivuDatabase(join(directory,'rivu.db'));return {directory,db,close(){db.close();const path=relative(resolve(tmpdir()),resolve(directory));assert.ok(path.startsWith('rivu-feed-metadata-')&&!path.startsWith('..')&&!isAbsolute(path));rmSync(directory,{recursive:true,force:true});}};}
const clean=value=>JSON.parse(JSON.stringify(value));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'snapshot did not start');await delay(10);}}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('metadata read retained main write permit')),10000))]);}finally{clearTimeout(timer);}}
test('metadata snapshot preserves columns, ordering, rule visibility, health and icon fallback without writes',()=>{
  const f=fixture();
  try{
    const a=f.db.addFeed({title:'Z source',url:'https://example.invalid/z',icon:'data:image/png;base64,YWJj'}),b=f.db.addFeed({title:'a source',url:'https://example.invalid/a'});
    f.db.addEntries(a.id,Array.from({length:8},(_,i)=>({title:`Entry ${i}`,hash:`entry-${i}`})));
    const entries=f.db.entries({feedId:a.id});f.db.updateEntry(entries[0].id,{read:true});
    f.db.setFilterDecision(entries[1].id,{decision:'mute',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:entries[1].hash});
    f.db.setFilterDecision(entries[2].id,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:entries[2].hash});
    f.db.db.prepare('UPDATE feeds SET failure_count=5 WHERE id=?').run(a.id);f.db.updateFeed(b.id,{enabled:false});
    const input={databasePath:f.db.path,kind:'feed_metadata'};
    assert.deepEqual(clean(readEntrySnapshot(input)),clean(f.db.feeds(true)));
    f.db.db.prepare('DELETE FROM feed_icon_keys WHERE feed_id=?').run(a.id);
    const missing=readEntrySnapshot(input).find(row=>row.id===a.id);assert.match(missing.iconKey,/^[a-f0-9]{64}$/);
    assert.equal(f.db.db.prepare('SELECT count(*) n FROM feed_icon_keys WHERE feed_id=?').get(a.id).n,0,'readonly worker does not persist derived cache');
    assert.deepEqual(clean(readEntrySnapshot(input)),clean(f.db.feeds(true)));
    f.db.db.prepare("INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,'invalid') ON CONFLICT(feed_id) DO UPDATE SET icon_key=excluded.icon_key").run(a.id);
    assert.equal(readEntrySnapshot(input).find(row=>row.id===a.id).iconKey,missing.iconKey);
    assert.equal(f.db.db.prepare('SELECT icon_key FROM feed_icon_keys WHERE feed_id=?').get(a.id).icon_key,'invalid');
  }finally{f.close();}
});
test('metadata service pauses its permit, pins complete metadata to one snapshot and drains accepted reads',async()=>{
  const f=fixture(),custom=join(f.directory,'metadata-task.cjs');let server,service,pending,stopping;
  try{
    server=createServer((_req,res)=>{res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'Feed',items:Array.from({length:80},(_,i)=>({id:String(i),title:`Article ${i}`,content_text:'body'}))}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const feed=f.db.addFeed({title:'Before',url:`http://127.0.0.1:${server.address().port}/feed`,allowPrivate:true});
    const marker=join(f.directory,'ready'),release=join(f.directory,'release');
    writeFileSync(custom,`const fs=require('node:fs'),{readEntrySnapshot}=require(${JSON.stringify(task)});exports.readEntrySnapshot=input=>readEntrySnapshot(input,()=>{if(input.kind==='feed_metadata'){fs.writeFileSync(${JSON.stringify(marker)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});`);
    const args=Array(18).fill(undefined);args[0]=f.db;args[1]='token';args[16]=worker;args[17]=custom;service=createService(...args);
    f.db.feeds=()=>{throw Error('main metadata path must not run');};
    const request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
    pending=request('GET','/api/feeds?icons=metadata');await until(()=>require('node:fs').existsSync(marker));
    const refreshed=await bounded(request('POST',`/api/feeds/${feed.id}/refresh`,{}));assert.equal(refreshed.statusCode,200,refreshed.body);assert.equal(refreshed.json().added,80);
    await service.withDatabaseAccess(()=>f.db.updateFeed(feed.id,{title:'After'}));
    let ended=false;stopping=service.stop().then(()=>ended=true);await delay(30);assert.equal(ended,false);
    writeFileSync(release,'done');const result=await pending;assert.equal(result.statusCode,200,result.body);assert.equal(result.json()[0].title,'Before');assert.equal(result.json()[0].unread_count,0);await stopping;
  }finally{writeFileSync(join(f.directory,'release'),'done');await Promise.allSettled([pending,stopping].filter(Boolean));await service?.stop();if(server)await new Promise(r=>server.close(r));f.close();}
});
