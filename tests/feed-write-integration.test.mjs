import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createService} from '../dist-server/service.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+15000;while(!predicate()){assert.ok(Date.now()<deadline,'等待本地fixture超时');await sleep(10);}}
const payload=JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'本地源',items:[{id:'new',title:'新文章',url:'https://example.invalid/new',content_html:'<p>新正文</p>'}]});
async function fixture(handler=(_req,res)=>{res.setHeader('content-type','application/feed+json');res.end(payload);},worker){
  const directory=mkdtempSync(join(tmpdir(),'rivu-write-integration-')),db=new RivuDatabase(join(directory,'rivu.db')),origin=createServer(handler);
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${origin.address().port}/feed`,feed=db.addFeed({title:'旧源',url,allowPrivate:true});
  const service=createService(db,'token',undefined,directory,undefined,undefined,undefined,undefined,worker,resolve('dist-server/feed-write-task.cjs'));
  const request=(method,path,data)=>service.app.inject({method,url:path,headers:{'x-rivu-token':'token'},payload:data});
  return {directory,db,origin,url,feed,service,request};
}
async function cleanup(f){await f.service.stop();f.db.close();await new Promise(resolve=>f.origin.close(resolve));rmSync(f.directory,{recursive:true,force:true});}

test('service keeps WAL reads responsive, queues HTTP/external/cache writers, and recovers committed results after a worker exits without a reply',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-write-bootstrap-')),worker=join(directory,'worker.cjs'),marker=join(directory,'started');
  // Delay inside the FTS SQL callback: BEGIN IMMEDIATE has already acquired the
  // actual SQLite write lock, rather than only waiting outside the transaction.
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.function;let marked=false;DatabaseSync.prototype.function=function(name,options,callback){if(name!=='rivu_pairs')return original.apply(this,arguments);return original.call(this,name,options,(...args)=>{if(!marked){marked=true;require('node:fs').writeFileSync(${JSON.stringify(marker)},'locked');const end=Date.now()+350;while(Date.now()<end){}}return callback(...args);});};const {writeFeedBatch}=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind?.startsWith('bulk_read')){parentPort.postMessage({result:require(workerData.modulePath).writeBulkRead(input)});return;}if(input.kind==='entry_state'){const result=require(workerData.modulePath).writeEntryState(input);parentPort.postMessage({result},result.json?[result.json]:[]);return;}writeFeedBatch(input);process.exit(0);});`);
  const f=await fixture(undefined,worker);
  try{
    f.db.addEntries(f.feed.id,[{guid:'old',title:'旧文章',url:'https://example.invalid/old',content:'<img src="https://example.invalid/old.png">',hash:'old'}]);const old=f.db.entries()[0];
    f.db.saveCachedImage('https://example.invalid/old.png','invalid-name','image/png',1);
    const refresh=f.request('POST',`/api/feeds/${f.feed.id}/refresh`);await Promise.race([until(()=>existsSync(marker)),refresh.then(result=>{if(!existsSync(marker))throw Error(`锁fixture未开始：${result.statusCode} ${result.body}`);})]);
    const read=await f.request('GET',`/api/entries/${old.id}`);assert.equal(read.statusCode,200);assert.equal(read.json().read,0);assert.equal((await f.request('GET','/health')).statusCode,200);
    let changed=false;const patch=f.request('PATCH',`/api/entries/${old.id}`,{read:true}).then(result=>{changed=true;return result;});
    const external=f.service.withDatabaseAccess(()=>f.db.updateEntry(old.id,{saved:true}));
    const offline=f.request('GET',`/api/entries/${old.id}/offline`);await sleep(20);assert.equal(changed,false);
    const result=await refresh;assert.equal(result.statusCode,200,result.body);assert.equal(result.json().added,1);
    assert.equal((await patch).statusCode,200);await external;assert.equal((await offline).statusCode,200);
    assert.equal(f.db.entry(old.id).read,1);assert.equal(f.db.entry(old.id).saved,1);assert.equal(f.db.cachedImage('https://example.invalid/old.png'),undefined);
    assert.equal(f.db.entries().length,2);assert.equal(f.db.feed(f.feed.id).failure_count,0);
    const receipt=JSON.parse(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`feed-write:${f.feed.id}`).value);assert.equal(receipt.result.added,1);assert.ok(receipt.operationId);
  }finally{await cleanup(f);rmSync(directory,{recursive:true,force:true});}
});

test('authorization changes while fetching reject old results without changing the new source health',async()=>{
  let response;const f=await fixture((_req,res)=>{response=res;});
  try{
    const refresh=f.request('POST',`/api/feeds/${f.feed.id}/refresh`);await until(()=>response);
    assert.equal((await f.request('PATCH',`/api/feeds/${f.feed.id}`,{allowPrivate:false})).statusCode,200);
    response.setHeader('content-type','application/feed+json');response.end(payload);
    const result=await refresh;assert.equal(result.statusCode,409,result.body);assert.equal(f.db.entries().length,0);assert.equal(f.db.feed(f.feed.id).failure_count,0);assert.equal(f.db.feed(f.feed.id).last_success_at,null);
  }finally{response?.end();await cleanup(f);}
});

test('new subscription releases its main write lease while awaiting the worker refresh',async()=>{
  const f=await fixture();
  try{
    f.db.deleteFeed(f.feed.id);const result=await f.request('POST','/api/feeds',{url:f.url,allowPrivate:true});assert.equal(result.statusCode,201,result.body);assert.equal(f.db.entries().length,1);
    assert.equal((await f.request('POST','/api/feeds/refresh')).statusCode,200);
  }finally{await cleanup(f);}
});
