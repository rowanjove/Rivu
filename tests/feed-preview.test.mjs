import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { discoverFeeds, parseFeed } from '../dist-server/feeds.js';
import { createService } from '../dist-server/service.js';
import { createBackup, restoreBackup } from '../dist-server/backup.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));

test('manual icon update fills legacy sources, coalesces calls and preserves snapshots on failures and changed permission',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-icon-update-'));let iconRequests=0,releaseIcon,iconStarted;
  const fixture=createServer((req,res)=>{
    const origin=`http://127.0.0.1:${fixture.address().port}`;
    if(req.url==='/icon'){iconRequests++;const send=()=>{res.setHeader('content-type','image/png');res.end(png);};if(releaseIcon===null){releaseIcon=send;iconStarted?.();}else send();return;}
    if(req.url==='/site'){res.setHeader('content-type','text/html');res.end('<link rel="icon" href="/icon">');return;}
    res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>旧来源</title>${req.url==='/missing'?'':`<link>${origin}/site</link>`}</channel></rss>`);
  });await listen(fixture);
  const origin=`http://127.0.0.1:${fixture.address().port}`,db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'icon-token'),headers={'x-rivu-token':'icon-token'};
  const post=id=>service.app.inject({method:'POST',url:`/api/feeds/${id}/icon`,headers});
  try{
    const feed=db.addFeed({url:origin+'/feed',title:'旧来源',allowPrivate:true});
    releaseIcon=null;const started=new Promise(resolve=>{iconStarted=resolve;});
    const first=post(feed.id);await started;const second=post(feed.id);await new Promise(resolve=>setTimeout(resolve,20));releaseIcon();
    assert.equal((await first).statusCode,200);assert.equal((await second).statusCode,200);assert.equal(iconRequests,1);
    const saved=db.feed(feed.id).icon;assert.match(saved,/^data:image\/png;base64,/);
    db.addEntries(feed.id,Array.from({length:100},(_,i)=>({title:`文章${i}`,hash:String(i)})));
    const rows=(await service.app.inject({url:'/api/entries?limit=100',headers})).json();
    assert.equal(rows.length,100);assert.ok(rows.every(row=>!('feed_icon' in row)));assert.ok(JSON.stringify(rows).length<100000);
    const missing=db.addFeed({url:origin+'/missing',title:'没有图标',allowPrivate:true,icon:saved});
    assert.equal((await post(missing.id)).statusCode,422);assert.equal(db.feed(missing.id).icon,saved);
    releaseIcon=null;const changedStarted=new Promise(resolve=>{iconStarted=resolve;});const changed=post(feed.id);await changedStarted;
    db.updateFeed(feed.id,{allowPrivate:false});releaseIcon();assert.equal((await changed).statusCode,409);assert.equal(db.feed(feed.id).icon,saved);
    assert.equal((await post('absent')).statusCode,404);
    const json=db.addFeed({url:origin+'/json',title:'JSON API',type:'custom_json'});const before=iconRequests;
    assert.equal((await post(json.id)).statusCode,400);assert.equal(iconRequests,before);
    db.updateFeed(feed.id,{allowPrivate:true});releaseIcon=null;const deletedStarted=new Promise(resolve=>{iconStarted=resolve;});const deleted=post(feed.id);await deletedStarted;db.deleteFeed(feed.id);releaseIcon();assert.equal((await deleted).statusCode,404);
  }finally{await service.stop();db.close();await close(fixture);rmSync(dir,{recursive:true,force:true});}
});

test('feed preview snapshots bounded raster icons without widening private source authorization',async()=>{
  let icons=0,crossRequests=0;const cross=createServer((_req,res)=>{crossRequests++;res.setHeader('content-type','image/png');res.end(png);});await listen(cross);
  const fixture=createServer((req,res)=>{
    const origin=`http://127.0.0.1:${fixture.address().port}`;
    if(req.url==='/icon'){icons++;res.setHeader('content-type','image/png');res.end(png);return;}
    if(req.url==='/svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>');return;}
    if(req.url==='/large'){res.setHeader('content-type','image/png');res.end(Buffer.alloc(256*1024+1));return;}
    if(req.url==='/website'){res.setHeader('content-type','text/html');res.end('<html><head><link rel="icon" href="/icon"><link rel="alternate" type="application/rss+xml" href="/no-icon"></head></html>');return;}
    if(req.url==='/no-icon'){res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>无图标Feed</title></channel></rss>');return;}
    if(req.url==='/json'){res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'JSON 来源',icon:'/icon',items:[]}));return;}
    if(req.url==='/atom'){res.setHeader('content-type','application/atom+xml');res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 来源</title><icon>${origin}/icon</icon><entry><id>one</id><title>第一篇</title></entry></feed>`);return;}
    const icon=req.url==='/cross'?`http://127.0.0.1:${cross.address().port}/icon`:origin+({ '/svg-feed':'/svg','/large-feed':'/large' }[req.url]||'/icon');
    res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>预览来源</title><description>来源描述</description><link>${origin}/site</link><image><url>${icon}</url><title>来源</title><link>${origin}</link></image><item><guid>one</guid><title>第一篇</title></item></channel></rss>`);
  });await listen(fixture);const origin=`http://127.0.0.1:${fixture.address().port}`;
  try{
    assert.equal((await parseFeed(`${origin}/feed`,origin)).icon,undefined);assert.equal(icons,0,'后台刷新解析不应读取图标');
    for(const path of ['/feed','/json','/atom','/website']){
      const preview=(await discoverFeeds(origin+path,true))[0];assert.equal(preview.icon,`data:image/png;base64,${png.toString('base64')}`);
    }
    for(const path of ['/cross','/svg-feed','/large-feed']){
      const preview=(await discoverFeeds(origin+path,true))[0];assert.equal(preview.title,'预览来源');assert.equal(preview.icon,undefined,'图标失败不能阻断订阅预览');
    }
    assert.equal(crossRequests,0,'原私网源授权不得覆盖另一端口的图标');
  }finally{await close(fixture);await close(cross);}
});

test('preview frequency is validated before fetching and survives RSS RSSHub JSON subscriptions and backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-preview-frequency-'));let requests=0;
  const fixture=createServer((req,res)=>{requests++;const origin=`http://127.0.0.1:${fixture.address().port}`;if(req.url==='/icon'){res.setHeader('content-type','image/png');res.end(png);return;}if(req.url==='/json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{id:'one',title:'JSON 第一篇'}]}));return;}res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>预览源</title><description>保留描述</description><link>${origin}/site</link><image><url>${origin}/icon</url><title>预览源</title><link>${origin}</link></image><item><title>第一篇</title><guid>one</guid></item></channel></rss>`);});await listen(fixture);
  const origin=`http://127.0.0.1:${fixture.address().port}`,db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'preview-token'),headers={'x-rivu-token':'preview-token'};
  const post=(url,payload)=>service.app.inject({method:'POST',url,headers,payload});
  try{
    for(const value of [-1,7,30.5,'60',null])assert.equal((await post('/api/feeds',{url:origin+'/feed',allowPrivate:true,fetchInterval:value})).statusCode,400);
    assert.equal(requests,0);assert.equal(db.feeds().length,0);
    const rss=(await post('/api/feeds',{url:origin+'/feed',allowPrivate:true,fetchInterval:60})).json();assert.equal(rss.fetch_interval,60);assert.match(rss.icon,/^data:image\/png;base64,/);
    const instance=db.addRsshubInstance('本地实例',origin,true);
    const before=requests;assert.equal((await post('/api/rsshub/subscribe',{instanceId:instance.id,route:'/route',fetchInterval:7})).statusCode,400);assert.equal(requests,before);
    const hub=(await post('/api/rsshub/subscribe',{instanceId:instance.id,route:'/route',fetchInterval:0})).json();assert.equal(hub.fetch_interval,0);assert.equal(hub.icon,rss.icon);
    const json=(await post('/api/feeds/custom-json',{url:origin+'/json',title:'JSON',allowPrivate:true,mapping:{itemsPath:'items',titlePath:'title',idPath:'id'},fetchInterval:180})).json();assert.equal(json.fetch_interval,180);
    assert.equal((await service.app.inject({method:'PATCH',url:`/api/feeds/${rss.id}`,headers,payload:{fetchInterval:7}})).statusCode,400);assert.equal(db.feed(rss.id).fetch_interval,60);
    const backup=join(dir,'snapshot.zip'),restored=join(dir,'restored');await createBackup(db,dir,backup);await restoreBackup(backup,restored);const copy=new RivuDatabase(join(restored,'rivu.db'));
    try{assert.equal(copy.feed(rss.id).icon,rss.icon);assert.equal(copy.feed(rss.id).fetch_interval,60);assert.equal(copy.feed(hub.id).fetch_interval,0);assert.equal(copy.feed(json.id).fetch_interval,180);}finally{copy.close();}
  }finally{await service.stop();db.close();await close(fixture);rmSync(dir,{recursive:true,force:true});}
});
