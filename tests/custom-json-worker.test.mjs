import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {refreshFeed} from '../dist-server/feeds.js';
import {FeedParser} from '../dist-server/feed-parser.js';
import {customJsonSourceAdapter,validateJsonMapping} from '../dist-server/custom-json.js';
const worker=resolve('dist-server/feed-parse-worker.cjs');
const mapping=validateJsonMapping({itemsPath:'data.articles',titlePath:'title',idPath:'id',urlPath:'url',datePath:'date',contentPath:'html',summaryPath:'summary',authorPath:'author.name',imagePath:'image'});
const candidate={url:'https://example.com/api',title:'映射来源',mapping};
const response=data=>({bytes:Buffer.from(JSON.stringify(data)),url:'https://example.com/redirected/api',type:'application/json'});
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');

test('custom JSON worker preserves mapped dates, Unicode, raw HTML, relative media, skipped rows and validation status',async()=>{
  const parser=new FeedParser(worker);
  try{
    const fetched=response({data:{articles:[{id:42,title:' 中文 & 标题 ',url:'../article',date:1700000000,html:'<p>原始正文</p><img src="/image.png?a=1&amp;b=2" alt="图片"><img src="javascript:bad">',summary:'摘要',author:{name:'作者'},image:'/cover.png'},{id:'missing-title'},{id:'second',title:'第二篇',url:'http://user:secret@evil.invalid/path',date:'2026-10-01T00:00:00Z'}]}});
    const direct=customJsonSourceAdapter.normalize(await customJsonSourceAdapter.parse(fetched,candidate),candidate),actual=await parser.parseJson(fetched,candidate);
    assert.deepEqual(actual,direct);assert.equal(actual.skipped,1);assert.equal(actual.items[0].guid,'42');assert.equal(actual.items[0].url,'https://example.com/article');assert.equal(actual.items[0].author,'作者');assert.equal(actual.items[0].publishedAt,'2023-11-14T22:13:20.000Z');
    assert.equal(actual.items[0].media.length,2);assert.equal(actual.items[0].media[1].url,'https://example.com/image.png?a=1&b=2');assert.equal(actual.items[1].url,'');
    for(const bad of [{bytes:Buffer.from('{broken'),url:candidate.url,type:'application/json'},response({data:{articles:{}}}),response({data:{articles:[{id:'one'}]}}),response({data:{articles:Array.from({length:1001},(_,id)=>({id,title:'超限'}))}})])await assert.rejects(parser.parseJson(bad,candidate),error=>error.statusCode===400);
    await assert.rejects(parser.parseJson(fetched,{...candidate,mapping:{...mapping,titlePath:'__proto__.secret'}}),error=>error.statusCode===400);
    const root={...candidate,mapping:validateJsonMapping({itemsPath:'$',titlePath:'title',idPath:'id'})};assert.equal((await parser.parseJson(response([{id:'root',title:'根数组'}]),root)).items[0].title,'根数组');
  }finally{await parser.stop();}
});

test('custom JSON worker handles the supported 1000 image articles without losing mapping or media',async()=>{
  const parser=new FeedParser(worker);
  try{
    const result=await parser.parseJson(response({data:{articles:Array.from({length:1000},(_,id)=>({id,title:`图片文章 ${id}`,html:'<p>正文</p><img src="/same.png"><img src="/same.png">'}))}}),candidate);
    assert.equal(result.items.length,1000);assert.equal(result.skipped,0);assert.deepEqual(result.mapping,mapping);for(const item of result.items)assert.equal(item.media.length,1);
  }finally{await parser.stop();}
});

test('RSS and custom JSON previews share at most four workers and stop drains all accepted queued tasks',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-parser-queue-')),path=join(directory,'worker.cjs');
  writeFileSync(path,`const {parentPort,workerData,threadId}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path');const marker=path.join(${JSON.stringify(directory)},'active-'+threadId);fs.writeFileSync(marker,'active');setTimeout(()=>{fs.unlinkSync(marker);parentPort.postMessage({result:{title:'Worker',url:workerData.candidate.url,items:[],skipped:0,mapping:workerData.candidate.mapping}});},350);`);
  const parser=new FeedParser(path);let peak=0;const poll=setInterval(()=>{peak=Math.max(peak,readdirSync(directory).filter(name=>name.startsWith('active-')).length);},10);
  try{
    const jobs=Array.from({length:8},(_,i)=>i%2?parser.parseJson(response({}),candidate):parser.parse({text:'{}',type:'application/json',url:candidate.url},candidate));
    const stopping=parser.stop();await Promise.all(jobs);await stopping;assert.ok(peak>=2);assert.ok(peak<=4);assert.equal(readdirSync(directory).filter(name=>name.startsWith('active-')).length,0);
    await assert.rejects(parser.parseJson(response({}),candidate),/已关闭/);
  }finally{clearInterval(poll);await parser.stop();rmSync(directory,{recursive:true,force:true});}
});

test('parser admission bounds queued jobs and input bytes, then recovers after accepted jobs drain',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-parser-budget-')),path=join(directory,'worker.cjs');
  writeFileSync(path,`const {parentPort,workerData}=require('node:worker_threads');setTimeout(()=>parentPort.postMessage({result:{title:'Worker',url:workerData.candidate.url,items:[],skipped:0,mapping:workerData.candidate.mapping}}),100);`);
  const parser=new FeedParser(path,undefined,2,1024*1024),byteParser=new FeedParser(path,undefined,64,2048);
  const busy=error=>error.statusCode===503&&error.resourceBusy===true;
  try{
    const jobs=Array.from({length:6},()=>parser.parseJson(response({}),candidate));
    await assert.rejects(parser.parseJson(response({}),candidate),busy);
    await Promise.all(jobs);assert.equal((await parser.parseJson(response({}),candidate)).title,'Worker');
    await assert.rejects(byteParser.parseJson({...response({}),bytes:Buffer.alloc(2048)},candidate),busy);
    const accepted=byteParser.parseJson({...response({}),bytes:Buffer.alloc(1100)},candidate);
    await assert.rejects(byteParser.parseJson({...response({}),bytes:Buffer.alloc(1100)},candidate),busy);
    await accepted;assert.equal((await byteParser.parseJson(response({}),candidate)).title,'Worker');
  }finally{await Promise.all([parser.stop(),byteParser.stop()]);rmSync(directory,{recursive:true,force:true});}
});

test('local parser overload preserves article state and source health while ordinary failures still record health',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-parser-health-')),db=new RivuDatabase(join(directory,'rivu.db'));
  const origin=createServer((_req,res)=>{res.setHeader('content-type','application/feed+json');res.end('{}');});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
  try{
    const feed=db.addFeed({title:'本地源',url:`http://127.0.0.1:${origin.address().port}/feed`,allowPrivate:true});
    db.addEntries(feed.id,[{title:'保留文章',content:'正文',hash:'old'}]);const entry=db.entries()[0];db.updateEntry(entry.id,{read:true,saved:true});db.markFetch(feed.id);
    const beforeFeed=db.feed(feed.id),beforeEntries=db.entries();
    await assert.rejects(refreshFeed(db,feed.id,async()=>{throw Object.assign(Error('来源解析繁忙'),{statusCode:503,resourceBusy:true});}),error=>error.resourceBusy);
    assert.deepEqual(db.feed(feed.id),beforeFeed);assert.deepEqual(db.entries(),beforeEntries);
    await assert.rejects(refreshFeed(db,feed.id,async()=>{throw Error('来源格式无效');}),/来源格式无效/);
    assert.equal(db.feed(feed.id).last_error,'来源格式无效');assert.deepEqual(db.entries(),beforeEntries);
  }finally{db.close();await new Promise(resolve=>origin.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
