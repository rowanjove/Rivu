import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {FeedParser} from '../dist-server/feed-parser.js';
import {rssSourceAdapter} from '../dist-server/feeds.js';
import {createService} from '../dist-server/service.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
const worker=resolve('dist-server/feed-parse-worker.cjs');

test('worker parsing preserves RSS/Atom and JSON Feed normalization, including relative media and raw body',async()=>{
  const parser=new FeedParser(worker),candidate={url:'https://example.com/feed'};
  try{
    const samples=[
      {type:'application/rss+xml',text:'<rss version="2.0"><channel><title>RSS源</title><link>https://example.com</link><item><guid>one</guid><title>文章</title><link>https://example.com/a</link><description><![CDATA[<p>正文</p><img src="/a.png">]]></description><enclosure url="https://example.com/a.mp3" type="audio/mpeg"/></item></channel></rss>'},
      {type:'application/atom+xml',text:'<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom源</title><entry><id>atom-one</id><title>Atom文章</title><link href="https://example.com/atom"/><content type="html">&lt;p&gt;正文&lt;/p&gt;</content></entry></feed>'},
      {type:'application/feed+json',text:JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'JSON源',items:[{id:'json-one',title:'JSON文章',url:'https://example.com/json',content_html:'<p>原文</p><img src="/image.png">',attachments:[{url:'/audio.mp3',mime_type:'audio/mpeg'}]}]})}
    ];
    for(const sample of samples){const response={...sample,url:candidate.url};const parsed=await rssSourceAdapter.parse(response,candidate);assert.deepEqual(await parser.parse(response,candidate),rssSourceAdapter.normalize(parsed,candidate));}
    const bulk=await parser.parse({type:'application/feed+json',url:candidate.url,text:JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'批量图片正文',items:Array.from({length:600},(_,i)=>({id:String(i),url:`https://example.com/${i}`,content_html:'<p>正文</p><img src="/image.png?a=1&amp;b=2" alt=" 图片 "><img src="/image.png?a=1&amp;b=2"><img src="javascript:bad">'}))})},candidate);
    assert.equal(bulk.items.length,600);for(const item of bulk.items){assert.equal(item.media.length,1);assert.equal(item.media[0].url,'https://example.com/image.png?a=1&b=2');assert.equal(item.media[0].title,'图片');}
    await assert.rejects(parser.parse({type:'application/json',text:'{broken',url:candidate.url},candidate));
  }finally{await parser.stop();}
  await assert.rejects(parser.parse({text:'{}',type:'application/json',url:candidate.url},candidate),/已关闭/);
});

test('worker failures and exit without result reject, and stop drains already accepted jobs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-worker-exit-')),candidate={url:'https://example.com/feed'},response={text:'{}',type:'application/json',url:candidate.url};
  try{
    const exitPath=join(dir,'exit.cjs');writeFileSync(exitPath,'process.exit(0)');const exited=new FeedParser(exitPath);
    await assert.rejects(exited.parse(response,candidate),/来源解析进程退出/);await exited.stop();
    const broken=new FeedParser(join(dir,'missing.cjs'));await assert.rejects(broken.parse(response,candidate));await broken.stop();
    const parser=new FeedParser(worker);const job=parser.parse({text:JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'等待中的源',items:[]}),type:'application/json',url:candidate.url},candidate);
    const stopping=parser.stop();assert.equal((await job).title,'等待中的源');await stopping;await assert.rejects(parser.parse(response,candidate),/已关闭/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('service parser failure preserves existing articles and local state, records failure and permits retry',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-worker-service-'));let valid=false;const origin=createServer((_req,res)=>{res.setHeader('content-type','application/feed+json');res.end(valid?JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'本地源',items:[{id:'new',title:'新文章',url:'https://example.com/new',content_html:'<p>新正文</p><img src="/image.png">'}]}):'{broken');});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'token');
  try{
    const feed=db.addFeed({title:'旧源',url:`http://127.0.0.1:${origin.address().port}/feed`,allowPrivate:true});db.addEntries(feed.id,[{title:'旧文章',content:'保留正文',hash:'old'}]);const entry=db.entries()[0];db.updateEntry(entry.id,{read:true,starred:true,saved:true});const before=db.entry(entry.id);
    const request=()=>service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers:{'x-rivu-token':'token'}});
    assert.equal((await request()).statusCode,500);assert.equal(db.entries().length,1);assert.deepEqual(db.entry(entry.id),before);assert.equal(db.feed(feed.id).failure_count,1);
    valid=true;const result=await request();assert.equal(result.statusCode,200,result.body);assert.equal(result.json().added,1);assert.equal(db.entries().length,2);assert.deepEqual(db.entry(entry.id),before);assert.equal(db.feed(feed.id).failure_count,0);
  }finally{await service.stop();db.close();await new Promise(resolve=>origin.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
