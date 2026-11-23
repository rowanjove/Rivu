import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createService} from '../dist-server/service.js';
import {ImageCache} from '../dist-server/image-cache.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs'),modulePath=resolve('dist-server/feed-write-task.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
function fixture(url='https://example.invalid/image.png'){
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-concurrency-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),feed=db.addFeed({title:'图片来源',url:new URL('/feed',url).href,allowPrivate:true,fetchInterval:0});
 db.addEntries(feed.id,[{title:'图片文章',content:`<img src="${url}">`,url:new URL('/article',url).href,hash:'image'}]);const entry=db.entries({feedId:feed.id})[0];
 const files=join(directory,'cache','images'),file=createHash('sha256').update(url).digest('hex')+'.png';mkdirSync(files,{recursive:true});writeFileSync(join(files,file),png);db.saveCachedImage(url,file,'image/png',png.length);db.db.prepare("UPDATE cached_images SET last_accessed_at='2000'").run();
 return {directory,path,db,feed,entry,url,file,files,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const headers={'x-rivu-token':'image-token'};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('image read waited for write commit')),20000))]);}finally{clearTimeout(timer);}}
async function ready(path){const end=Date.now()+20000;while(!existsSync(path)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(existsSync(path),'transaction gate did not start');}
function gatedService(f){
 const started=join(f.directory,'started'),release=join(f.directory,'release'),worker=join(f.directory,'gated.cjs');
 writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),mod=require(workerData.modulePath),exec=DatabaseSync.prototype.exec,wait=new Int32Array(new SharedArrayBuffer(4));DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&this.prepare("SELECT 1 FROM app_meta WHERE key='feed-metadata-write'").get()){fs.writeFileSync(${JSON.stringify(started)},'ready');const end=Date.now()+30000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>=end)throw Error('gate expired');Atomics.wait(wait,0,0,10);}}return exec.call(this,sql);};parentPort.on('message',input=>{try{const result=mod.writeFeedMetadata(input);parentPort.postMessage({result},result.json?[result.json]:[]);}catch(error){parentPort.postMessage({error:error.message,statusCode:error.statusCode});}});`);
 const service=createService(f.db,'image-token',undefined,f.directory,undefined,undefined,undefined,undefined,worker,modulePath);
 return {service,started,release};
}
const get=(service,f,mode)=>service.app.inject({method:'GET',url:`/api/image-cache/${mode}?entryId=${f.entry.id}&url=${encodeURIComponent(f.url)}`,headers});
const getBinary=(service,f,mode)=>service.app.inject({method:'GET',url:`/api/image-cache/${mode}?entryId=${f.entry.id}&url=${encodeURIComponent(f.url)}&transport=binary`,headers});

test('image endpoint availability closes before maintenance drains and reopens only after completion, then closes on stop',async()=>{
 const f=fixture(),g=gatedService(f),states=[];let pending;const unsubscribe=g.service.onImageAvailability(value=>states.push(value));
 try{
  pending=g.service.app.inject({method:'PATCH',url:'/api/feeds/'+f.feed.id,headers,payload:{title:'后台修改'}}).then(value=>value);await ready(g.started);
  const maintenance=await g.service.app.inject({method:'POST',url:'/api/storage/maintenance',headers});assert.equal(maintenance.statusCode,200,maintenance.body);assert.deepEqual(states,[true,false]);
  writeFileSync(g.release,'release');assert.equal((await pending).statusCode,200);
  const end=Date.now()+20000;while(states.length<3&&Date.now()<end)await new Promise(done=>setTimeout(done,20));assert.deepEqual(states,[true,false,true]);
  await g.service.stop();assert.deepEqual(states,[true,false,true,false]);
 }finally{unsubscribe();writeFileSync(g.release,'release');await pending;await g.service.stop();f.close();}
});

for(const mode of ['lookup','load'])test('binary '+mode+' returns exact pixels during an unrelated exclusive write without JSON encoding',async()=>{
 const f=fixture(),g=gatedService(f);let pending;
 try{
  pending=g.service.app.inject({method:'PATCH',url:'/api/feeds/'+f.feed.id,headers,payload:{title:'后台修改'}}).then(value=>value);await ready(g.started);
  const response=await bounded(getBinary(g.service,f,mode));assert.equal(response.statusCode,200);assert.equal(response.headers['content-type'],'image/png');assert.equal(response.headers['cache-control'],'no-store');assert.deepEqual(response.rawPayload,png);assert.equal(f.db.cachedImage(f.url).last_accessed_at,'2000');
  writeFileSync(g.release,'release');assert.equal((await pending).statusCode,200);
 }finally{writeFileSync(g.release,'release');await pending;await g.service.stop();f.close();}
});

for(const mode of ['lookup','load'])test('binary '+mode+' final publication rejects permission revoked after the file read authorization',async()=>{
 const f=fixture(),service=createService(f.db,'image-token',undefined,f.directory);const cached=f.db.cachedImage.bind(f.db);let reads=0;
 f.db.cachedImage=url=>{const row=cached(url);if(++reads===2)f.db.db.prepare('UPDATE feeds SET allow_private=0 WHERE id=?').run(f.feed.id);return row;};
 try{
  const response=await getBinary(service,f,mode);assert.ok(reads>=2);assert.equal(response.statusCode,409,response.body);assert.notEqual(response.headers['content-type'],'image/png');assert.equal(response.json().dataUrl,undefined);assert.ok(cached(f.url));
 }finally{await service.stop();f.close();}
});

test('binary cache misses use 204 and invalid transport or unauthorized callers cannot read bytes',async()=>{
 const f=fixture(),service=createService(f.db,'image-token',undefined,f.directory);
 try{
  f.db.deleteCachedImage(f.url);const miss=await getBinary(service,f,'lookup');assert.equal(miss.statusCode,204);assert.equal(miss.rawPayload.length,0);
  const path=`/api/image-cache/lookup?entryId=${f.entry.id}&url=${encodeURIComponent(f.url)}`;
  assert.equal((await service.app.inject({method:'GET',url:path+'&transport=invalid',headers})).statusCode,400);
  assert.equal((await service.app.inject({method:'GET',url:path+'&transport=binary'})).statusCode,401);
 }finally{await service.stop();f.close();}
});

for(const mode of ['lookup','load'])test(mode+' cached pixels complete before an exclusive writer commits; LRU bookkeeping drains afterward',async()=>{
 const f=fixture(),g=gatedService(f);let pending;
 try{
  pending=g.service.app.inject({method:'PATCH',url:'/api/feeds/'+f.feed.id,headers,payload:{title:'后台修改'}}).then(value=>value);await ready(g.started);
  const response=await bounded(get(g.service,f,mode));assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{dataUrl:'data:image/png;base64,'+png.toString('base64'),bytes:png.length});assert.equal(f.db.cachedImage(f.url).last_accessed_at,'2000');assert.equal(f.db.feed(f.feed.id).title,'图片来源');
  writeFileSync(g.release,'release');assert.equal((await pending).statusCode,200);await g.service.stop();assert.notEqual(f.db.cachedImage(f.url).last_accessed_at,'2000');
 }finally{writeFileSync(g.release,'release');await pending;await g.service.stop();f.close();}
});

for(const mode of ['lookup','load'])test(mode+' rejects pixels when permission mutation starts after handler authorization but before response serialization',async()=>{
 const f=fixture(),g=gatedService(f);let pending,armed=false;
 try{
  g.service.app.addHook('preSerialization',async(req,_reply,payload)=>{
   if(!armed&&req.url.startsWith('/api/image-cache/'+mode)&&payload?.dataUrl){armed=true;pending=g.service.app.inject({method:'PATCH',url:'/api/feeds/'+f.feed.id,headers,payload:{allowPrivate:false}}).then(value=>value);await ready(g.started);}
   return payload;
  });
  const response=await bounded(get(g.service,f,mode));assert.ok(armed);assert.equal(response.statusCode,409,response.body);assert.equal(response.json().dataUrl,undefined);assert.match(response.json().error,/授权正在更新/);
  writeFileSync(g.release,'release');assert.equal((await pending).statusCode,200);assert.ok(f.db.cachedImage(f.url));
 }finally{writeFileSync(g.release,'release');await pending;await g.service.stop();f.close();}
});

for(const mode of ['invalid-name','missing-file'])test(mode+' cache lookup completes during a write and repairs its index after commit',async()=>{
 const f=fixture();if(mode==='invalid-name')f.db.db.prepare("UPDATE cached_images SET file_name='../outside.png'").run();else rmSync(join(f.files,f.file));const g=gatedService(f);let pending;
 try{
  pending=g.service.app.inject({method:'PATCH',url:'/api/feeds/'+f.feed.id,headers,payload:{title:'后台修改'}}).then(value=>value);await ready(g.started);
  const response=await bounded(get(g.service,f,'lookup'));assert.equal(response.statusCode,200,response.body);assert.equal(response.json(),null);assert.ok(f.db.cachedImage(f.url),'cleanup cannot write before commit');
  writeFileSync(g.release,'release');assert.equal((await pending).statusCode,200);await g.service.stop();assert.equal(f.db.cachedImage(f.url),undefined);
 }finally{writeFileSync(g.release,'release');await pending;await g.service.stop();f.close();}
});

test('uncached load is rejected while private-origin revocation is pending, making no network request',async()=>{
 let requests=0;const origin=createServer((_req,res)=>{requests++;res.setHeader('content-type','image/png');res.end(png);});await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 const f=fixture(`http://127.0.0.1:${origin.address().port}/image.png`);f.db.deleteCachedImage(f.url);const g=gatedService(f);let pending,load;
 try{
  pending=g.service.app.inject({method:'PATCH',url:'/api/feeds/'+f.feed.id,headers,payload:{allowPrivate:false}}).then(value=>value);await ready(g.started);
  load=get(g.service,f,'load').then(value=>value);const response=await bounded(load);assert.equal(response.statusCode,409,response.body);assert.equal(requests,0);
  writeFileSync(g.release,'release');assert.equal((await pending).statusCode,200);assert.equal(requests,0);assert.equal(f.db.cachedImage(f.url),undefined);
 }finally{writeFileSync(g.release,'release');await Promise.allSettled([pending,load]);await g.service.stop();await new Promise(resolve=>origin.close(resolve));f.close();}
});

for(const mode of ['touch','evict'])test('deferred '+mode+' does not modify a replacement cache row',async()=>{
 const f=fixture(),maintenance=[];try{
  if(mode==='evict')rmSync(join(f.files,f.file));const cache=new ImageCache(f.db,undefined,f.directory);await cache.lookup(f.url,undefined,(_url,action)=>maintenance.push(action));assert.equal(maintenance.length,1);
  f.db.saveCachedImage(f.url,'b'.repeat(64)+'.jpg','image/jpeg',100);const replacement=JSON.stringify(f.db.cachedImage(f.url));for(const action of maintenance)action();assert.equal(JSON.stringify(f.db.cachedImage(f.url)),replacement);
 }finally{f.close();}
});

test('deferred missing-file cleanup preserves a repaired file even when its metadata is identical',async()=>{
 const f=fixture(),maintenance=[];try{
  rmSync(join(f.files,f.file));assert.equal(await new ImageCache(f.db,undefined,f.directory).lookup(f.url,undefined,(_url,action)=>maintenance.push(action)),null);
  writeFileSync(join(f.files,f.file),png);for(const action of maintenance)action();assert.ok(f.db.cachedImage(f.url));assert.ok(existsSync(join(f.files,f.file)));
 }finally{f.close();}
});

test('read-only lookup rejects authorization changed across file I/O without scheduling eviction or returning pixels',async()=>{
 const f=fixture();let release,notify,pending;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve),maintenance=[];let authorized=true;
 try{
  const cache=new ImageCache(f.db,undefined,f.directory,async action=>{const value=await action();notify();await gate;return value;});
  pending=cache.lookup(f.url,()=>{if(!authorized)throw Object.assign(Error('revoked'),{statusCode:409});},(_url,action)=>maintenance.push(action)).then(value=>({value}),error=>({error}));
  await started;authorized=false;release();assert.equal((await pending).error.statusCode,409);assert.equal(maintenance.length,0);assert.ok(f.db.cachedImage(f.url));
 }finally{release();await pending;f.close();}
});
