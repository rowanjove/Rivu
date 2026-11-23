import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createService } from '../dist-server/service.js';
import { createBackup,restoreBackup } from '../dist-server/backup.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');

test('reviewed AI filtering changes only local visibility, is reversible and respects rules, previews, backups and stale confirmations',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-filter-')),db=await RivuDatabase.open(join(dir,'rivu.db')),requests=[];
  let content=JSON.stringify({decision:'mute',reason:'正文是广告而非研究证据'}),sequence=0;
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content}}]}));});await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let service=createService(db,'filter-token',join(dir,'settings.json'));
  const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'filter-token'},...(payload!==undefined?{payload}:{})});
  try{
    const feed=db.addFeed({title:'研究订阅',url:'https://example.com/filter'});db.addEntries(feed.id,[{title:'待审阅广告',content:'广告宣传，没有研究证据。',hash:'filter'},{title:'另一篇',content:'实际研究数据。',hash:'other-filter'}]);const id=db.entries().find(e=>e.title==='待审阅广告').id,other=db.entries().find(e=>e.id!==id).id;
    db.updateEntry(id,{starred:true,saved:true});const tag=db.addTag('保留的标签');db.setEntryTags(id,[tag.id]);await request('POST',`/api/entries/${id}/archive`,{});
    const before=db.entry(id),tags=db.entryTags(id);
    for(const value of [null,123,'x'.repeat(1001)])assert.equal((await request('PATCH','/api/ai/settings',{filterCriteria:value})).statusCode,400);
    assert.equal((await request('GET',`/api/entries/${id}/ai/preview?type=filter`)).statusCode,400);
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'default',askModel:'filter-model',filterCriteria:'没有研究证据的广告建议静音',contextLength:4096,maxTokens:500});
    assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'filter'})).statusCode,409);assert.equal(requests.length,0);
    const generate=async decision=>{
      content=JSON.stringify({decision,reason:`正文依据支持${decision}`});await request('PATCH','/api/ai/settings',{filterCriteria:`审阅研究证据 ${++sequence}`});
      const p=(await request('GET',`/api/entries/${id}/ai/preview?type=filter`)).json(),count=requests.length;
      assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'filter',scopeHash:p.scopeHash})).statusCode,200);
      assert.equal(requests.length,count+1);assert.equal(requests.at(-1).messages[0].content,p.systemPrompt);assert.equal(requests.at(-1).messages[1].content,p.prompt);assert.equal(requests.at(-1).model,'filter-model');
      return (await request('GET',`/api/entries/${id}/ai/filter-review`)).json();
    };
    let review=await generate('mute');assert.equal(review.effect,null);assert.equal(db.entries({view:'unread'}).length,2,'生成建议不改变可见性');
    const apply=hash=>request('POST',`/api/entries/${id}/ai/filter-review/apply`,{reviewHash:hash}),undo=hash=>request('POST',`/api/entries/${id}/ai/filter-review/undo`,{undoHash:hash});
    assert.equal((await apply('forged')).statusCode,409);assert.equal((await request('POST',`/api/entries/${other}/ai/filter-review/apply`,{reviewHash:review.reviewHash})).statusCode,409);
    db.db.exec("CREATE TRIGGER fail_filter_insert BEFORE INSERT ON ai_filter_decisions BEGIN SELECT RAISE(ABORT,'filter failure'); END");assert.equal((await apply(review.reviewHash)).statusCode,500);assert.equal(db.filterDecision(id),undefined);db.db.exec('DROP TRIGGER fail_filter_insert');
    const count=requests.length;assert.equal((await apply(review.reviewHash)).statusCode,200);assert.equal(requests.length,count);
    assert.deepEqual(db.entries({view:'unread'}).map(e=>e.id),[other]);assert.equal(db.feeds()[0].unread_count,1);assert.equal(db.entries({view:'all'}).length,2);assert.deepEqual(db.entries({query:'is:muted'}).map(e=>e.id),[id]);
    assert.equal((await apply(review.reviewHash)).statusCode,409,'另一次本地状态变化使旧确认失效');review=(await request('GET',`/api/entries/${id}/ai/filter-review`)).json();assert.equal((await apply(review.reviewHash)).statusCode,200);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_filter_decisions').get().n,1);
    const rule=(await request('POST','/api/rules',{name:'独立静音规则',conditions:{titleKeyword:'待审阅广告'},action:{type:'mute'}})).json();await request('POST',`/api/rules/${rule.id}/apply`,{});
    review=(await request('GET',`/api/entries/${id}/ai/filter-review`)).json();assert.equal((await undo(review.undoHash)).statusCode,200);assert.equal(db.entries({view:'unread'}).some(e=>e.id===id),false,'撤销AI过滤保留其他规则效果');await request('DELETE',`/api/rules/${rule.id}`);assert.equal(db.entries({view:'unread'}).length,2);
    review=await generate('block');assert.equal((await apply(review.reviewHash)).statusCode,200);review=(await request('GET',`/api/entries/${id}/ai/filter-review`)).json();
    assert.deepEqual(db.entries({view:'blocked'}).map(e=>e.id),[id]);assert.deepEqual(db.entries({query:'is:blocked'}).map(e=>e.id),[id]);assert.deepEqual(db.entries({view:'all'}).map(e=>e.id),[other]);assert.equal(db.feeds()[0].unread_count,1);
    const after=db.entry(id);for(const key of ['content','read','starred','saved','archived'])assert.equal(after[key],before[key]);assert.deepEqual(db.entryTags(id),tags);assert.equal((await request('GET','/api/archives')).json().length,1);
    const oldUndo=review.undoHash,zip=join(dir,'filter.zip'),restored=join(dir,'restored');await createBackup(db,dir,zip);await restoreBackup(zip,restored);const copy=await RivuDatabase.open(join(restored,'rivu.db'));assert.deepEqual(copy.filterDecision(id),db.filterDecision(id));assert.deepEqual(copy.entries({view:'blocked'}).map(e=>e.id),[id]);copy.close();
    await service.stop();service=createService(db,'filter-token',join(dir,'settings.json'));assert.equal((await undo(oldUndo)).statusCode,409);review=(await request('GET',`/api/entries/${id}/ai/filter-review`)).json();
    await request('PATCH','/api/ai/settings',{filterCriteria:''});assert.equal((await undo(review.undoHash)).statusCode,200,'清空条件和离线时仍可撤销本地过滤');assert.equal(db.entries({view:'unread'}).length,2);
    review=await generate('mute');const stale=review.reviewHash;await request('PATCH','/api/ai/settings',{filterCriteria:'更新条件'});assert.equal((await apply(stale)).statusCode,409);
    review=await generate('mute');db.setFullContent(id,'<p>更新正文</p>');assert.equal((await apply(review.reviewHash)).statusCode,409);
    for(const invalid of ['bad','{"decision":["block"],"reason":"证据"}','{"decision":"delete","reason":"证据"}','{"decision":"block","reason":""}',JSON.stringify({decision:'block',reason:'x'.repeat(401)}),'{"decision":"mute","reason":"证据","extra":true}']){
      content=invalid;await request('PATCH','/api/ai/settings',{filterCriteria:`无效格式测试 ${++sequence}`});const p=(await request('GET',`/api/entries/${id}/ai/preview?type=filter`)).json();assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'filter',scopeHash:p.scopeHash})).statusCode,502);assert.equal(db.filterDecision(id),undefined);
    }
    review=await generate('keep');assert.equal((await apply(review.reviewHash)).statusCode,200);assert.equal(db.entries({view:'unread'}).length,2);
    review=await generate('block');await apply(review.reviewHash);db.deleteFeed(feed.id);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_filter_decisions').get().n,0);assert.equal((await request('GET','/api/archives')).json().length,1);
  }finally{await service.stop();db.close();await new Promise(resolve=>provider.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('schema 27 upgrades to 29 with preserved data and a protection snapshot',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-filter-migration-'));let db;
  try{db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'旧资料',url:'https://example.com/old'});db.addEntries(feed.id,[{title:'保留文章',content:'原正文',hash:'old'}]);const before=db.db.prepare('SELECT * FROM entries').all();db.db.exec('DROP TABLE ai_filter_decisions; PRAGMA user_version=27');db.close();db=await RivuDatabase.open(join(dir,'rivu.db'));assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(db.db.prepare('SELECT * FROM entries').all(),before);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_filter_decisions').get().n,0);assert.ok(readdirSync(dir).some(name=>name.startsWith('pre-migration-')));}finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy nullable filter identifiers cannot hide unrelated articles or corrupt unread counts',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-filter-null-'));let db;
  try{
    db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'非空回归',url:'https://example.com/null'});db.addEntries(feed.id,[{title:'未过滤',content:'正文',hash:'null-case'}]);const id=db.entries()[0].id;
    assert.throws(()=>db.db.prepare("INSERT INTO ai_filter_decisions(entry_id,decision,reason,criteria,provider,model,content_hash,updated_at) VALUES (NULL,'block','','','','','','')").run(),/NOT NULL/);
    db.db.exec("DROP TABLE ai_filter_decisions; CREATE TABLE ai_filter_decisions(entry_id TEXT PRIMARY KEY,decision TEXT,reason TEXT,criteria TEXT,provider TEXT,model TEXT,content_hash TEXT,updated_at TEXT); INSERT INTO ai_filter_decisions VALUES(NULL,'block','','','','','',''); INSERT INTO ai_filter_decisions VALUES(NULL,'mute','','','','','','')");
    assert.deepEqual(db.entries({view:'all'}).map(e=>e.id),[id]);assert.deepEqual(db.entries({view:'unread'}).map(e=>e.id),[id]);assert.equal(db.feeds()[0].unread_count,1);
    assert.equal(db.db.prepare("SELECT COALESCE(NULL IN(SELECT entry_id FROM ai_filter_decisions WHERE entry_id IS NOT NULL),0) value").get().value,0);
    assert.deepEqual(db.entries({view:'blocked'}),[]);assert.equal(db.markRead({view:'unread'}).length,1);
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
