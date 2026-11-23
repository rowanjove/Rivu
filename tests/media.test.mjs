import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createService } from '../dist-server/service.js';

const require=createRequire(import.meta.url);
const {RivuDatabase}=require('../dist-server/database.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');

test('RSS and JSON media become local image, audio and video views with explicit image caching',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-media-'));let base='';
  const fixture=createServer((req,res)=>{
    if(req.url?.endsWith('.png')){res.setHeader('content-type','image/png');res.end(png);return;}
    if(req.url==='/json'){res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'JSON 媒体源',items:[{id:'json-one',title:'JSON 播客',url:`${base}/json-page`,content_html:`<p>图片</p><img src="${base}/json.png">`,image:`${base}/cover.png`,attachments:[{url:`${base}/podcast.m4a`,mime_type:'audio/mp4',title:'一集播客'}]}]}));return;}
    res.setHeader('content-type','application/rss+xml');res.end(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>RSS 媒体源</title><link>${base}</link><item><title>多媒体文章</title><guid>rss-one</guid><link>${base}/article</link><description><![CDATA[<p>正文图片<img src="${base}/body.png" alt="正文配图"></p>]]></description><media:thumbnail url="${base}/thumbnail.png"/><media:content url="${base}/clip.mp4" medium="video" type="video/mp4"/><enclosure url="${base}/episode.mp3" type="audio/mpeg"/></item></channel></rss>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${fixture.address().port}`;
  const db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'media-token',join(dir,'settings.json'),dir),headers={'x-rivu-token':'media-token'};
  const request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload?{payload}:{})});
  try{
    const rss=await request('POST','/api/feeds',{url:`${base}/rss`,allowPrivate:true});assert.equal(rss.statusCode,201,rss.body);
    const json=await request('POST','/api/feeds',{url:`${base}/json`,allowPrivate:true});assert.equal(json.statusCode,201,json.body);
    const articles=(await request('GET','/api/entries?view=all')).json();assert.equal(articles.length,2);
    const rssEntry=articles.find(item=>item.title==='多媒体文章'),jsonEntry=articles.find(item=>item.title==='JSON 播客');assert.ok(rssEntry&&jsonEntry);
    const rssMedia=(await request('GET',`/api/entries/${rssEntry.id}/media`)).json();assert.deepEqual(new Set(rssMedia.map(item=>item.kind)),new Set(['image','audio','video']));assert.ok(rssMedia.some(item=>item.url===`${base}/body.png`&&item.source==='body'));assert.ok(rssMedia.some(item=>item.url===`${base}/thumbnail.png`));
    const jsonMedia=(await request('GET',`/api/entries/${jsonEntry.id}/media`)).json();assert.ok(jsonMedia.some(item=>item.url===`${base}/podcast.m4a`&&item.kind==='audio'));assert.ok(jsonMedia.some(item=>item.url===`${base}/cover.png`&&item.kind==='image'));
    assert.equal((await request('GET','/api/entries?view=images')).json().length,2);assert.equal((await request('GET','/api/entries?view=audio')).json().length,2);assert.equal((await request('GET','/api/entries?view=video')).json().length,1);
    assert.equal((await request('GET','/api/image-cache/settings')).json().enabled,false);
    const image=await request('POST','/api/image-cache/cache',{entryId:rssEntry.id,url:`${base}/thumbnail.png`,explicit:true});assert.equal(image.json().cached,true,image.body);
    assert.match((await request('GET',`/api/image-cache/lookup?entryId=${rssEntry.id}&url=${encodeURIComponent(`${base}/thumbnail.png`)}`)).json().dataUrl,/^data:image\/png;base64,/);
    const untrustedFeed=db.addFeed({title:'未授权源',url:'https://example.com/untrusted'});db.addEntries(untrustedFeed.id,[{title:'未授权图片',hash:'untrusted-media',media:[{kind:'image',url:`${base}/thumbnail.png`,mime:'image/png',source:'metadata',title:null}]}]);const untrusted=db.entries({feedId:untrustedFeed.id})[0];
    assert.equal((await request('GET',`/api/image-cache/lookup?entryId=${untrusted.id}&url=${encodeURIComponent(`${base}/thumbnail.png`)}`)).statusCode,403,'同 URL 已缓存也不能绕过来源授权');
    assert.equal((await request('GET',`/api/image-cache/load?entryId=${untrusted.id}&url=${encodeURIComponent(`${base}/thumbnail.png`)}`)).statusCode,403);
    assert.equal((await request('POST','/api/image-cache/cache',{entryId:rssEntry.id,url:`${base}/not-in-feed.png`,explicit:true})).statusCode,500);
    const rssDetail=(await request('GET',`/api/entries/${rssEntry.id}`)).json();
    db.addEntries(rssEntry.feed_id,[{title:rssDetail.title,hash:rssDetail.hash,media:[{kind:'video',url:`${base}/recovered.mp4`,mime:'video/mp4',source:'enclosure',title:null}]}]);assert.ok(db.entryMedia(rssEntry.id).some(item=>item.url===`${base}/recovered.mp4`),'重复刷新应更新旧文章的附件元数据');
    db.setFullContent(rssEntry.id,`<p>更新图片<img src="${base}/new.png"></p>`);const after=db.entryMedia(rssEntry.id);assert.ok(after.some(item=>item.url===`${base}/new.png`));assert.ok(!after.some(item=>item.url===`${base}/body.png`));
    const marked=await request('POST','/api/entries/mark-read',{view:'video'});assert.equal(marked.json().changed,1);assert.equal(db.entry(rssEntry.id).read,1);assert.equal(db.entry(jsonEntry.id).read,0);
    db.deleteFeed(rssEntry.feed_id);assert.equal(db.db.prepare('SELECT count(*) n FROM entry_media WHERE entry_id=?').get(rssEntry.id).n,0);
  }finally{await service.stop();db.close();fixture.close();rmSync(dir,{recursive:true,force:true});}
});
