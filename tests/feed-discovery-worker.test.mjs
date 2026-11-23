import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {FeedParser} from '../dist-server/feed-parser.js';
import {createService} from '../dist-server/service.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
async function fixture(parseWorker,writeWorker){
  const directory=mkdtempSync(join(tmpdir(),'rivu-discovery-worker-')),db=new RivuDatabase(join(directory,'rivu.db'));
  let base;const origin=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/site/page'});res.end();return;}
    if(req.url==='/site/page'){res.setHeader('content-type','text/html');res.end('<link rel="alternate" type="application/feed+json" href="../feed"><link rel="icon" href="../pixel.png">');return;}
    if(req.url==='/homepage'){res.setHeader('content-type','text/html');res.end('<link rel="alternate" type="application/rss+xml" href="http://["><link rel="icon" href="/bad-icon"><link rel="shortcut icon" href="/pixel.png">');return;}
    if(req.url==='/pixel.png'){res.setHeader('content-type','image/png');res.end(png);return;}
    if(['/feed','/rsshub','/no-icon'].includes(req.url)){res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'Worker源',home_page_url:base+'/homepage',...(req.url==='/no-icon'?{}:{icon:'/pixel.png'}),items:[{id:'one',title:'预览文章',content_html:'<p>正文</p><img src="/pixel.png">'}]}));return;}
    res.statusCode=404;res.end('missing');
  });
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${origin.address().port}`;
  const service=createService(db,'token',undefined,undefined,undefined,undefined,parseWorker,undefined,writeWorker,resolve('dist-server/feed-write-task.cjs'));
  const request=(path,payload)=>service.app.inject({method:'POST',url:path,headers:{'x-rivu-token':'token'},payload});
  return {directory,db,origin,base,service,request};
}
async function cleanup(f){await f.service.stop();f.db.close();await new Promise(resolve=>f.origin.close(resolve));rmSync(f.directory,{recursive:true,force:true});}

test('worker page metadata preserves redirect-relative links and all safe icon fallbacks',async()=>{
  const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));
  try{
    const data=await parser.parsePage({url:'https://example.com/path/page',type:'text/html',text:'<link rel="icon" href="javascript:bad"><link rel="icon" href="/bad.png"><link rel="shortcut icon" href="good.png"><link rel="alternate" type="application/rss+xml" href="../feed">'},{url:'https://example.com/original'});
    assert.deepEqual(data.feedUrls,['https://example.com/feed']);assert.deepEqual(data.iconUrls,['https://example.com/bad.png','https://example.com/path/good.png']);assert.equal(data.sourceIcon,data.iconUrls[0]);
  }finally{await parser.stop();}
});

test('service discovery and icon refresh use worker metadata while parent fetch keeps authorization and fallback',async()=>{
  const f=await fixture();
  try{
    assert.notEqual((await f.request('/api/feeds/discover',{url:f.base+'/redirect'})).statusCode,200);
    const found=await f.request('/api/feeds/discover',{url:f.base+'/redirect',allowPrivate:true});assert.equal(found.statusCode,200,found.body);
    const previews=found.json(),selected=previews.find(item=>item.url===f.base+'/feed');assert.ok(selected);assert.match(selected.icon,/^data:image\/png;base64,/);assert.equal(selected.items[0].title,'预览文章');assert.equal('sourceIcon' in selected,false);
    const feed=f.db.addFeed({title:'无图标源',url:f.base+'/no-icon',allowPrivate:true});
    const updated=await f.request(`/api/feeds/${feed.id}/icon`);assert.equal(updated.statusCode,200,updated.body);assert.match(f.db.feed(feed.id).icon,/^data:image\/png;base64,/);
  }finally{await cleanup(f);}
});

test('RSSHub subscription uses the coordinated write worker and waits for its committed articles',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-rsshub-write-')),path=join(directory,'worker.cjs'),marker=join(directory,'wrote');
  writeFileSync(path,`const {parentPort,workerData}=require('node:worker_threads');const {writeFeedBatch}=require(workerData.modulePath);parentPort.on('message',input=>{try{const result=writeFeedBatch(input);require('node:fs').writeFileSync(${JSON.stringify(marker)},'committed');parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:error.message});}});`);
  const f=await fixture(undefined,path);
  try{
    const instance=f.db.addRsshubInstance('本地RSSHub',f.base,true),result=await f.request('/api/rsshub/subscribe',{instanceId:instance.id,route:'/rsshub'});
    assert.equal(result.statusCode,201,result.body);assert.ok(existsSync(marker));assert.equal(f.db.entries({feedId:result.json().id}).length,1);
  }finally{await cleanup(f);rmSync(directory,{recursive:true,force:true});}
});

test('discovery, icon refresh and RSSHub preview reject worker failures without changing stored data',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-discovery-failure-')),path=join(directory,'worker.cjs');
  writeFileSync(path,`require('node:worker_threads').parentPort.postMessage({error:'解析Worker拒绝',statusCode:503});`);
  const f=await fixture(path);
  try{
    const feed=f.db.addFeed({title:'保留源',url:f.base+'/feed',allowPrivate:true}),before=f.db.feed(feed.id),instance=f.db.addRsshubInstance('本地RSSHub',f.base,true);
    for(const [url,payload] of [['/api/feeds/discover',{url:f.base+'/feed',allowPrivate:true}],[`/api/feeds/${feed.id}/icon`,{}],['/api/rsshub/preview',{instanceId:instance.id,route:'/rsshub'}]]){const result=await f.request(url,payload);assert.equal(result.statusCode,503,result.body);}
    assert.deepEqual(f.db.feed(feed.id),before);assert.equal(f.db.entries().length,0);
  }finally{await cleanup(f);rmSync(directory,{recursive:true,force:true});}
});
