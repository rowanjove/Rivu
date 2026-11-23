import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createService} from '../dist-server/service.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action){const deadline=Date.now()+20000;while(!action()){assert.ok(Date.now()<deadline,'等待离线fixture超时');await delay(10);}}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
async function fixture({holdArticle=false,missing=false,lock=false,exit=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'rivu-offline-write-')),worker=join(directory,'worker.cjs'),counter=join(directory,'writes'),marker=join(directory,'locked');
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads');${lock?`const {DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.function;let marked=false;DatabaseSync.prototype.function=function(name,options,callback){if(name!=='rivu_pairs')return original.apply(this,arguments);return original.call(this,name,options,(...args)=>{if(!marked){marked=true;require('node:fs').writeFileSync(${JSON.stringify(marker)},'locked');const end=Date.now()+350;while(Date.now()<end){}}return callback(...args);});};`:''}const {writeFullTextBatch}=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind?.startsWith('bulk_read')){parentPort.postMessage({result:require(workerData.modulePath).writeBulkRead(input)});return;}if(input.kind==='entry_state'){const result=require(workerData.modulePath).writeEntryState(input);parentPort.postMessage({result},result.json?[result.json]:[]);return;}try{const result=writeFullTextBatch(input);require('node:fs').appendFileSync(${JSON.stringify(counter)},'x');${exit?'process.exit(0);':'parentPort.postMessage({result});'}}catch(error){parentPort.postMessage({error:error.message,statusCode:error.statusCode});}});`);
  let releaseArticle,articleRequests=0,imageRequests=0,articleStarted=false,missingImage=missing;const gate=new Promise(resolve=>releaseArticle=resolve);
  const origin=createServer(async(req,res)=>{
    if(req.url==='/article'){articleRequests++;articleStarted=true;if(holdArticle)await gate;res.setHeader('content-type','text/html');res.end(`<html><body><article><h1>离线文章</h1><p>${'星际探索离线内容完整保留。'.repeat(40)}</p><p><img src="/one.png"><img src="/two.png"></p></article></body></html>`);return;}
    if(['/one.png','/two.png'].includes(req.url)){imageRequests++;if(req.url==='/two.png'&&missingImage){res.statusCode=404;res.end();return;}res.setHeader('content-type','image/png');res.end(png);return;}
    res.statusCode=404;res.end();
  });
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${origin.address().port}`,db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'本地源',url:base+'/feed',allowPrivate:true});db.addEntries(feed.id,[{title:'文章',url:base+'/article',description:'原始摘要',hash:'one'}]);const id=db.entries()[0].id;
  const service=createService(db,'token',undefined,directory,undefined,undefined,undefined,undefined,worker,resolve('dist-server/feed-write-task.cjs'));
  const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'token'},payload});
  assert.equal((await request('POST','/api/rules',{name:'离线全文规则',conditions:{bodyKeyword:'星际探索'},action:{type:'save'}})).statusCode,201);
  return {directory,db,origin,service,base,id,marker,request,releaseArticle,started:()=>articleStarted,counts:()=>({articles:articleRequests,images:imageRequests,writes:existsSync(counter)?readFileSync(counter,'utf8').length:0}),setMissing:value=>missingImage=value};
}
async function cleanup(f){f.releaseArticle();await f.service.stop();f.db.close();await new Promise(resolve=>f.origin.close(resolve));rmSync(f.directory,{recursive:true,force:true});}

test('duplicate offline requests and image upgrades release main leases, share one full-text commit, and recover committed exit',async()=>{
  const f=await fixture({holdArticle:true,lock:true,exit:true});
  try{
    const path=`/api/entries/${f.id}/offline`,first=f.request('POST',path,{includeImages:false});await until(f.started);
    const duplicate=f.request('POST',path,{includeImages:false}),upgrade=f.request('POST',path,{includeImages:true}),upgradedDuplicate=f.request('POST',path,{includeImages:true});
    assert.equal((await f.request('GET',path)).json().status,'running');f.releaseArticle();await until(()=>existsSync(f.marker));
    assert.equal((await f.request('GET','/health')).statusCode,200);assert.equal((await f.request('GET',`/api/entries/${f.id}`)).json().full_content,null);
    let changed=false;const patch=f.request('PATCH',`/api/entries/${f.id}`,{read:true,starred:true}).then(result=>{changed=true;return result;});const status=f.request('GET',path);await delay(20);assert.equal(changed,false);
    const replies=await Promise.all([first,duplicate,upgrade,upgradedDuplicate,patch,status]);for(const reply of replies)assert.equal(reply.statusCode,200,reply.body);
    assert.equal(replies[0].json().status,'ready');for(const reply of replies.slice(2,4)){assert.equal(reply.json().status,'ready');assert.equal(reply.json().requestedImages,true);assert.deepEqual(reply.json().images,{cached:2,total:2});}
    assert.deepEqual(f.counts(),{articles:1,images:2,writes:1});assert.equal(f.db.entry(f.id).read,1);assert.equal(f.db.entry(f.id).starred,1);assert.equal(f.db.entry(f.id).saved,1);assert.equal(f.db.entry(f.id).rule_saved,1);
    assert.equal(f.db.entries({query:'星际探索'}).length,1);assert.ok(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`full-text-write:${f.id}`));
  }finally{await cleanup(f);}
});

test('offline partial image failure retries missing images without fetching or committing full text again',async()=>{
  const f=await fixture({missing:true});
  try{
    const path=`/api/entries/${f.id}/offline`,first=await f.request('POST',path,{includeImages:true});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().status,'partial');assert.deepEqual(first.json().images,{cached:1,total:2});assert.match(first.json().lastError,/图片/);
    const receipt=f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`full-text-write:${f.id}`).value;f.setMissing(false);
    const retry=await f.request('POST',path,{includeImages:true});assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().status,'ready');assert.equal(retry.json().lastError,null);assert.deepEqual(retry.json().images,{cached:2,total:2});assert.deepEqual(f.counts(),{articles:1,images:3,writes:1});assert.equal(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`full-text-write:${f.id}`).value,receipt);
  }finally{await cleanup(f);}
});

test('shutdown drains accepted offline saves and refuses new requests before closing workers',async()=>{
  const f=await fixture({holdArticle:true});
  try{
    const path=`/api/entries/${f.id}/offline`,accepted=f.request('POST',path,{includeImages:true});await until(f.started);
    let stopped=false;const stopping=f.service.stop().then(()=>{stopped=true;});
    const refused=await f.request('POST',path,{includeImages:false});assert.equal(refused.statusCode,503,refused.body);
    await delay(20);assert.equal(stopped,false);f.releaseArticle();
    const reply=await accepted;assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().status,'ready');
    await stopping;assert.equal(stopped,true);assert.deepEqual(f.counts(),{articles:1,images:2,writes:1});
  }finally{await cleanup(f);}
});
