import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { discoverFeeds, parseFeed, sourceFeedCandidates } from '../dist-server/feeds.js';
import { privateAddress } from '../server/network.ts';

test('network guard rejects IPv6 local ranges before connecting',()=>{
  for(const address of ['::','::1','0:0:0:0:0:0:0:0','0:0:0:0:0:0:0:1','::7f00:1','fc00::1','fdff::1','fe80::1','febf::1','fec0::1','feff::1','ff02::1','::ffff:192.168.1.1','0:0:0:0:0:ffff:c0a8:101'])
    assert.equal(privateAddress(address),true,address);
  assert.equal(privateAddress('2606:4700:4700::1111'),false);
  assert.equal(privateAddress('::ffff:8.8.8.8'),false);
});

test('discovery preserves an initial network refusal without bypassing private-address protection',async()=>{
 let hits=0;const fixture=createServer((_req,res)=>{hits++;res.end('must not connect');});await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
 try{await assert.rejects(discoverFeeds(`http://127.0.0.1:${fixture.address().port}/podcast.rss`),/未发现 RSS、Atom 或 JSON Feed；初始地址检查失败：禁止访问本机或内网地址/);assert.equal(hits,0);}
 finally{await new Promise(done=>fixture.close(done));}
});

test('an initial HTTP failure still permits conventional feed discovery and ordinary pages retain a neutral no-feed result',async()=>{
 let mode='fallback';const fixture=createServer((req,res)=>{
  if(mode==='fallback'&&req.url==='/feed'){res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>Fallback feed</title><item><title>Found</title><guid>one</guid></item></channel></rss>');return;}
  if(req.url==='/empty'){res.setHeader('content-type','text/html');res.end('<!DOCTYPE html><html><head><title>No feed</title></head><body>Page</body></html>');return;}
  res.statusCode=404;res.end('not found');
 });await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
 const base=`http://127.0.0.1:${fixture.address().port}`;
 try{
  const found=await discoverFeeds(base+'/missing',true);assert.equal(found[0].title,'Fallback feed');
  mode='empty';await assert.rejects(discoverFeeds(base+'/empty',true),{message:'未发现 RSS、Atom 或 JSON Feed'});
  await assert.rejects(discoverFeeds(base+'/missing',true),/初始地址检查失败：HTTP 404/);
 }finally{await new Promise(done=>fixture.close(done));}
});

test('public source pages map to explicit Atom feeds without broad host matching',()=>{
  const candidates=value=>sourceFeedCandidates(new URL(value));
  assert.deepEqual(candidates('https://github.com/RSSNext/Folo'),[
    'https://github.com/RSSNext/Folo/releases.atom',
    'https://github.com/RSSNext/Folo/commits.atom',
  ]);
  assert.deepEqual(candidates('https://github.com/RSSNext/Folo/releases/tag/v1.0'),['https://github.com/RSSNext/Folo/releases.atom']);
  assert.deepEqual(candidates('https://github.com/RSSNext/Folo/commits/main'),['https://github.com/RSSNext/Folo/commits.atom']);
  const channel='UC'+ 'a'.repeat(22);
  assert.deepEqual(candidates(`https://www.youtube.com/channel/${channel}/videos`),[`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`]);
  for(const value of [
    'http://github.com/RSSNext/Folo',
    'https://github.com.evil.example/RSSNext/Folo',
    'https://github.com:444/RSSNext/Folo',
    'https://github.com/RSSNext%2Fevil/Folo',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com.evil.example/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
  ])assert.deepEqual(candidates(value),[],value);
});

test('GitHub and YouTube Atom items use the existing local feed parser',async()=>{
  const atom=`<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>项目发布</title><entry><id>tag:example.com,2026:release-1</id><title>v1.0</title><link href="https://github.com/example/project/releases/tag/v1.0"/><updated>2026-09-27T01:00:00Z</updated><content type="html">更新内容</content></entry></feed>`;
  const youtube=`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>频道视频</title><entry><id>yt:video:one</id><yt:videoId>one</yt:videoId><title>第一期</title><link rel="alternate" href="https://www.youtube.com/watch?v=one"/><published>2026-09-27T01:00:00Z</published></entry></feed>`;
  const fixture=createServer((req,res)=>{
    if(req.url==='/handle'){
      res.setHeader('content-type','text/html');
      res.end(`<html><head><link rel="alternate" type="application/rss+xml" href="http://localhost:${fixture.address().port}/youtube"></head></html>`);
      return;
    }
    if(req.url==='/old-handle'){res.writeHead(302,{location:'/nested/channel/'});res.end();return;}
    if(req.url==='/nested/channel/'){
      res.setHeader('content-type','text/html');
      res.end('<html><head><link rel="alternate" type="application/atom+xml" href="videos.xml"></head></html>');
      return;
    }
    if(!['/github','/youtube','/nested/channel/videos.xml'].includes(req.url)){res.statusCode=404;res.end();return;}
    res.setHeader('content-type','application/atom+xml');res.end(req.url==='/github'?atom:youtube);
  });
  await new Promise(resolve=>fixture.listen(0,'::',resolve));
  try{
    const origin=`http://localhost:${fixture.address().port}`;
    const release=await parseFeed(`${origin}/github`,origin);
    const video=await parseFeed(`${origin}/youtube`,origin);
    assert.equal(release.items[0].title,'v1.0');
    assert.equal(release.items[0].url,'https://github.com/example/project/releases/tag/v1.0');
    assert.equal(video.items[0].title,'第一期');
    assert.equal(video.items[0].url,'https://www.youtube.com/watch?v=one');
    const handle=await discoverFeeds(`${origin}/handle`,true);
    assert.deepEqual(handle.map(feed=>feed.url),[`${origin}/youtube`]);
    const redirected=await discoverFeeds(`${origin}/old-handle`,true);
    assert.deepEqual(redirected.map(feed=>feed.url),[`${origin}/nested/channel/videos.xml`]);
  }finally{await new Promise(resolve=>fixture.close(resolve));}
});
