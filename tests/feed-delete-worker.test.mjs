import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createService} from '../dist-server/service.js';
import {validateUnreadCounts} from '../dist-server/unread-counts.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const {writeFeedDelete,readFeedDeleteReceipt}=require('../dist-server/feed-write-task.cjs'),key='feed-delete-write',modulePath=resolve('dist-server/feed-write-task.cjs');
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-feed-delete-worker-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),category=db.addCategory('分类');
 const feeds=[0,1,2].map(i=>db.addFeed({title:'来源'+i,url:'https://example.invalid/delete/'+i,categoryId:category.id,fetchInterval:0}));
 for(const feed of feeds)db.addEntries(feed.id,[{title:'正文😀',content:'<p>原文</p>',hash:'one'},{title:'保留',content:'正文二',hash:'two'}]);
 const entry=db.entries({feedId:feeds[0].id})[0],now=new Date().toISOString();
 db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('archive',entry.id,feeds[0].id,'来源0','归档',null,now,now);
 return {directory,path,db,feeds,change:{ids:feeds.slice(0,2).map(f=>f.id),action:'delete',expected:{entriesToDelete:4,archivesPreserved:1}},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const state=f=>({feeds:f.db.db.prepare('SELECT * FROM feeds ORDER BY id').all(),entries:f.db.db.prepare('SELECT * FROM entries ORDER BY id').all(),archives:f.db.db.prepare('SELECT * FROM permanent_archives ORDER BY id').all()});
const input=f=>({kind:'feed_delete',databasePath:f.path,change:f.change,operationId:'delete-operation'});
const receipt=f=>({kind:'feed_delete_receipt',databasePath:f.path,change:f.change,expectedOperationId:'delete-operation'});
const open=(f,worker)=>createService(f.db,'delete-token',undefined,undefined,undefined,undefined,undefined,undefined,worker,modulePath);
const send=(service,f,single=false)=>service.app.inject({method:single?'DELETE':'POST',url:single?'/api/feeds/'+f.feeds[0].id:'/api/feeds/bulk',headers:{'x-rivu-token':'delete-token'},payload:single?{expected:{entriesToDelete:2,archivesPreserved:1}}:f.change});

for(const mode of ['model','fallback','worker'])test(mode+' deletion removes only selected Newsletter cursors and rolls back on cursor cleanup failure',async()=>{
 const f=fixture();let service;
 try{
  const selected=mode==='model'?f.feeds.slice(0,1):f.feeds.slice(0,2),keys=selected.map(feed=>'newsletter_audit:'+feed.id);
  const insert=f.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)');
  for(const feed of f.feeds)insert.run('newsletter_audit:'+feed.id,'private-issue-'+feed.id+'.eml');
  insert.run(keys[0]+':unrelated','retain exact key');insert.run('feed-metadata-write','prior metadata receipt');
  const metadata=()=>f.db.db.prepare('SELECT * FROM app_meta ORDER BY key').all(),before=state(f),prior=metadata();
  f.db.db.exec(`CREATE TRIGGER reject_newsletter_cursor_cleanup BEFORE DELETE ON app_meta WHEN OLD.key='${keys[0]}' BEGIN SELECT RAISE(ABORT,'cursor cleanup failed');END`);
  if(mode!=='model')service=open(f,mode==='worker'?resolve('dist-server/feed-write-worker.cjs'):undefined);
  if(mode==='model')assert.throws(()=>f.db.deleteFeed(f.feeds[0].id),/cursor cleanup failed/);
  else{const response=await send(service,f);assert.equal(response.statusCode,500,response.body);assert.match(response.json().error,/cursor cleanup failed/);}
  assert.deepEqual(state(f),before);assert.deepEqual(metadata(),prior);validateUnreadCounts(f.db.db);
  f.db.db.exec('DROP TRIGGER reject_newsletter_cursor_cleanup');
  if(mode==='model')assert.equal(f.db.deleteFeed(f.feeds[0].id),1);else assert.equal((await send(service,f)).statusCode,200);
  for(const key of keys)assert.equal(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key),undefined);
  assert.equal(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(keys[0]+':unrelated').value,'retain exact key');
  assert.ok(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get('newsletter_audit:'+f.feeds[2].id));
  assert.deepEqual(state(f).archives,before.archives);assert.ok(f.db.feed(f.feeds[2].id));validateUnreadCounts(f.db.db);assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{await service?.stop();f.close();}
});
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('reader or gate timed out')),5000))]);}finally{clearTimeout(timer);}}
async function ready(path){const end=Date.now()+5000;while(!existsSync(path)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(existsSync(path),'transaction gate timed out');}

test('worker deletion preserves independent archives and unrelated articles, with a bounded exact-operation receipt',()=>{
 const f=fixture();try{
  const before=state(f),result=writeFeedDelete(input(f));assert.deepEqual(result,{added:0,total:2});
  assert.deepEqual(state(f).archives,before.archives);assert.deepEqual(state(f).entries,before.entries.filter(row=>row.feed_id===f.feeds[2].id));assert.equal(f.db.feeds().length,1);validateUnreadCounts(f.db.db);assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual(readFeedDeleteReceipt(receipt(f)),{added:0,total:2,found:true});
  for(const override of [{expectedOperationId:'stale'},{change:{...f.change,ids:[...f.change.ids].reverse()}},{change:{...f.change,expected:{entriesToDelete:5,archivesPreserved:1}}}])assert.equal(readFeedDeleteReceipt({...receipt(f),...override}).found,false);
  const value=f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key).value;assert.ok(value.length<512);assert.ok(!value.includes(f.feeds[0].url));
 }finally{f.close();}
});

test('receipt storage failure rolls back deleted sources, articles, counters and prior metadata receipt cleanup',()=>{
 const f=fixture();try{
  f.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('feed-metadata-write','prior');const before=state(f);
  f.db.db.exec("CREATE TRIGGER reject_delete_receipt BEFORE INSERT ON app_meta WHEN NEW.key='feed-delete-write' BEGIN SELECT RAISE(ABORT,'receipt rejected');END");
  assert.throws(()=>writeFeedDelete(input(f)),/receipt rejected/);assert.deepEqual(state(f),before);assert.equal(f.db.db.prepare("SELECT value FROM app_meta WHERE key='feed-metadata-write'").get().value,'prior');validateUnreadCounts(f.db.db);
 }finally{f.close();}
});

test('worker revalidates both preview counts and selected source existence at execution time',()=>{
 const f=fixture();try{
  const before=state(f);
  for(const expected of [{entriesToDelete:3,archivesPreserved:1},{entriesToDelete:4,archivesPreserved:0}])assert.throws(()=>writeFeedDelete({...input(f),change:{...f.change,expected}}),error=>error.statusCode===409);
  assert.deepEqual(state(f),before);f.db.deleteFeed(f.feeds[0].id);assert.throws(()=>writeFeedDelete(input(f)),error=>error.statusCode===409);assert.ok(f.db.feed(f.feeds[1].id));validateUnreadCounts(f.db.db);
 }finally{f.close();}
});

for(const single of [false,true])for(const mode of ['exit','invalid'])test(`${single?'single':'bulk'} committed ${mode} reply recovers without deleting twice`,async()=>{
 const f=fixture();let service;try{
  f.db.db.exec('CREATE TABLE deletion_audit(id TEXT);CREATE TRIGGER deletion_audit AFTER DELETE ON feeds BEGIN INSERT INTO deletion_audit VALUES(OLD.id);END');
  const worker=join(f.directory,'lost.cjs');writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),mod=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind==='feed_delete_receipt'){parentPort.postMessage({result:mod.readFeedDeleteReceipt(input)});return;}mod.writeFeedDelete(input);${mode==='exit'?'process.exit(17);':"parentPort.postMessage({result:{added:0,total:9999}});"}});`);
  service=open(f,worker);const response=await send(service,f,single);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),single?{deleted:1}:{changed:2,action:'delete'});assert.equal(f.db.db.prepare('SELECT count(*) n FROM deletion_audit').get().n,single?1:2);assert.equal(state(f).archives.length,1);validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

test('uncommitted worker exit cannot adopt a stale deletion receipt or replay deletion',async()=>{
 const f=fixture();let service;try{
  f.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run(key,JSON.stringify({operationId:'old',result:{added:0,total:2}}));const before=state(f);
  const worker=join(f.directory,'uncommitted.cjs');writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),mod=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind==='feed_delete_receipt')parentPort.postMessage({result:mod.readFeedDeleteReceipt(input)});else process.exit(18);});`);
  service=open(f,worker);const response=await send(service,f);assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/待核验/);assert.deepEqual(state(f),before);validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

test('readers see the old complete snapshot while a deletion transaction is held before commit',async()=>{
 const f=fixture(),gate=join(f.directory,'release'),started=join(f.directory,'started');let service,pending;
 try{
  const worker=join(f.directory,'gated.cjs');writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),mod=require(workerData.modulePath),exec=DatabaseSync.prototype.exec,wait=new Int32Array(new SharedArrayBuffer(4));DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&this.prepare("SELECT 1 FROM app_meta WHERE key='feed-delete-write'").get()){fs.writeFileSync(${JSON.stringify(started)},'ready');const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>=end)throw Error('gate expired');Atomics.wait(wait,0,0,10);}}return exec.call(this,sql);};parentPort.on('message',input=>{try{parentPort.postMessage({result:mod.writeFeedDelete(input)});}catch(error){parentPort.postMessage({error:error.message,statusCode:error.statusCode});}});`);
  service=open(f,worker);pending=send(service,f).then(value=>value);await ready(started);
  const responses=await bounded(Promise.all(['/health','/api/feeds?icons=metadata','/api/entries?offset=1'].map(url=>service.app.inject({method:'GET',url,headers:{'x-rivu-token':'delete-token'}}))));for(const response of responses)assert.equal(response.statusCode,200,response.body);assert.equal(responses[2].json().length,5);assert.equal(f.db.feeds().length,3);
  writeFileSync(gate,'release');assert.equal((await pending).statusCode,200);assert.equal(f.db.feeds().length,1);validateUnreadCounts(f.db.db);
 }finally{writeFileSync(gate,'release');await pending;await service?.stop();f.close();}
});
