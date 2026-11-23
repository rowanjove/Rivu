import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RivuDatabase} from '../dist-server/database.cjs';
import {FeedWriter} from '../dist-server/feed-writer.js';
import {createService} from '../dist-server/service.js';
const worker=resolve('dist-server/feed-write-worker.cjs'),task=resolve('dist-server/feed-write-task.cjs');
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-bulk-worker-')),db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'本地来源',url:'https://example.invalid/feed',fetchInterval:0});db.addEntries(feed.id,Array.from({length:8},(_,i)=>({title:`文章${i}`,content:`内容${i}`,hash:`fixture-${i}`})));return {directory,db,feed,ids:db.entries().map(e=>e.id),close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
const request=(s,method,url,payload)=>s.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
const mark=(s,scope)=>request(s,'POST','/api/entries/mark-read',scope);
const undo=(s,token)=>request(s,'POST','/api/entries/mark-read/undo',{token});

test('bulk worker keeps membership local and atomically rolls back receipt failures',async()=>{
 const f=fixture(),writer=new FeedWriter(worker),sessionId=randomUUID(),input={kind:'bulk_read',databasePath:f.db.path,sessionId,scope:{feedId:f.feed.id},token:randomUUID()};
 try{
  f.db.db.exec("CREATE TRIGGER bulk_failure BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'bulk-read-receipt:%' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  await assert.rejects(writer.writeBulkRead(input),/receipt failure/);assert.equal(f.db.entries({view:'unread'}).length,8);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM app_meta WHERE key LIKE 'bulk-read-%'").get().n,0);
  f.db.db.exec('DROP TRIGGER bulk_failure');const result=await writer.writeBulkRead(input);
  assert.equal(result.changed,8);assert.equal(result.undoToken,input.token);assert.deepEqual(Object.keys(result).sort(),['added','changed','expiresAt','total','undoToken']);
  assert.equal(f.db.feeds()[0].unread_count,0);
  const reverted=await writer.writeBulkRead({kind:'bulk_read_undo',databasePath:f.db.path,sessionId,token:result.undoToken,invalidated:[f.ids[0]]});assert.equal(reverted.changed,7);assert.equal(f.db.feeds()[0].unread_count,7);
  await assert.rejects(writer.writeBulkRead({kind:'bulk_read_undo',databasePath:f.db.path,sessionId,token:result.undoToken,invalidated:[]}),/失效/);
 }finally{await writer.stop();f.close();}
});

test('bulk API runs off main and replaces undo while preserving subsequent manual choices',async()=>{
 const f=fixture(),s=createService(f.db,'token');
 try{
  f.db.markRead=()=>{throw Error('main mark forbidden');};f.db.undoMarkRead=()=>{throw Error('main undo forbidden');};
  const first=await mark(s,{ids:[f.ids[0],f.ids[0],f.ids[1]]});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().changed,2);
  await request(s,'PATCH',`/api/entries/${f.ids[0]}`,{read:true});await request(s,'PATCH',`/api/entries/${f.ids[1]}`,{read:false});
  assert.equal((await undo(s,first.json().undoToken)).json().changed,0);assert.equal(f.db.entryState(f.ids[0]).read,1);assert.equal(f.db.entryState(f.ids[1]).read,0);
  const second=await mark(s,{feedId:f.feed.id});assert.equal(second.json().changed,7);
  assert.equal((await mark(s,{feedId:f.feed.id})).json().undoToken,null);assert.equal((await undo(s,second.json().undoToken)).statusCode,404);
  assert.equal((await mark(s,{ids:[]})).statusCode,400);assert.equal((await s.app.inject({method:'POST',url:'/api/entries/mark-read',payload:{view:'all'}})).statusCode,401);
 }finally{await s.stop();assert.equal(f.db.db.prepare("SELECT count(*) n FROM app_meta WHERE key LIKE 'bulk-read-%'").get().n,0);f.close();}
});

test('lost committed bulk reply recovers small receipt without replay and remains undoable',async()=>{
 const f=fixture(),custom=join(f.directory,'lost.cjs');
 writeFileSync(custom,`const {parentPort}=require('node:worker_threads'),task=require(${JSON.stringify(task)});parentPort.on('message',input=>{const result=task.writeBulkRead(input);if(input.kind==='bulk_read_cleanup')parentPort.postMessage({result});else process.exit(0);});`);
 const s=createService(f.db,'token',...Array(6).fill(undefined),custom);
 try{const first=await mark(s,{feedId:f.feed.id});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().changed,8);assert.equal((await undo(s,first.json().undoToken)).json().changed,8);assert.equal(f.db.feeds()[0].unread_count,8);}finally{await s.stop();f.close();}
});

test('bulk exit before commit reports uncertainty without replay',async()=>{
 const f=fixture(),custom=join(f.directory,'empty.cjs');writeFileSync(custom,"const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>process.exit(0));");const s=createService(f.db,'token',...Array(6).fill(undefined),custom);
 try{const result=await mark(s,{feedId:f.feed.id});assert.equal(result.statusCode,503,result.body);assert.match(result.json().error,/待核验/);assert.equal(f.db.feeds()[0].unread_count,8);}finally{await s.stop();f.close();}
});

test('held bulk writer serves metadata, detail and lists while queuing mutations and draining shutdown',async()=>{
 const f=fixture(),custom=join(f.directory,'held.cjs'),ready=join(f.directory,'ready'),release=join(f.directory,'release');
 writeFileSync(custom,`const fs=require('node:fs'),task=require(${JSON.stringify(task)});Object.assign(exports,task);exports.writeBulkRead=input=>{const result=task.writeBulkRead(input);if(input.kind==='bulk_read'){fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return result;};`);
 const s=createService(f.db,'token',...Array(6).fill(undefined),worker,custom);let bulk,mutation,stopping;
 try{
  bulk=mark(s,{feedId:f.feed.id}).then(r=>r);const end=Date.now()+10000;while(!existsSync(ready)){assert.ok(Date.now()<end,'worker readiness deadline');await new Promise(r=>setTimeout(r,10));}
  let mutationDone=false;mutation=request(s,'PATCH',`/api/feeds/${f.feed.id}`,{title:'变更来源'}).then(r=>{mutationDone=true;return r;});
  for(const url of ['/health','/api/feeds?icons=metadata','/api/entries',`/api/entries/${f.ids[0]}`]){const r=await request(s,'GET',url);assert.equal(r.statusCode,200,r.body.slice(0,100));}assert.equal(mutationDone,false);
  let stopped=false;stopping=s.stop().then(()=>{stopped=true;});await new Promise(r=>setTimeout(r,25));assert.equal(stopped,false);
  writeFileSync(release,'release');assert.equal((await bulk).json().changed,8);assert.equal((await mutation).statusCode,200);await stopping;
 }finally{writeFileSync(release,'release');await Promise.allSettled([bulk,mutation]);await(stopping||s.stop());f.close();}
});

test('bulk undo membership is isolated by service session',async()=>{
 const f=fixture(),writer=new FeedWriter(worker),sessionId=randomUUID(),other=randomUUID();
 try{const result=await writer.writeBulkRead({kind:'bulk_read',databasePath:f.db.path,sessionId,scope:{view:'all'},token:randomUUID()});await assert.rejects(writer.writeBulkRead({kind:'bulk_read_undo',databasePath:f.db.path,sessionId:other,token:result.undoToken,invalidated:[]}),/失效/);assert.equal(f.db.feeds()[0].unread_count,0);await writer.writeBulkRead({kind:'bulk_read_cleanup',databasePath:f.db.path,sessionId});assert.equal(f.db.db.prepare("SELECT count(*) n FROM app_meta WHERE key LIKE 'bulk-read-%'").get().n,0);}finally{await writer.stop();f.close();}
});
