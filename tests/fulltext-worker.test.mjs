import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {FeedParser} from '../dist-server/feed-parser.js';
import {createService} from '../dist-server/service.js';
import {OfflineSaver,imageUrls} from '../dist-server/offline.js';
import {ImageCache} from '../dist-server/image-cache.js';
import {assertEntrySourceUnchanged} from '../dist-server/fulltext.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action){const deadline=Date.now()+15000;while(!action()){assert.ok(Date.now()<deadline,'等待解析Worker超时');await delay(10);}}
const text='星际探索带来新发现，正文应完整保留。'.repeat(40);
const html=`<html><head><title>完整文章</title><link rel="canonical" href="../canonical"></head><body><article><h1>完整文章</h1><p>${text}</p><p><a href="../related">相关</a><img src="/cover.png"></p><script>window.bad=true</script><iframe src="/bad"></iframe></article></body></html>`;

test('full-text and image workers preserve readable content, redirect-relative URLs and safe image deduplication',async()=>{
  const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));
  try{
    const result=await parser.extractFullText({text:html,url:'https://example.com/path/article',type:'text/html'});
    assert.equal(result.canonicalUrl,'https://example.com/canonical');assert.match(result.html,/星际探索/);assert.match(result.html,/https:\/\/example.com\/cover.png/);assert.match(result.html,/https:\/\/example.com\/related/);assert.doesNotMatch(result.html,/<script|<iframe/);
    const entry={id:'one',saved:0,url:'https://example.com/path/article',cover:'/cover.png',content:'<img src="/cover.png"><img src="relative.png"><img src="https://user:password@example.com/private"><img src="javascript:bad">'};
    assert.deepEqual(await parser.imageUrls(entry),imageUrls(entry));assert.deepEqual(await parser.imageUrls(entry),['https://example.com/cover.png','https://example.com/path/relative.png']);
    assert.deepEqual(await parser.imageUrls({content:'<img src="relative.png">'}),[]);
    await assert.rejects(parser.extractFullText({text:'plain text',url:'https://example.com/a',type:'text/plain'}),/不是 HTML/);
    const large={text:html.replace(`<p>${text}</p>`,Array.from({length:2000},(_,id)=>`<p>${id} ${text}</p>`).join('')),url:'https://example.com/path/article',type:'text/html'};
    let ticks=0;const timer=setInterval(()=>ticks++,10);try{assert.match((await parser.extractFullText(large)).html,/1999/);assert.ok(ticks>1,'正文解析期间父事件循环继续运行');}finally{clearInterval(timer);}
  }finally{await parser.stop();}
});

test('async full-text and image extraction rejects stale authorization or deletion while preserving manual states',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-fulltext-guard-')),worker=join(directory,'worker.cjs');
  writeFileSync(worker,`const {parentPort,workerData,threadId}=require('node:worker_threads');require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(directory)},'started-'+threadId),'started');setTimeout(async()=>{try{const task=require(workerData.modulePath);const result=await (workerData.kind==='full_text'?task.parseFullTextResponse:task.parseImageUrls)(workerData.response,workerData.candidate);parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:error.message});}},350);`);
  let imageRequests=0;const origin=createServer((req,res)=>{if(req.url==='/cover.png')imageRequests++;res.setHeader('content-type','text/html');res.end(html);});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${origin.address().port}`;
  const db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'本地源',url:base+'/feed',allowPrivate:true});db.addEntries(feed.id,[{title:'文章',url:base+'/article',content:'<p>旧正文</p><img src="/cover.png">',hash:'old'}]);const id=db.entries()[0].id;
  const service=createService(db,'token',undefined,undefined,undefined,undefined,worker,resolve('dist-server/feed-parse-task.cjs'));
  const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'token'},payload});
  const markers=()=>readdirSync(directory).filter(name=>name.startsWith('started-')).length;
  async function started(path){const previous=markers(),pending=request('POST',path);await until(()=>markers()>previous);return {pending};}
  try{
    const first=await started(`/api/entries/${id}/full-text`);assert.equal((await request('PATCH',`/api/entries/${id}`,{read:true,starred:true,saved:true})).statusCode,200);
    assert.equal((await first.pending).statusCode,200);assert.equal(db.entry(id).read,1);assert.equal(db.entry(id).starred,1);assert.equal(db.entry(id).saved,1);
    const before=db.entry(id),second=await started(`/api/entries/${id}/full-text`);assert.equal((await request('PATCH',`/api/feeds/${feed.id}`,{allowPrivate:false})).statusCode,200);
    assert.equal((await second.pending).statusCode,409);assert.equal(db.entry(id).full_content,before.full_content);assert.equal(db.entry(id).full_content_fetched_at,before.full_content_fetched_at);
    await request('PATCH',`/api/feeds/${feed.id}`,{allowPrivate:true});db.db.prepare('DELETE FROM entry_media WHERE entry_id=?').run(id);
    const previous=markers(),image=request('GET',`/api/image-cache/load?entryId=${id}&url=${encodeURIComponent(base+'/cover.png')}`);await until(()=>markers()>previous);await request('PATCH',`/api/feeds/${feed.id}`,{allowPrivate:false});assert.equal((await image).statusCode,409);assert.equal(imageRequests,0);
    await request('PATCH',`/api/feeds/${feed.id}`,{allowPrivate:true});const preview=(await request('GET',`/api/feeds/${feed.id}/delete-preview`)).json(),last=await started(`/api/entries/${id}/full-text`);assert.equal((await request('DELETE',`/api/feeds/${feed.id}`,{expected:preview})).statusCode,200);assert.equal((await last.pending).statusCode,404);assert.equal(db.entry(id),undefined);
  }finally{await service.stop();db.close();await new Promise(resolve=>origin.close(resolve));rmSync(directory,{recursive:true,force:true});}
});

test('offline save stops before image network access when authorization changes during image parsing',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-offline-guard-')),db=new RivuDatabase(join(directory,'rivu.db'));
  const feed=db.addFeed({title:'本地源',url:'http://127.0.0.1/feed',allowPrivate:true});db.addEntries(feed.id,[{title:'文章',url:'http://127.0.0.1/article',content:'正文',hash:'one'}]);const id=db.entries()[0].id;db.setFullContent(id,'<p>正文</p><img src="http://127.0.0.1/image.png">');
  let release,parsing=false,calls=0,first=true;const gate=new Promise(resolve=>release=resolve);
  const images={isCached:async()=>false,cache:async()=>{calls++;return {cached:true};}};
  const saver=new OfflineSaver(db,images,undefined,async()=>{if(first){first=false;parsing=true;await gate;}return ['http://127.0.0.1/image.png'];});
  try{
    const saving=saver.save(id,true);await until(()=>parsing);db.updateFeed(feed.id,{allowPrivate:false});release();const result=await saving;
    assert.equal(calls,0);assert.equal(result.status,'partial');assert.match(result.lastError,/网络授权已变化/);assert.equal(db.entry(id).saved,1);
  }finally{release();db.close();rmSync(directory,{recursive:true,force:true});}
});

test('image cache rechecks authorization after queue and lookup waits before starting network requests',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-image-fetch-guard-')),db=new RivuDatabase(join(directory,'rivu.db'));
  let firstStarted=false,releaseFirst,blockedRequests=0;const firstGate=new Promise(resolve=>releaseFirst=resolve);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
  const origin=createServer(async(req,res)=>{if(req.url==='/slow.png'){firstStarted=true;await firstGate;}else blockedRequests++;res.setHeader('content-type','image/png');res.end(png);});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${origin.address().port}`,feed=db.addFeed({title:'源',url:base+'/feed',allowPrivate:true});db.addEntries(feed.id,[{title:'文章',url:base+'/article',hash:'one'}]);const id=db.entries()[0].id,before=db.entry(id),images=new ImageCache(db,undefined,directory);
  const authorize=()=>{assertEntrySourceUnchanged(db,id,before);return base;};
  let releaseLookup;
  try{
    const first=images.cache(base+'/slow.png',base,true);await until(()=>firstStarted);
    const queued=images.cache(base+'/queued.png',base,true,authorize),rejected=assert.rejects(queued,error=>error.statusCode===409);
    db.updateFeed(feed.id,{allowPrivate:false});releaseFirst();assert.equal((await first).cached,true);await rejected;assert.equal(blockedRequests,0);
    for(const method of ['load','loadBytes']){
      db.updateFeed(feed.id,{allowPrivate:true});let lookupStarted=false;const lookupGate=new Promise(resolve=>releaseLookup=resolve);
      images.lookupBytes=async()=>{lookupStarted=true;await lookupGate;return null;};
      const load=images[method](base+'/lookup.png',base,authorize),loadRejected=assert.rejects(load,error=>error.statusCode===409);await until(()=>lookupStarted);db.updateFeed(feed.id,{allowPrivate:false});releaseLookup();await loadRejected;assert.equal(blockedRequests,0);
    }
  }finally{releaseFirst();releaseLookup?.();await images.wait();db.close();await new Promise(resolve=>origin.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
