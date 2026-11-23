import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createService} from '../dist-server/service.js';
import {validateUnreadCounts} from '../dist-server/unread-counts.js';
import {ImageCache} from '../dist-server/image-cache.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const {writeFeedMetadata,readFeedMetadataReceipt}=require('../dist-server/feed-write-task.cjs'),key='feed-metadata-write',modulePath=resolve('dist-server/feed-write-task.cjs');
const decode=result=>JSON.parse(new TextDecoder().decode(result.json));
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-feed-metadata-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),a=db.addCategory('A'),b=db.addCategory('B');
 const feeds=[0,1].map(i=>db.addFeed({title:'来源'+i,url:'https://example.invalid/metadata/'+i,categoryId:a.id,fetchInterval:0}));
 for(const feed of feeds)db.addEntries(feed.id,[{title:'原始文章',content:'<p>原始😀\u0000</p>',hash:'metadata-one',publishedAt:'2025-01-01'},{title:'第二篇',content:'保留',hash:'metadata-two',publishedAt:'2025-02-01'}]);
 return {directory,path,db,a,b,feeds,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const input=(f,kind)=>kind==='feed_patch'?{kind,databasePath:f.path,id:f.feeds[0].id,patch:{title:'修改😀\u0000尾',categoryId:f.b.id}}:{kind,databasePath:f.path,id:f.a.id};
const state=f=>({feeds:f.db.db.prepare('SELECT * FROM feeds ORDER BY id').all(),categories:f.db.categories(),entries:f.db.db.prepare('SELECT *,hex(CAST(content AS BLOB)) raw FROM entries ORDER BY id').all()});
const open=(f,worker)=>createService(f.db,'metadata-token',undefined,undefined,undefined,undefined,undefined,undefined,worker,modulePath);
const send=(service,job)=>service.app.inject({method:job.kind==='feed_patch'?'PATCH':'DELETE',url:job.kind==='feed_patch'?'/api/feeds/'+job.id:'/api/categories/'+job.id,headers:{'x-rivu-token':'metadata-token'},...(job.kind==='feed_patch'?{payload:job.patch}:{})});
async function ready(path){const end=Date.now()+5000;while(!existsSync(path)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(existsSync(path),'worker reached transaction gate');}
async function bounded(promise,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),5000);})]);}finally{clearTimeout(timer);}}

test('feed patch serializes the exact large response in the worker and recovers that response after later metadata changes',()=>{
 const f=fixture();try{
  const icon='data:image/png;base64,'+'A'.repeat(1048576);f.db.db.prepare('UPDATE feeds SET icon=? WHERE id=?').run(icon,f.feeds[0].id);
  const job={...input(f,'feed_patch'),operationId:'exact-response'},before=state(f).entries,result=writeFeedMetadata(job),feed=decode(result);
  assert.deepEqual(feed,plain(f.db.feed(job.id)));assert.equal(feed.icon,icon);
  assert.equal(f.db.db.prepare('SELECT hex(CAST(title AS BLOB)) raw FROM feeds WHERE id=?').get(job.id).raw,Buffer.from(job.patch.title).toString('hex').toUpperCase());validateUnreadCounts(f.db.db);
  f.db.updateFeed(job.id,{title:'later'});
  const recovered=readFeedMetadataReceipt({kind:'feed_metadata_receipt',databasePath:f.path,id:job.id,targetKind:job.kind,expectedOperationId:job.operationId});
  assert.equal(recovered.found,true);assert.deepEqual(decode(recovered),feed);assert.deepEqual(state(f).entries,before);
  for(const overrides of [{expectedOperationId:'stale'},{id:f.feeds[1].id},{targetKind:'category_delete'}])assert.equal(readFeedMetadataReceipt({kind:'feed_metadata_receipt',databasePath:f.path,id:job.id,targetKind:job.kind,expectedOperationId:job.operationId,...overrides}).found,false);
 }finally{f.close();}
});

for(const kind of ['feed_patch','category_delete'])test(kind+' rolls back metadata and counters when the response receipt cannot be stored',()=>{
 const f=fixture();try{
  const before=state(f);f.db.db.exec("CREATE TRIGGER reject_metadata_receipt BEFORE INSERT ON app_meta WHEN NEW.key='feed-metadata-write' BEGIN SELECT RAISE(ABORT,'metadata receipt failure');END");
  assert.throws(()=>writeFeedMetadata({...input(f,kind),operationId:'failed'}),/metadata receipt failure/);assert.deepEqual(state(f),before);assert.equal(f.db.db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key),undefined);validateUnreadCounts(f.db.db);
 }finally{f.close();}
});

test('category delete detaches feeds, preserves raw entries and retains missing-category and validation contracts',async()=>{
 const f=fixture();let service;try{
  const articles=state(f).entries,job={...input(f,'category_delete'),operationId:'deleted'};
  assert.deepEqual(writeFeedMetadata(job),{added:0,total:1});assert.ok(f.db.feeds().every(feed=>feed.category_id===null));assert.deepEqual(state(f).entries,articles);validateUnreadCounts(f.db.db);
  assert.deepEqual(readFeedMetadataReceipt({kind:'feed_metadata_receipt',databasePath:f.path,id:job.id,targetKind:job.kind,expectedOperationId:job.operationId}),{added:0,total:1,found:true});
  assert.deepEqual(writeFeedMetadata({...job,operationId:'missing'}),{added:0,total:0});
  service=open(f,undefined);const missing=await send(service,job);assert.equal(missing.statusCode,200);assert.deepEqual(missing.json(),{deleted:0});
  for(const patch of [{enabled:'yes'},{allowPrivate:1},{fetchInterval:7}])assert.equal((await send(service,{...input(f,'feed_patch'),patch})).statusCode,400);
  assert.equal((await send(service,{...input(f,'feed_patch'),id:'missing'})).statusCode,404);
 }finally{await service?.stop();f.close();}
});

for(const kind of ['feed_patch','category_delete'])for(const mode of ['exit','invalid'])test(kind+' committed '+mode+' reply is reconciled once, including binary response transport',async()=>{
 const f=fixture();let service;try{
  f.db.db.exec('CREATE TABLE metadata_audit(id TEXT);CREATE TRIGGER metadata_audit AFTER UPDATE OF category_id ON feeds BEGIN INSERT INTO metadata_audit VALUES(NEW.id);END');
  const worker=join(f.directory,'lost.cjs');writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),mod=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind==='feed_metadata_receipt'){parentPort.postMessage({result:mod.readFeedMetadataReceipt(input)});return;}mod.writeFeedMetadata(input);${mode==='exit'?'process.exit(17);':"parentPort.postMessage({result:{added:5,total:0}});"}});`);
  service=open(f,worker);const job=input(f,kind),response=await send(service,job);assert.equal(response.statusCode,200,response.body);
  if(kind==='feed_patch')assert.deepEqual(response.json(),plain(f.db.feed(job.id)));else assert.deepEqual(response.json(),{deleted:1});
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM metadata_audit').get().n,kind==='feed_patch'?1:2);validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

for(const kind of ['feed_patch','category_delete'])test(kind+' uncommitted exit never adopts a stale receipt or repeats the mutation',async()=>{
 const f=fixture();let service;try{
  const before=state(f),job=input(f,kind);f.db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run(key,JSON.stringify({operationId:'old',kind,id:job.id,result:{added:0,total:1},response:JSON.stringify(f.db.feed(f.feeds[0].id))}));
  const worker=join(f.directory,'uncommitted.cjs');writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),mod=require(workerData.modulePath);parentPort.on('message',input=>{if(input.kind==='feed_metadata_receipt'){parentPort.postMessage({result:mod.readFeedMetadataReceipt(input)});return;}process.exit(18);});`);
  service=open(f,worker);const response=await send(service,job);assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/待核验/);assert.deepEqual(state(f),before);validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

for(const kind of ['feed_patch','category_delete'])test(kind+' holds one SQLite transaction while readers complete and only observe committed metadata',async()=>{
 const f=fixture(),gate=join(f.directory,'release'),started=join(f.directory,'started');let service,pending;
 try{
  const worker=join(f.directory,'gated.cjs');writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),mod=require(workerData.modulePath),exec=DatabaseSync.prototype.exec,wait=new Int32Array(new SharedArrayBuffer(4));let operationId;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&operationId){const row=this.prepare("SELECT value FROM app_meta WHERE key='feed-metadata-write'").get();if(row&&JSON.parse(row.value).operationId===operationId){fs.writeFileSync(${JSON.stringify(started)},'ready');const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>=end)throw Error('gate expired');Atomics.wait(wait,0,0,10);}}}return exec.call(this,sql);};parentPort.on('message',input=>{operationId=input.operationId;try{const result=mod.writeFeedMetadata(input);parentPort.postMessage({result},result.json?[result.json]:[]);}catch(error){parentPort.postMessage({error:error.message,statusCode:error.statusCode});}});`);
  service=open(f,worker);pending=send(service,input(f,kind)).then(response=>response);await ready(started);
  const paths=['/health','/api/feeds?icons=metadata','/api/entries?categoryId='+f.a.id+'&offset=1'];let timer;
  try{const responses=await Promise.race([Promise.all(paths.map(url=>service.app.inject({method:'GET',url,headers:{'x-rivu-token':'metadata-token'}}))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('readers waited for writer commit')),5000);})]);for(const response of responses)assert.equal(response.statusCode,200,response.body);assert.equal(responses[2].json().length,3);}finally{clearTimeout(timer);}
  assert.equal(f.db.feed(f.feeds[0].id).category_id,f.a.id);writeFileSync(gate,'release');assert.equal((await pending).statusCode,200);validateUnreadCounts(f.db.db);
 }finally{writeFileSync(gate,'release');await pending;await service?.stop();f.close();}
});

for(const mode of ['single','bulk'])test(mode+' source deletion removes retained feed responses atomically and rolls back if cleanup fails',async()=>{
 const f=fixture();let service;try{
  writeFeedMetadata({...input(f,'feed_patch'),operationId:'retained'});assert.ok(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key).value.includes(f.feeds[0].url));
  const before=state(f);f.db.db.exec("CREATE TRIGGER reject_receipt_cleanup BEFORE DELETE ON app_meta WHEN OLD.key='feed-metadata-write' BEGIN SELECT RAISE(ABORT,'receipt cleanup failure');END");
  const bulk=()=>service.app.inject({method:'POST',url:'/api/feeds/bulk',headers:{'x-rivu-token':'metadata-token'},payload:{ids:[f.feeds[0].id],action:'delete',expected:{entriesToDelete:2,archivesPreserved:0}}});
  if(mode==='single')assert.throws(()=>f.db.deleteFeed(f.feeds[0].id),/receipt cleanup failure/);else{service=open(f,undefined);assert.equal((await bulk()).statusCode,500);}
  assert.deepEqual(state(f),before);validateUnreadCounts(f.db.db);f.db.db.exec('DROP TRIGGER reject_receipt_cleanup');
  if(mode==='single')assert.equal(f.db.deleteFeed(f.feeds[0].id),1);else assert.equal((await bulk()).statusCode,200);
  assert.equal(f.db.db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(key),undefined);assert.equal(f.db.feed(f.feeds[0].id),undefined);assert.ok(f.db.feed(f.feeds[1].id));validateUnreadCounts(f.db.db);
 }finally{await service?.stop();f.close();}
});

test('image cache queue and network waits release main leases so permission changes stop queued image requests',async()=>{
 const f=fixture();let service,releaseSlow,slowStarted;const slowGate=new Promise(resolve=>releaseSlow=resolve),started=new Promise(resolve=>slowStarted=resolve);let blockedRequests=0;const jobs=[];
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
 const origin=createServer(async(req,res)=>{if(req.url==='/slow.png'){slowStarted();await slowGate;}else blockedRequests++;res.setHeader('content-type','image/png');res.end(png);});
 await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${origin.address().port}`,feeds=[0,1].map(i=>f.db.addFeed({title:'图片'+i,url:base+'/feed'+i,allowPrivate:true,fetchInterval:0}));
  for(let i=0;i<2;i++)f.db.addEntries(feeds[i].id,[{title:'图片文章',url:base+'/article'+i,content:`<img src="${base}/${i?'blocked':'slow'}.png">`,hash:'image-'+i}]);
  const ids=feeds.map(feed=>f.db.entries({feedId:feed.id})[0].id);service=createService(f.db,'metadata-token',undefined,f.directory);
  const cache=(id,path)=>service.app.inject({method:'POST',url:'/api/image-cache/cache',headers:{'x-rivu-token':'metadata-token'},payload:{entryId:id,url:base+path,explicit:true}}).then(response=>response);
  const first=cache(ids[0],'/slow.png');jobs.push(first);await bounded(started,'image request did not start');
  const second=cache(ids[1],'/blocked.png');jobs.push(second);await new Promise(resolve=>setTimeout(resolve,30));
  let timer;try{const changed=await Promise.race([send(service,{kind:'feed_patch',id:feeds[1].id,patch:{allowPrivate:false}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('permission update waited on image queue')),5000);})]);assert.equal(changed.statusCode,200,changed.body);}finally{clearTimeout(timer);}
  releaseSlow();assert.equal((await first).statusCode,200);assert.equal((await second).statusCode,409);assert.equal(blockedRequests,0);
 }finally{releaseSlow();await Promise.allSettled(jobs);await service?.stop();await new Promise(resolve=>origin.close(resolve));f.close();}
});

for(const mode of ['cache','load'])test(mode+' rejects a network result after permission was revoked in flight without retaining files or cache rows',async()=>{
 const f=fixture();let service,pending,release,notify;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
 const origin=createServer(async(_req,res)=>{notify();await gate;res.setHeader('content-type','image/png');res.end(png);});await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${origin.address().port}`,url=base+'/in-flight.png',feed=f.db.addFeed({title:'在途图片',url:base+'/feed',allowPrivate:true,fetchInterval:0});f.db.addEntries(feed.id,[{title:'图片',url:base+'/article',content:`<img src="${url}">`,hash:'in-flight'}]);const id=f.db.entries({feedId:feed.id})[0].id;
  service=createService(f.db,'metadata-token',undefined,f.directory);
  // Arm the network race after parser startup; this test checks revocation in
  // flight, not cold Worker startup under parallel full-suite load.
  const warm=await service.app.inject({method:'GET',url:`/api/image-cache/lookup?entryId=${id}&url=${encodeURIComponent(url)}`,headers:{'x-rivu-token':'metadata-token'}});
  assert.equal(warm.statusCode,200,warm.body);assert.equal(warm.json(),null);
  pending=service.app.inject({method:mode==='cache'?'POST':'GET',url:mode==='cache'?'/api/image-cache/cache':`/api/image-cache/load?entryId=${id}&url=${encodeURIComponent(url)}`,headers:{'x-rivu-token':'metadata-token'},...(mode==='cache'?{payload:{entryId:id,url,explicit:true}}:{})}).then(value=>value);
  await bounded(started,'in-flight request did not start');const changed=await bounded(send(service,{kind:'feed_patch',id:feed.id,patch:{allowPrivate:false}}),'permission update waited for image network');assert.equal(changed.statusCode,200,changed.body);
  release();const result=await pending;assert.equal(result.statusCode,409,result.body);assert.equal(f.db.cachedImage(url),undefined);const directory=join(f.directory,'cache','images');assert.deepEqual(existsSync(directory)?readdirSync(directory):[],[]);
 }finally{release();await pending;await service?.stop();await new Promise(resolve=>origin.close(resolve));f.close();}
});

for(const phase of ['lookup','temp-write'])test('image '+phase+' rechecks permission after file I/O and does not evict existing cache or retain new partial data',async()=>{
 const f=fixture();let release,notify,pending;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve);let gated=false;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64'),origin=createServer((_req,res)=>{res.setHeader('content-type','image/png');res.end(png);});await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${origin.address().port}`,url=base+'/file.png',feed=f.db.addFeed({title:'文件图片',url:base+'/feed',allowPrivate:true,fetchInterval:0}),directory=join(f.directory,'cache','images');
  const authorize=()=>{if(!f.db.feed(feed.id).allow_private)throw Object.assign(Error('permission changed'),{statusCode:409});return base;};
  if(phase==='lookup')await new ImageCache(f.db,undefined,f.directory).cache(url,base,true,authorize);
  const cache=new ImageCache(f.db,undefined,f.directory,async action=>{const value=await action();if(!gated&&(phase==='lookup'?Buffer.isBuffer(value):value===undefined&&existsSync(directory)&&readdirSync(directory).some(name=>name.endsWith('.tmp')))){gated=true;notify();await gate;}return value;});
  pending=(phase==='lookup'?cache.lookup(url,authorize):cache.cache(url,base,true,authorize)).then(value=>({value}),error=>({error}));
  await bounded(started,'file I/O gate did not start');f.db.updateFeed(feed.id,{allowPrivate:false});release();assert.equal((await pending).error?.statusCode,409);
  if(phase==='lookup'){assert.ok(f.db.cachedImage(url));assert.equal(readdirSync(directory).length,1);f.db.updateFeed(feed.id,{allowPrivate:true});assert.equal((await new ImageCache(f.db,undefined,f.directory).lookup(url,authorize)).bytes,png.length);}
  else{assert.equal(f.db.cachedImage(url),undefined);assert.deepEqual(readdirSync(directory),[]);}
 }finally{release();await pending;await new Promise(resolve=>origin.close(resolve));f.close();}
});

test('failed image index write removes its newly installed file and temporary file',async()=>{
 const f=fixture(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
 const origin=createServer((_req,res)=>{res.setHeader('content-type','image/png');res.end(png);});await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 try{const base=`http://127.0.0.1:${origin.address().port}`,url=base+'/index.png',cache=new ImageCache(f.db,undefined,f.directory);f.db.saveCachedImage=()=>{throw Error('index write failure');};await assert.rejects(cache.cache(url,base,true),/index write failure/);assert.equal(f.db.cachedImage(url),undefined);assert.deepEqual(readdirSync(join(f.directory,'cache','images')),[]);}
 finally{await new Promise(resolve=>origin.close(resolve));f.close();}
});
