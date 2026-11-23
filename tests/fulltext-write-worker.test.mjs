import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createService} from '../dist-server/service.js';
import {FeedWriter} from '../dist-server/feed-writer.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action){const deadline=Date.now()+15000;while(!action()){assert.ok(Date.now()<deadline,'全文写事务未开始');await delay(10);}}
async function fixture(worker){
  const directory=mkdtempSync(join(tmpdir(),'rivu-fulltext-write-')),db=new RivuDatabase(join(directory,'rivu.db'));
  const origin=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<html><head><link rel="canonical" href="/canonical"></head><body><article><h1>全文</h1><p>${'星际探索的独有正文关键词。'.repeat(40)}</p><img src="/cover.png"></article></body></html>`);});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${origin.address().port}`,feed=db.addFeed({title:'源',url:base+'/feed',allowPrivate:true});db.addEntries(feed.id,[{title:'摘要',description:'摘要',url:base+'/article',hash:'one'}]);const id=db.entries()[0].id;db.saveAI(id,'summary','zh-CN','test','model','旧摘要');
  const service=createService(db,'token',undefined,undefined,undefined,undefined,undefined,undefined,worker,resolve('dist-server/feed-write-task.cjs'));
  const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'token'},payload});
  const rule=await request('POST','/api/rules',{name:'全文规则',conditions:{bodyKeyword:'独有正文关键词'},action:{type:'save'}});assert.equal(rule.statusCode,201,rule.body);
  return {directory,db,origin,base,feed,id,service,request};
}
async function cleanup(f){await f.service.stop();f.db.close();await new Promise(resolve=>f.origin.close(resolve));rmSync(f.directory,{recursive:true,force:true});}

test('full-text write lock preserves WAL reads, queues manual changes, and recovers a committed result after exit without reply',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-fulltext-write-bootstrap-')),worker=join(directory,'worker.cjs'),marker=join(directory,'locked');
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.function;let marked=false;DatabaseSync.prototype.function=function(name,options,callback){if(name!=='rivu_pairs')return original.apply(this,arguments);return original.call(this,name,options,(...args)=>{if(!marked){marked=true;require('node:fs').writeFileSync(${JSON.stringify(marker)},'locked');const end=Date.now()+350;while(Date.now()<end){}}return callback(...args);});};const {writeFullTextBatch}=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind?.startsWith('bulk_read')){parentPort.postMessage({result:require(workerData.modulePath).writeBulkRead(input)});return;}if(input.kind==='entry_state'){const result=require(workerData.modulePath).writeEntryState(input);parentPort.postMessage({result},result.json?[result.json]:[]);return;}writeFullTextBatch(input);process.exit(0);});`);
  const f=await fixture(worker);
  try{
    const full=f.request('POST',`/api/entries/${f.id}/full-text`);await Promise.race([until(()=>existsSync(marker)),full.then(result=>{if(!existsSync(marker))throw Error(result.body);})]);
    assert.equal((await f.request('GET','/health')).statusCode,200);assert.equal((await f.request('GET',`/api/entries/${f.id}`)).json().full_content,null);
    let changed=false;const patch=f.request('PATCH',`/api/entries/${f.id}`,{read:true,saved:true}).then(result=>{changed=true;return result;});await delay(20);assert.equal(changed,false);
    const result=await full;assert.equal(result.statusCode,200,result.body);assert.equal((await patch).statusCode,200);
    const entry=f.db.entry(f.id);assert.match(entry.full_content,/星际探索/);assert.equal(entry.read,1);assert.equal(entry.saved,1);assert.equal(entry.rule_saved,1);assert.equal(f.db.entries({query:'星际探索'}).length,1);assert.equal(f.db.aiResult(f.id,'summary','zh-CN'),undefined);
    const receipt=JSON.parse(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`full-text-write:${f.id}`).value);assert.match(receipt.operationId,/^[0-9a-f-]{36}$/);assert.deepEqual(receipt.result,{added:0,total:1});
  }finally{await cleanup(f);rmSync(directory,{recursive:true,force:true});}
});

test('full-text writer refuses stale source snapshots and rolls back body, media, FTS, canonical, AI and receipt when rules fail',async()=>{
  const f=await fixture(),writer=new FeedWriter(resolve('dist-server/feed-write-worker.cjs'));
  try{
    const before=f.db.entry(f.id),ai=f.db.aiResult(f.id,'summary','zh-CN'),identities=f.db.db.prepare('SELECT kind,value FROM entry_identities WHERE entry_id=? ORDER BY kind,value').all(f.id);f.db.updateFeed(f.feed.id,{allowPrivate:false});
    await assert.rejects(writer.writeFullText({kind:'full_text',databasePath:f.db.path,entryId:f.id,expected:before,html:'<p>新正文</p>',canonicalUrl:f.base+'/canonical'}),error=>error.statusCode===409);assert.equal(f.db.entry(f.id).full_content,null);
    f.db.updateFeed(f.feed.id,{allowPrivate:true});f.db.db.exec("CREATE TRIGGER deny_fulltext_rule BEFORE INSERT ON rule_matches BEGIN SELECT RAISE(ABORT,'全文规则故障'); END;");
    const response=await f.request('POST',`/api/entries/${f.id}/full-text`);assert.equal(response.statusCode,500,response.body);assert.match(response.body,/全文规则故障/);
    assert.deepEqual(f.db.entry(f.id),before);assert.deepEqual(f.db.aiResult(f.id,'summary','zh-CN'),ai);assert.equal(f.db.entryMedia(f.id).length,0);assert.equal(f.db.entries({query:'星际探索'}).length,0);assert.deepEqual(f.db.db.prepare('SELECT kind,value FROM entry_identities WHERE entry_id=? ORDER BY kind,value').all(f.id),identities);assert.equal(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`full-text-write:${f.id}`),undefined);
  }finally{await writer.stop();await cleanup(f);}
});
