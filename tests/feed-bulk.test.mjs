import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createService } from '../dist-server/service.js';

const require=createRequire(import.meta.url);
const {RivuDatabase}=require('../dist-server/database.cjs');

test('bulk feed management is atomic, previews deletion and preserves independent archives',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-feed-bulk-')),db=new RivuDatabase(join(dir,'rivu.db'));
  const category=db.addCategory('研究'),first=db.addFeed({title:'一号',url:'https://example.com/one'}),second=db.addFeed({title:'二号',url:'https://example.com/two'}),untouched=db.addFeed({title:'三号',url:'https://example.com/three'});
  db.addEntries(first.id,[{title:'文章一',content:'正文一',hash:'one'}]);
  db.addEntries(second.id,[{title:'文章二',content:'正文二',hash:'two'}]);
  const entry=db.entries({feedId:first.id})[0];
  db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('archive-one',entry.id,first.id,'一号','文章一',null,new Date().toISOString(),new Date().toISOString());
  const service=createService(db,'bulk-token'),headers={'x-rivu-token':'bulk-token'};
  const post=(url,payload)=>service.app.inject({method:'POST',url,headers,payload});
  const ids=[first.id,second.id];
  try{
    assert.equal((await service.app.inject({method:'POST',url:'/api/feeds/bulk',payload:{ids,action:'pause',enabled:false}})).statusCode,401);
    assert.equal((await post('/api/feeds/bulk',{ids:[first.id,first.id],action:'pause',enabled:false})).statusCode,400);
    assert.equal((await post('/api/feeds/bulk',{ids,action:'interval',fetchInterval:7})).statusCode,400);
    assert.equal((await post('/api/feeds/bulk',{ids,action:'category',categoryId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})).statusCode,404);
    assert.equal(db.feed(first.id).category_id,null);assert.equal(db.feed(second.id).category_id,null);
    assert.equal((await post('/api/feeds/bulk',{ids,action:'category',categoryId:category.id})).statusCode,200);
    assert.equal(db.feed(first.id).category_id,category.id);assert.equal(db.feed(second.id).category_id,category.id);assert.equal(db.feed(untouched.id).category_id,null);
    assert.equal((await post('/api/feeds/bulk',{ids,action:'interval',fetchInterval:60})).statusCode,200);
    assert.equal(db.feed(first.id).fetch_interval,60);assert.equal(db.feed(second.id).fetch_interval,60);assert.equal(db.feed(untouched.id).fetch_interval,30);
    assert.ok(Date.parse(db.feed(first.id).next_fetch_at)>Date.now()+50*60_000);
    assert.equal((await post('/api/feeds/bulk',{ids,action:'pause',enabled:false})).statusCode,200);
    assert.equal(db.feed(first.id).enabled,0);assert.equal(db.feed(second.id).enabled,0);assert.equal(db.feed(untouched.id).enabled,1);
    const preview=(await post('/api/feeds/bulk-delete-preview',{ids})).json();
    assert.deepEqual(preview,{feedsToDelete:2,entriesToDelete:2,archivesPreserved:1});
    db.addEntries(first.id,[{title:'新文章',content:'新正文',hash:'new-one'}]);
    const stale=await post('/api/feeds/bulk',{ids,action:'delete',expected:preview});
    assert.equal(stale.statusCode,409,stale.body);assert.equal(db.feeds().length,3);
    const current=(await post('/api/feeds/bulk-delete-preview',{ids})).json();
    const deleted=await post('/api/feeds/bulk',{ids,action:'delete',expected:current});
    assert.equal(deleted.statusCode,200,deleted.body);assert.equal(deleted.json().changed,2);
    assert.equal(db.feed(first.id),undefined);assert.equal(db.feed(second.id),undefined);assert.ok(db.feed(untouched.id));
    assert.equal(db.db.prepare('SELECT count(*) count FROM permanent_archives').get().count,1);
    assert.equal(db.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('single-feed delete rechecks preview after an in-flight refresh',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-feed-delete-race-')),db=new RivuDatabase(join(dir,'rivu.db'));
  let releaseResponse,requestArrived;
  const responseGate=new Promise(resolve=>{releaseResponse=resolve;});
  const arrived=new Promise(resolve=>{requestArrived=resolve;});
  const rss=createServer(async(_req,res)=>{requestArrived();await responseGate;res.setHeader('content-type','application/rss+xml');res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>竞态源</title><link>https://example.com</link><item><title>新增文章</title><guid>new-during-delete</guid><description>正文</description></item></channel></rss>');});
  await new Promise(resolve=>rss.listen(0,'127.0.0.1',resolve));
  const feed=db.addFeed({title:'竞态源',url:`http://127.0.0.1:${rss.address().port}/feed`,allowPrivate:true});
  db.addEntries(feed.id,[{title:'已有文章',content:'正文',hash:'existing'}]);
  const service=createService(db,'delete-race-token'),headers={'x-rivu-token':'delete-race-token'};
  try{
    const refreshing=service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});
    await arrived;
    const preview=(await service.app.inject({method:'GET',url:`/api/feeds/${feed.id}/delete-preview`,headers})).json();
    assert.equal(preview.entriesToDelete,1);
    const deleting=service.app.inject({method:'DELETE',url:`/api/feeds/${feed.id}`,headers,payload:{expected:{entriesToDelete:preview.entriesToDelete,archivesPreserved:preview.archivesPreserved}}});
    await new Promise(resolve=>setTimeout(resolve,30));
    const blocked=await service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});
    assert.equal(blocked.statusCode,409,blocked.body);
    releaseResponse();
    assert.equal((await refreshing).statusCode,200);
    const rejected=await deleting;assert.equal(rejected.statusCode,409,rejected.body);
    assert.ok(db.feed(feed.id));assert.equal(db.entries({feedId:feed.id}).length,2);
    const legacy=await service.app.inject({method:'DELETE',url:`/api/feeds/${feed.id}`,headers});
    assert.equal(legacy.statusCode,400,'没有确认范围的旧接口不能删除');
  }finally{releaseResponse();await service.stop();db.close();rss.close();rmSync(dir,{recursive:true,force:true});}
});
