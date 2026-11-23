import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {FeedWriter} from '../dist-server/feed-writer.js';
import {createService} from '../dist-server/service.js';
const worker=resolve('dist-server/feed-write-worker.cjs'),task=resolve('dist-server/feed-write-task.cjs');
const clean=value=>JSON.parse(JSON.stringify(value));
const decode=result=>JSON.parse(Buffer.from(result.json).toString('utf8'));
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-state-worker-')),db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'来源😀',url:'https://example.invalid/feed',fetchInterval:0});db.addEntries(feed.id,[{title:'状态',content:'state-large-marker'+'中文😀'.repeat(200000),hash:'fixture'}]);return {directory,db,feed,id:db.entries()[0].id,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
const request=(service,method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});

test('state worker returns complete atomic receipts for queued partial updates, rollback and missing entries',async()=>{
 const f=fixture(),writer=new FeedWriter(worker),input={kind:'entry_state',databasePath:f.db.path,entryId:f.id};
 try{
  const before=clean(f.db.entry(f.id));
  const first=writer.writeEntryState({...input,patch:{read:true,starred:true}}),second=writer.writeEntryState({...input,patch:{read:false,saved:true}});
  assert.deepEqual(decode(await first),{...before,read:1,starred:1});
  assert.deepEqual(decode(await second),{...before,read:0,starred:1,saved:1});
  f.db.db.exec("CREATE TRIGGER state_failure BEFORE INSERT ON app_meta WHEN NEW.key LIKE 'entry-state-write:%' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
  await assert.rejects(writer.writeEntryState({...input,patch:{archived:true}}),/receipt failure/);
  assert.equal(f.db.entryState(f.id).archived,0);f.db.db.exec('DROP TRIGGER state_failure');
  assert.deepEqual(await writer.writeEntryState({...input,entryId:'missing',patch:{read:true}}),{added:0,total:0});
  f.db.db.exec('PRAGMA foreign_keys=OFF');f.db.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(f.id);
  assert.deepEqual(await writer.writeEntryState({...input,patch:{read:true}}),{added:0,total:0});
  assert.equal(f.db.db.prepare('SELECT read FROM entries WHERE id=?').get(f.id).read,0);
 }finally{await writer.stop();f.close();}
});

test('state API avoids main body queries/serialization and preserves read undo and authentication',async()=>{
 const f=fixture(),service=createService(f.db,'token'),stringify=JSON.stringify;let count=0;
 try{
  const expected=clean(f.db.entry(f.id));f.db.entry=()=>{throw Error('main body read forbidden');};
  JSON.stringify=function(value,...args){if(value?.content?.includes('state-large-marker'))count++;return stringify.call(this,value,...args);};
  const bulk=await request(service,'POST','/api/entries/mark-read',{feedId:f.feed.id});assert.equal(bulk.statusCode,200,bulk.body);
  const response=await request(service,'PATCH',`/api/entries/${f.id}`,{read:false,saved:true});
  assert.equal(response.statusCode,200,response.body.slice(0,100));assert.deepEqual(response.json(),{...expected,saved:1});assert.equal(count,0);
  const undo=await request(service,'POST','/api/entries/mark-read/undo',{token:bulk.json().undoToken});assert.equal(undo.json().changed,0);
  assert.equal((await request(service,'PATCH','/api/entries/missing',{read:true})).statusCode,404);
  assert.equal((await service.app.inject({method:'PATCH',url:`/api/entries/${f.id}`,payload:{saved:false}})).statusCode,401);
 }finally{JSON.stringify=stringify;await service.stop();f.close();}
});

test('lost post-commit state receipt reports uncertainty without replay and invalidates undo',async()=>{
 const f=fixture(),custom=join(f.directory,'lost.cjs');
 writeFileSync(custom,`const {parentPort}=require('node:worker_threads');const {writeEntryState}=require(${JSON.stringify(task)});parentPort.on('message',input=>{if(input.kind?.startsWith('bulk_read')){parentPort.postMessage({result:require(${JSON.stringify(task)}).writeBulkRead(input)});return;}writeEntryState(input);process.exit(0);});`);
 const service=createService(f.db,'token',...Array(6).fill(undefined),custom),url=`/api/entries/${f.id}`;
 try{
  const bulk=await request(service,'POST','/api/entries/mark-read',{feedId:f.feed.id});
  const response=await request(service,'PATCH',url,{read:true,saved:true});assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/待核验/);
  assert.equal(f.db.entryState(f.id).saved,1);assert.equal(f.db.db.prepare('SELECT count(*) n FROM app_meta WHERE key=?').get(`entry-state-write:${f.id}`).n,1);
  const undo=await request(service,'POST','/api/entries/mark-read/undo',{token:bulk.json().undoToken});assert.equal(undo.json().changed,0);assert.equal(f.db.entryState(f.id).read,1);
  assert.equal((await request(service,'GET',url)).json().saved,1);
 }finally{await service.stop();f.close();}
});

test('held state writer permits health/read requests, blocks competing main writes, and drains on shutdown',async()=>{
 const f=fixture(),custom=join(f.directory,'held.cjs'),ready=join(f.directory,'ready'),release=join(f.directory,'release');
 writeFileSync(custom,`const fs=require('node:fs'),task=require(${JSON.stringify(task)});exports.writeBulkRead=require(${JSON.stringify(task)}).writeBulkRead;exports.writeEntryState=input=>{const result=task.writeEntryState(input);fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return result;};`);
 const service=createService(f.db,'token',...Array(6).fill(undefined),worker,custom);let state,source,stopping;
 try{
  state=request(service,'PATCH',`/api/entries/${f.id}`,{starred:true}).then(r=>r);
  const end=Date.now()+10000;while(!existsSync(ready)){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}
  let sourceDone=false;source=request(service,'PATCH',`/api/feeds/${f.feed.id}`,{title:'后续来源'}).then(r=>{sourceDone=true;return r;});
  assert.equal((await request(service,'GET','/health')).statusCode,200);assert.equal((await request(service,'GET',`/api/entries/${f.id}`)).json().starred,1);assert.equal(sourceDone,false);
  let stopped=false;stopping=service.stop().then(()=>{stopped=true;});await new Promise(r=>setTimeout(r,30));assert.equal(stopped,false);
  writeFileSync(release,'release');const receipt=await state;assert.equal(receipt.statusCode,200);assert.equal(receipt.json().feed_title,'来源😀');await source;await stopping;
 }finally{writeFileSync(release,'release');await Promise.allSettled([state,source]);await (stopping||service.stop());f.close();}
});

test('postMessage synchronous failure after commit is uncertain rather than a definite task error',async()=>{
 const f=fixture(),custom=join(f.directory,'send-failure.cjs');
 writeFileSync(custom,`const {writeEntryState}=require(${JSON.stringify(task)});exports.writeBulkRead=require(${JSON.stringify(task)}).writeBulkRead;exports.writeEntryState=input=>({...writeEntryState(input),uncloneable:()=>{}});`);
 const service=createService(f.db,'token',...Array(6).fill(undefined),worker,custom);
 try{
  const bulk=await request(service,'POST','/api/entries/mark-read',{feedId:f.feed.id});assert.equal(bulk.statusCode,200);
  const response=await request(service,'PATCH',`/api/entries/${f.id}`,{read:true,saved:true});assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/待核验/);
  assert.equal(f.db.entryState(f.id).saved,1);
  assert.equal((await request(service,'POST','/api/entries/mark-read/undo',{token:bulk.json().undoToken})).json().changed,0);
 }finally{await service.stop();f.close();}
});
