import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {getEventListeners} from 'node:events';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
import {requestBytes,setProxyPreferences} from '../server/network.ts';
import {createDirectImageFetch} from '../electron/image-direct.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('native service fixture deadline')),10000);})]);}finally{clearTimeout(timer);}}
function fixture(url='https://example.invalid/image.png',cached=true){
 const directory=mkdtempSync(join(tmpdir(),'rivu-native-service-')),db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'图片',url:new URL('/feed',url).href,allowPrivate:true,fetchInterval:0});
 db.addEntries(feed.id,[{title:'正文',content:`<img src="${url}">`,hash:'one'}]);const entry=db.entries()[0],file=createHash('sha256').update(url).digest('hex')+'.png',files=join(directory,'cache','images');mkdirSync(files,{recursive:true});
 if(cached){writeFileSync(join(files,file),png);db.saveCachedImage(url,file,'image/png',png.length);db.db.prepare("UPDATE cached_images SET last_accessed_at='2000'").run();}
 return {directory,db,feed,entry,url,file,files,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('native private reads share HTTP bytes and guard final publication after a returned preparation',async()=>{
 const f=fixture(),service=createService(f.db,'token',undefined,f.directory);
 try{
  const prepared=await service.readNativeImage(f.entry.id,f.url,'lookup');assert.deepEqual(prepared.image.data,png);prepared.authorize();
  const http=await service.app.inject({method:'GET',url:'/api/image-cache/lookup?'+new URLSearchParams({entryId:f.entry.id,url:f.url,transport:'binary'}),headers:{'x-rivu-token':'token'}});assert.equal(http.statusCode,200);assert.deepEqual(http.rawPayload,png);
  f.db.updateFeed(f.feed.id,{allowPrivate:false});assert.throws(()=>prepared.authorize(),error=>error.statusCode===409);
  await assert.rejects(service.readNativeImage(f.entry.id,'https://example.invalid/unrelated.png','lookup'),/不属于/);
  await assert.rejects(service.readNativeImage(f.entry.id,f.url,'settings'),error=>error.statusCode===400);
 }finally{await service.stop();f.close();}
});

test('indexed image checks avoid full entry reads and reject a revoked media grant',async()=>{
 const f=fixture(),service=createService(f.db,'token',undefined,f.directory);
 try{
  f.db.db.prepare("INSERT INTO entry_media(entry_id,kind,url,source,created_at) VALUES (?,'image',?,'body','2026')").run(f.entry.id,f.url);
  f.db.entry=()=>assert.fail('indexed image authorization must not read the full entry');
  const prepared=await service.readNativeImage(f.entry.id,f.url,'lookup');assert.deepEqual(prepared.image.data,png);prepared.authorize();
  f.db.db.prepare('DELETE FROM entry_media WHERE entry_id=? AND url=?').run(f.entry.id,f.url);
  assert.throws(()=>prepared.authorize(),error=>error.statusCode===409);
 }finally{await service.stop();f.close();}
});

test('HTML image fallback reads the body once and rejects a changed body or cover',async()=>{
 const f=fixture(),service=createService(f.db,'token',undefined,f.directory),entry=f.db.entry.bind(f.db);let reads=0;
 f.db.entry=(...args)=>{reads++;return entry(...args);};
 try{
  const prepared=await service.readNativeImage(f.entry.id,f.url,'lookup');prepared.authorize();assert.equal(reads,1);
  f.db.db.prepare('UPDATE entries SET description=? WHERE id=?').run('new description',f.entry.id);
  assert.throws(()=>prepared.authorize(),error=>error.statusCode===409);
  const next=await service.readNativeImage(f.entry.id,f.url,'lookup');
  f.db.db.prepare('UPDATE entries SET cover=? WHERE id=?').run('https://example.invalid/other.png',f.entry.id);
  assert.throws(()=>next.authorize(),error=>error.statusCode===409);
 }finally{await service.stop();f.close();}
});

test('canonical one-image HTML can authorize without a parser Worker, while complex HTML still requires it',async()=>{
 const f=fixture(),service=createService(f.db,'token',undefined,f.directory,undefined,undefined,join(f.directory,'missing-worker.cjs'));
 try{
  const prepared=await service.readNativeImage(f.entry.id,f.url,'lookup');assert.deepEqual(prepared.image.data,png);prepared.authorize();
  f.db.db.prepare('UPDATE entries SET content=? WHERE id=?').run(`<template><img src="${f.url}"></template>`,f.entry.id);
  assert.throws(()=>prepared.authorize(),error=>error.statusCode===409);
  await assert.rejects(service.readNativeImage(f.entry.id,f.url,'lookup'),/missing-worker|解析/);
 }finally{await service.stop();f.close();}
});

test('cancelled cached file reads retain valid bytes and index rather than treating abort as corruption',async()=>{
 const f=fixture(),service=createService(f.db,'token',undefined,f.directory),controller=new AbortController(),cached=f.db.cachedImage.bind(f.db);let first=true;
 f.db.cachedImage=url=>{const row=cached(url);if(first){first=false;queueMicrotask(()=>controller.abort());}return row;};
 try{
  await assert.rejects(service.readNativeImage(f.entry.id,f.url,'lookup',controller.signal));assert.ok(cached(f.url));assert.ok(existsSync(join(f.files,f.file)));
  const prepared=await service.readNativeImage(f.entry.id,f.url,'lookup');prepared.authorize();assert.deepEqual(prepared.image.data,png);
 }finally{await service.stop();f.close();}
});

test('native cache hits read through a held unrelated writer transaction without taking a main write lease',async()=>{
 const f=fixture(),other=f.db.addFeed({title:'其他',url:'https://example.invalid/other',fetchInterval:0}),ready=join(f.directory,'ready'),release=join(f.directory,'release'),worker=join(f.directory,'held.cjs'),modulePath=resolve('dist-server/feed-write-task.cjs');
 writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads'),{DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),mod=require(workerData.modulePath),exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT'&&this.prepare("SELECT 1 FROM app_meta WHERE key='feed-metadata-write'").get()){fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>end)throw Error('gate expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return exec.call(this,sql);};parentPort.on('message',input=>{try{const result=mod.writeFeedMetadata(input);parentPort.postMessage({result},result.json?[result.json]:[]);}catch(error){parentPort.postMessage({error:error.message,statusCode:error.statusCode});}});`);
 const service=createService(f.db,'token',undefined,f.directory,undefined,undefined,undefined,undefined,worker,modulePath);let pending;
 try{
  pending=service.app.inject({method:'PATCH',url:'/api/feeds/'+other.id,headers:{'x-rivu-token':'token'},payload:{title:'changed'}});const deadline=Date.now()+10000;while(!existsSync(ready)){assert.ok(Date.now()<deadline);await pause(10);}
  const prepared=await bounded(service.readNativeImage(f.entry.id,f.url,'lookup'));prepared.authorize();assert.deepEqual(prepared.image.data,png);assert.equal(f.db.cachedImage(f.url).last_accessed_at,'2000');
  writeFileSync(release,'release');assert.equal((await pending).statusCode,200);
 }finally{writeFileSync(release,'release');await pending;await service.stop();f.close();}
});

test('native abort closes a real slow origin request and service shutdown drains the accepted operation',async()=>{
 let started,closed;const ready=new Promise(done=>started=done),closing=new Promise(done=>closed=done),origin=createServer((_req,res)=>{res.once('close',closed);res.writeHead(200,{'content-type':'image/png','content-length':png.length});res.write(png.subarray(0,1));started();});
 await new Promise(done=>origin.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+origin.address().port,f=fixture(base+'/image.png',false),service=createService(f.db,'token',undefined,f.directory),controller=new AbortController();let pending;
 try{
  pending=service.readNativeImage(f.entry.id,f.url,'load',controller.signal);const rejection=assert.rejects(pending);await bounded(ready);controller.abort();await bounded(rejection);await bounded(closing);assert.equal(f.db.cachedImage(f.url),undefined);await bounded(service.stop());
  await assert.rejects(service.readNativeImage(f.entry.id,f.url,'lookup'),error=>error.statusCode===503);
 }finally{controller.abort();await pending?.catch(()=>{});await service.stop();origin.closeAllConnections();await new Promise(done=>origin.close(done));f.close();}
});

test('network cancellation stops a DNS wait without retaining abort listeners or opening a request later',async()=>{
 setProxyPreferences({mode:'direct',httpProxy:'',httpsProxy:'',noProxy:''});const controller=new AbortController();let resolveDns,queries=0;
 const dns=new Promise(done=>resolveDns=done),pending=requestBytes('https://example.invalid/image',10,'image/png',undefined,()=>{queries++;return dns;},undefined,controller.signal),rejection=assert.rejects(pending);controller.abort();await bounded(rejection);assert.equal(queries,1);assert.equal(getEventListeners(controller.signal,'abort').length,0);resolveDns([{address:'93.184.216.34',family:4}]);await pause(10);
});

test('direct publication denies a source change in the microtask gap after service preparation',async()=>{
 const f=fixture(),service=createService(f.db,'token',undefined,f.directory),baseUrl='http://127.0.0.1:6543';
 const fetch=createDirectImageFetch({baseUrl,token:'token',read:async(...args)=>{const prepared=await service.readNativeImage(...args);f.db.updateFeed(f.feed.id,{allowPrivate:false});return prepared;}});
 try{const response=await fetch(baseUrl+'/api/image-cache/lookup?'+new URLSearchParams({entryId:f.entry.id,url:f.url,transport:'binary'}),{method:'GET',headers:{'X-Rivu-Token':'token'}});assert.equal(response.status,409);assert.equal((await response.arrayBuffer()).byteLength,0);}
 finally{await service.stop();f.close();}
});

test('cancelling a queued native load rejects before the earlier cache download finishes and never starts its origin request',async()=>{
 let started,release,secondRequests=0;const ready=new Promise(done=>started=done),gate=new Promise(done=>release=done);
 const origin=createServer(async(req,res)=>{if(req.url==='/first.png'){started();await gate;}else secondRequests++;if(!res.destroyed){res.setHeader('content-type','image/png');res.end(png);}});
 await new Promise(done=>origin.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+origin.address().port,f=fixture(base+'/second.png',false),service=createService(f.db,'token',undefined,f.directory),controller=new AbortController();let first,pending;
 const headers={'x-rivu-token':'token'};
 try{
  f.db.db.prepare('UPDATE entries SET content=? WHERE id=?').run(`<img src="${base}/first.png"><img src="${f.url}">`,f.entry.id);
  assert.equal((await service.app.inject({method:'PATCH',url:'/api/image-cache/settings',headers,payload:{enabled:true}})).statusCode,200);
  first=service.app.inject({method:'POST',url:'/api/image-cache/cache',headers,payload:{entryId:f.entry.id,url:base+'/first.png',explicit:true}});await bounded(ready);
  let reachedCache;const queued=new Promise(done=>reachedCache=done),cached=f.db.cachedImage.bind(f.db);let cacheChecks=0;
  f.db.cachedImage=url=>{const row=cached(url);if(url===f.url&&++cacheChecks>=2)reachedCache();return row;};
  pending=service.readNativeImage(f.entry.id,f.url,'load',controller.signal);const rejected=assert.rejects(pending);
  await bounded(queued);await pause(0);assert.ok(cacheChecks>=2);controller.abort();await bounded(rejected);assert.equal(secondRequests,0);
  const other=f.db.addFeed({title:'其他',url:'https://example.invalid/other',fetchInterval:0});
  assert.equal((await bounded(service.app.inject({method:'PATCH',url:'/api/feeds/'+other.id,headers,payload:{title:'write remains available'}}))).statusCode,200);
  release();assert.equal((await first).statusCode,200);await pause(30);assert.equal(secondRequests,0);assert.equal(f.db.cachedImage(f.url),undefined);
 }finally{controller.abort();release();await pending?.catch(()=>{});await first;await service.stop();origin.closeAllConnections();await new Promise(done=>origin.close(done));f.close();}
});

test('cancellation after an atomic cache commit withholds native pixels but preserves the valid committed cache',async()=>{
 const origin=createServer((_req,res)=>{res.setHeader('content-type','image/png');res.end(png);});await new Promise(done=>origin.listen(0,'127.0.0.1',done));
 const f=fixture('http://127.0.0.1:'+origin.address().port+'/image.png',false),service=createService(f.db,'token',undefined,f.directory),controller=new AbortController(),save=f.db.saveCachedImage.bind(f.db);
 f.db.saveCachedImage=(...args)=>{const result=save(...args);controller.abort();return result;};
 try{
  await service.app.inject({method:'PATCH',url:'/api/image-cache/settings',headers:{'x-rivu-token':'token'},payload:{enabled:true}});
  await assert.rejects(service.readNativeImage(f.entry.id,f.url,'load',controller.signal));assert.ok(f.db.cachedImage(f.url));assert.ok(existsSync(join(f.files,f.file)));assert.ok(!readdirSync(f.files).some(name=>name.endsWith('.tmp')));
  const prepared=await service.readNativeImage(f.entry.id,f.url,'lookup');prepared.authorize();assert.deepEqual(prepared.image.data,png);
 }finally{await service.stop();origin.closeAllConnections();await new Promise(done=>origin.close(done));f.close();}
});

test('maintenance rejects new native reads, drains a cancelled accepted operation and restores usable preparation',async()=>{
 let started,release;const ready=new Promise(done=>started=done),gate=new Promise(done=>release=done);
 const origin=createServer(async(_req,res)=>{started();await gate;if(!res.destroyed){res.setHeader('content-type','image/png');res.end(png);}});await new Promise(done=>origin.listen(0,'127.0.0.1',done));
 const f=fixture('http://127.0.0.1:'+origin.address().port+'/image.png',false),service=createService(f.db,'token',undefined,f.directory),controller=new AbortController(),unsubscribe=service.onImageAvailability(available=>{if(!available)controller.abort();});let pending;
 try{
  pending=service.readNativeImage(f.entry.id,f.url,'load',controller.signal);const rejected=assert.rejects(pending);await bounded(ready);
  const headers={'x-rivu-token':'token'},startedMaintenance=await service.app.inject({method:'POST',url:'/api/storage/maintenance',headers,payload:{}});assert.equal(startedMaintenance.statusCode,200);assert.equal(startedMaintenance.json().running,true);
  await assert.rejects(service.readNativeImage(f.entry.id,f.url,'lookup'),error=>error.statusCode===503);await bounded(rejected);release();
  let status;const deadline=Date.now()+10000;do{status=(await service.app.inject({method:'GET',url:'/api/storage/maintenance',headers})).json();if(!status.running)break;await pause(20);}while(Date.now()<deadline);
  assert.equal(status.running,false);assert.equal(status.lastError,null);assert.ok(status.lastResult);
  const prepared=await service.readNativeImage(f.entry.id,f.url,'load');prepared.authorize();assert.deepEqual(prepared.image.data,png);
 }finally{release();controller.abort();unsubscribe();await pending?.catch(()=>{});await service.stop();origin.closeAllConnections();await new Promise(done=>origin.close(done));f.close();}
});
