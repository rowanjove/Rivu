import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createService} from '../dist-server/service.js';
import {FeedWriter} from '../dist-server/feed-writer.js';
import {validateUnreadCounts} from '../dist-server/unread-counts.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const {writeFeedCategory}=require('../dist-server/feed-write-task.cjs');
const modulePath=resolve('dist-server/feed-write-task.cjs'),key='feed-category-write';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-category-worker-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path);
 const a=db.addCategory('A'),b=db.addCategory('B'),feeds=[0,1].map(i=>db.addFeed({title:'来源'+i,url:'https://example.invalid/category-worker/'+i,categoryId:a.id,fetchInterval:0}));
 for(const feed of feeds)db.addEntries(feed.id,[{title:'保留正文',content:'<p>原始😀\u0000</p>',hash:'worker-body',publishedAt:'2025-01-01'}]);
 return {directory,path,db,a,b,feeds,change:{ids:feeds.map(feed=>feed.id),action:'category',categoryId:b.id},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const post=(service,change)=>service.app.inject({method:'POST',url:'/api/feeds/bulk',headers:{'x-rivu-token':'category-token'},payload:change});
const openService=(f,workerPath)=>createService(f.db,'category-token',undefined,undefined,undefined,undefined,undefined,undefined,workerPath,modulePath);
const categories=f=>f.db.db.prepare('SELECT id,category_id FROM feeds ORDER BY id').all();
async function waitForFile(path){const end=Date.now()+5000;while(!existsSync(path)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(existsSync(path),'worker reached gate');}

test('category worker commits metadata and a bounded receipt together, and rolls both back on counter or receipt failure',()=>{
 const f=fixture();try{
  const before=categories(f),articles=f.db.db.prepare('SELECT *,hex(CAST(content AS BLOB)) raw FROM entries ORDER BY id').all();
  f.db.db.exec("CREATE TRIGGER reject_category AFTER INSERT ON rivu_category_timeline_bucket_counts BEGIN SELECT RAISE(ABORT,'category failure');END");
  assert.throws(()=>writeFeedCategory({kind:'feed_category',databasePath:f.path,change:f.change,operationId:'counter-failure'}),/category failure/);
  assert.deepEqual(categories(f),before);assert.equal(f.db.db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key),undefined);validateUnreadCounts(f.db.db);
  f.db.db.exec('DROP TRIGGER reject_category');
  f.db.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON app_meta WHEN NEW.key='feed-category-write' BEGIN SELECT RAISE(ABORT,'receipt failure');END");
  assert.throws(()=>writeFeedCategory({kind:'feed_category',databasePath:f.path,change:f.change,operationId:'receipt-failure'}),/receipt failure/);
  assert.deepEqual(categories(f),before);validateUnreadCounts(f.db.db);f.db.db.exec('DROP TRIGGER reject_receipt');
  assert.deepEqual(writeFeedCategory({kind:'feed_category',databasePath:f.path,change:f.change,operationId:'committed'}),{added:0,total:2});
  assert.ok(categories(f).every(row=>row.category_id===f.b.id));validateUnreadCounts(f.db.db);
  assert.deepEqual(JSON.parse(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key).value),{operationId:'committed',result:{added:0,total:2}});
  assert.deepEqual(f.db.db.prepare('SELECT *,hex(CAST(content AS BLOB)) raw FROM entries ORDER BY id').all(),articles);
  writeFeedCategory({kind:'feed_category',databasePath:f.path,change:{...f.change,categoryId:null},operationId:'second'});
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM app_meta WHERE key=?').get(key).n,1);assert.ok(categories(f).every(row=>row.category_id===null));validateUnreadCounts(f.db.db);
 }finally{f.close();}
});

test('real category worker queue retains order and the bulk API retains validation and response contracts',async()=>{
 const f=fixture(),writer=new FeedWriter(resolve('dist-server/feed-write-worker.cjs'),modulePath);let service;
 try{
  const move=writer.writeFeedCategory({kind:'feed_category',databasePath:f.path,change:f.change});
  const clear=writer.writeFeedCategory({kind:'feed_category',databasePath:f.path,change:{...f.change,categoryId:null}});
  assert.deepEqual(await move,{added:0,total:2});assert.deepEqual(await clear,{added:0,total:2});assert.ok(categories(f).every(row=>row.category_id===null));
  await writer.stop();service=openService(f,undefined);
  for(const change of [{...f.change,ids:[f.feeds[0].id,f.feeds[0].id]},{...f.change,categoryId:3},{...f.change,ids:[]}])assert.equal((await post(service,change)).statusCode,400);
  assert.equal((await post(service,{...f.change,categoryId:'00000000-0000-0000-0000-000000000000'})).statusCode,404);
  const result=await post(service,f.change);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{changed:2,action:'category'});validateUnreadCounts(f.db.db);
 }finally{await service?.stop();await writer.stop();f.close();}
});

test('real queued worker rechecks selections and categories deleted after dispatch without partial changes',async()=>{
 const f=fixture(),gate=join(f.directory,'queue-release'),ready=join(f.directory,'queue-ready');let writer;const jobs=[];
 try{
  const worker=join(f.directory,'queued.cjs');
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs');const {writeFeedCategory}=require(workerData.modulePath);parentPort.on('message',input=>{fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gate)}))return;clearInterval(timer);try{parentPort.postMessage({result:writeFeedCategory(input)});}catch(error){parentPort.postMessage({error:error.message,statusCode:error.statusCode});}},10);});`);
  writer=new FeedWriter(worker,modulePath);
  const enqueue=change=>{const job=writer.writeFeedCategory({kind:'feed_category',databasePath:f.path,change}).then(result=>({result}),error=>({error}));jobs.push(job);return job;};
  const first=enqueue({...f.change,ids:[f.feeds[0].id],categoryId:f.a.id});await waitForFile(ready);
  const deletedFeed=enqueue(f.change),deletedCategory=enqueue({...f.change,ids:[f.feeds[0].id]});
  f.db.deleteFeed(f.feeds[1].id);f.db.deleteCategory(f.b.id);writeFileSync(gate,'release');
  assert.deepEqual((await first).result,{added:0,total:1});assert.equal((await deletedFeed).error?.statusCode,409);assert.equal((await deletedCategory).error?.statusCode,404);
  assert.equal(f.db.feed(f.feeds[0].id).category_id,f.a.id);validateUnreadCounts(f.db.db);
  assert.equal(JSON.parse(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key).value).result.total,1,'rejected queued jobs must not replace the first receipt');
 }finally{writeFileSync(gate,'release');await Promise.all(jobs);await writer?.stop();f.close();}
});

for(const failure of ['exit','bad-reply'])test('committed category '+failure+' is reconciled without a second mutation',async()=>{
 const f=fixture();let service;
 try{
  f.db.db.exec('CREATE TABLE category_write_audit(id TEXT);CREATE TRIGGER category_audit AFTER UPDATE OF category_id ON feeds BEGIN INSERT INTO category_write_audit VALUES(NEW.id);END');
  const worker=join(f.directory,'lost-reply.cjs');
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads');const {writeFeedCategory}=require(workerData.modulePath);parentPort.on('message',input=>{writeFeedCategory(input);${failure==='exit'?'process.exit(17);':"parentPort.postMessage({result:{added:0,total:9999}});"}});`);
  service=openService(f,worker);const response=await post(service,f.change);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{changed:2,action:'category'});
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM category_write_audit').get().n,2);assert.ok(categories(f).every(row=>row.category_id===f.b.id));validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

test('uncommitted category worker exit never adopts a stale receipt or repeats the write',async()=>{
 const f=fixture();let service;
 try{
  const before=categories(f);f.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run(key,JSON.stringify({operationId:'previous-job',result:{added:0,total:2}}));
  const worker=join(f.directory,'not-committed.cjs');writeFileSync(worker,"require('node:worker_threads').parentPort.on('message',()=>process.exit(18));");
  service=openService(f,worker);const response=await post(service,f.change);assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/待核验/);assert.deepEqual(categories(f),before);validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

test('category write releases the main lease so reader workers complete while its SQLite transaction is uncommitted',async()=>{
 const f=fixture();let service,pending;
 const gate=join(f.directory,'release'),ready=join(f.directory,'ready');
 try{
  const worker=join(f.directory,'gated.cjs');
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');const {writeFeedCategory}=require(workerData.modulePath);const exec=DatabaseSync.prototype.exec,wait=new Int32Array(new SharedArrayBuffer(4));let operationId;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&operationId){const row=this.prepare("SELECT value FROM app_meta WHERE key='feed-category-write'").get();if(row&&JSON.parse(row.value).operationId===operationId){fs.writeFileSync(${JSON.stringify(ready)},'transaction-ready');const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>=end)throw Error('category test gate expired');Atomics.wait(wait,0,0,10);}}}return exec.call(this,sql);};parentPort.on('message',input=>{operationId=input.operationId;parentPort.postMessage({result:writeFeedCategory(input)});});`);
  service=openService(f,worker);pending=post(service,f.change).then(value=>value);await waitForFile(ready);
  const reads=Promise.all(['/health','/api/feeds?icons=metadata','/api/entries?offset=1'].map(url=>service.app.inject({method:'GET',url,headers:{'x-rivu-token':'category-token'}})));
  let timer;try{for(const response of await Promise.race([reads,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('readers waited for category writer')),5000);})]))assert.equal(response.statusCode,200,response.body);}finally{clearTimeout(timer);}
  assert.ok(categories(f).every(row=>row.category_id===f.a.id));writeFileSync(gate,'release');const response=await pending;assert.equal(response.statusCode,200,response.body);assert.ok(categories(f).every(row=>row.category_id===f.b.id));validateUnreadCounts(f.db.db);
 }finally{writeFileSync(gate,'release');await pending;await service?.stop();f.close();}
});
