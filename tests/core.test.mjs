import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../dist-server/service.js';
import { exportOpml, importOpml, previewOpml } from '../dist-server/opml.js';
import { createBackup, inspectBackup, restoreBackup } from '../dist-server/backup.js';
import { LocalReadingSettings } from '../dist-server/reading-settings.js';
import AdmZip from 'adm-zip';
const require=createRequire(import.meta.url);
const { RivuDatabase,SCHEMA_VERSION }=require('../dist-server/database.cjs');

test('reading position persists locally, validates progress and is removed with its feed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-position-'));const path=join(dir,'rivu.db');
  let db=await RivuDatabase.open(path);const feed=db.addFeed({title:'阅读源',url:'https://example.com/reading'});
  db.addEntries(feed.id,[{title:'长文章',content:'正文',hash:'position-one'}]);const id=db.entries()[0].id;
  const service=createService(db,'position-token');const headers={'x-rivu-token':'position-token'};
  try{
    const before=await service.app.inject({method:'GET',url:`/api/entries/${id}/reading-position`,headers});assert.equal(before.json().progress,0);
    const saved=await service.app.inject({method:'PUT',url:`/api/entries/${id}/reading-position`,headers,payload:{progress:0.42}});assert.equal(saved.statusCode,200);assert.equal(saved.json().progress,0.42);
    for(const invalid of [-0.1,1.1,'0.5',null]){const result=await service.app.inject({method:'PUT',url:`/api/entries/${id}/reading-position`,headers,payload:{progress:invalid}});assert.equal(result.statusCode,400,result.body);}
    assert.equal(db.readingPosition(id).progress,0.42);
    await service.stop();db.close();db=await RivuDatabase.open(path);assert.equal(db.readingPosition(id).progress,0.42);
    db.deleteFeed(feed.id);assert.equal(db.readingPosition(id),undefined);
  }finally{try{await service.stop();}catch{}try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('timeline responses stay small while article detail retains full local text',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-list-detail-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  const feed=db.addFeed({title:'长文源',url:'https://example.com/long'});
  db.addEntries(feed.id,[{title:'长文条目',content:'订阅正文'.repeat(2000),hash:'long-body'}]);
  const id=db.entries()[0].id,full=`<p>${'长正文'.repeat(40000)}</p>`;
  db.setFullContent(id,full);
  const service=createService(db,'list-token'),headers={'x-rivu-token':'list-token'};
  try{
    const page=await service.app.inject({method:'GET',url:'/api/entries',headers});
    assert.equal(page.statusCode,200);assert.ok(page.body.length<3000);assert.equal(page.json()[0].full_content,undefined);assert.ok(page.json()[0].content.length<=512);
    const search=await service.app.inject({method:'GET',url:'/api/search?q=%E9%95%BF%E6%AD%A3%E6%96%87',headers});
    assert.equal(search.json().length,1);assert.equal(search.json()[0].full_content,undefined);
    const detail=await service.app.inject({method:'GET',url:`/api/entries/${id}`,headers});assert.equal(detail.json().full_content,full);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('reading appearance settings are validated and included in local backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-reading-settings-'));const restored=mkdtempSync(join(tmpdir(),'rivu-reading-restore-'));
  const path=join(dir,'settings.json');writeFileSync(path,JSON.stringify({ai:{apiKey:'secret'},imageCache:{enabled:false}}));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const service=createService(db,'reading-token',path,dir);const headers={'x-rivu-token':'reading-token'};
  try{
    const initial=(await service.app.inject({method:'GET',url:'/api/reading/settings',headers})).json();assert.equal(initial.configured,false);assert.equal(initial.preferences.theme,'light');
    const updated=await service.app.inject({method:'PATCH',url:'/api/reading/settings',headers,payload:{theme:'dark',fontSize:18,density:'compact',uiFontSize:'large'}});assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().preferences.theme,'dark');assert.equal(updated.json().preferences.density,'compact');assert.equal(updated.json().preferences.uiFontSize,'large');
    const invalid=await service.app.inject({method:'PATCH',url:'/api/reading/settings',headers,payload:{fontSize:999}});assert.equal(invalid.statusCode,400);
    const invalidDensity=await service.app.inject({method:'PATCH',url:'/api/reading/settings',headers,payload:{density:'tiny'}});assert.equal(invalidDensity.statusCode,400);
    const invalidUiSize=await service.app.inject({method:'PATCH',url:'/api/reading/settings',headers,payload:{uiFontSize:'huge'}});assert.equal(invalidUiSize.statusCode,400);
    assert.equal(JSON.parse(readFileSync(path,'utf8')).ai.apiKey,'secret');
    assert.equal(JSON.parse(readFileSync(path,'utf8')).reading.fontSize,18);
    const zip=join(dir,'reading.zip');await createBackup(db,dir,zip);await restoreBackup(zip,restored);
    const recovered=JSON.parse(readFileSync(join(restored,'settings.json'),'utf8'));assert.equal(recovered.reading.theme,'dark');assert.equal(recovered.reading.fontSize,18);assert.equal(recovered.reading.density,'compact');assert.equal(recovered.reading.uiFontSize,'large');assert.equal(recovered.ai.apiKey,undefined);
    const legacyZip=join(dir,'legacy-reading.zip');const legacyArchive=new AdmZip(zip);const legacyReading={...recovered.reading};delete legacyReading.density;delete legacyReading.uiFontSize;legacyArchive.updateFile('settings.json',Buffer.from(JSON.stringify({...recovered,reading:legacyReading})));legacyArchive.writeZip(legacyZip);
    assert.equal((await inspectBackup(legacyZip)).hasSettings,true);await restoreBackup(legacyZip,restored);
    assert.equal(JSON.parse(readFileSync(join(restored,'settings.json'),'utf8')).reading.density,undefined);
    const legacySettings=new LocalReadingSettings(join(restored,'settings.json'));
    assert.equal(legacySettings.get().configured,true);assert.equal(legacySettings.get().densityConfigured,false);assert.equal(legacySettings.get().preferences.density,'standard');assert.equal(legacySettings.get().preferences.uiFontSize,'standard');
    legacySettings.update({density:'comfortable'});
    assert.equal(JSON.parse(readFileSync(join(restored,'settings.json'),'utf8')).reading.density,'comfortable');
    const invalidZip=join(dir,'invalid-reading.zip');const archive=new AdmZip(zip);archive.updateFile('settings.json',Buffer.from(JSON.stringify({...recovered,reading:{...recovered.reading,fontSize:999}})));archive.writeZip(invalidZip);
    await assert.rejects(inspectBackup(invalidZip),/阅读设置无效/);
    await assert.rejects(restoreBackup(invalidZip,restored),/阅读设置无效/);
    assert.equal(JSON.parse(readFileSync(join(restored,'settings.json'),'utf8')).reading.fontSize,18);
    writeFileSync(path,JSON.stringify({ai:{apiKey:'secret'},imageCache:{enabled:false},reading:{...recovered.reading,density:'invalid'}}));
    const sanitizedZip=join(dir,'sanitized-reading.zip');await createBackup(db,dir,sanitizedZip);
    const sanitizedSettings=JSON.parse(new AdmZip(sanitizedZip).getEntry('settings.json').getData().toString());
    assert.equal(sanitizedSettings.reading,undefined);assert.equal(sanitizedSettings.imageCache.enabled,false);assert.equal(sanitizedSettings.ai.apiKey,undefined);
    assert.equal((await inspectBackup(sanitizedZip)).hasSettings,true);
    await restoreBackup(sanitizedZip,restored);
    const sanitizedRestored=JSON.parse(readFileSync(join(restored,'settings.json'),'utf8'));
    assert.equal(sanitizedRestored.reading,undefined);assert.equal(sanitizedRestored.imageCache.enabled,false);
    writeFileSync(path,JSON.stringify({reading:legacyReading,imageCache:{enabled:false}}));
    const preservedLegacyZip=join(dir,'preserved-legacy-reading.zip');await createBackup(db,dir,preservedLegacyZip);
    const preservedLegacyReading=JSON.parse(new AdmZip(preservedLegacyZip).getEntry('settings.json').getData().toString()).reading;
    assert.equal(preservedLegacyReading.density,undefined);assert.equal(preservedLegacyReading.uiFontSize,undefined);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});

test('P0: local API requires token, fetches RSS, persists timeline and reading state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-test-'));
  let requests=0;const rss=createServer((_req,res)=>{requests++;res.setHeader('content-type','application/rss+xml');res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>测试订阅</title><link>https://example.com</link><item><title>第一篇</title><link>https://example.com/1</link><guid>one</guid><description>本地阅读内容</description></item></channel></rss>');});
  await new Promise(resolve=>rss.listen(0,'127.0.0.1',resolve));
  const feedUrl=`http://127.0.0.1:${rss.address().port}/feed`;
  let db=await RivuDatabase.open(join(dir,'rivu.db'));const service=createService(db,'test-token');
  try{
    const unauthorized=await service.app.inject({method:'GET',url:'/api/feeds'});assert.equal(unauthorized.statusCode,401);
    const denied=await service.app.inject({method:'POST',url:'/api/feeds/discover',headers:{'x-rivu-token':'test-token'},payload:{url:feedUrl}});assert.equal(denied.statusCode,500);assert.equal(requests,0);
    const invalidTrust=await service.app.inject({method:'POST',url:'/api/feeds',headers:{'x-rivu-token':'test-token'},payload:{url:feedUrl,allowPrivate:'yes'}});assert.equal(invalidTrust.statusCode,400);assert.equal(requests,0);
    const created=await service.app.inject({method:'POST',url:'/api/feeds',headers:{'x-rivu-token':'test-token'},payload:{url:feedUrl,allowPrivate:true}});assert.equal(created.statusCode,201,created.body);
    const feed=created.json();assert.equal(feed.title,'测试订阅');assert.equal(feed.allow_private,1);assert.ok(requests>0);
    const entries=await service.app.inject({method:'GET',url:'/api/entries',headers:{'x-rivu-token':'test-token'}});assert.equal(entries.json().length,1);const id=entries.json()[0].id;
    await service.app.inject({method:'PATCH',url:`/api/entries/${id}`,headers:{'x-rivu-token':'test-token'},payload:{read:true,starred:true}});
    db.close();db=await RivuDatabase.open(join(dir,'rivu.db'));assert.equal(db.entry(id).read,1);assert.equal(db.entry(id).starred,1);
  }finally{await service.stop();db.close();rss.close();rmSync(dir,{recursive:true,force:true});}
});

test('P1: OPML roundtrip, FTS search and backup restore',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-data-'));const restored=mkdtempSync(join(tmpdir(),'rivu-restored-'));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const category=db.addCategory('科研');const feed=db.addFeed({title:'科学博客',url:'https://example.com/feed',categoryId:category.id});
    db.addEntries(feed.id,[{title:'量子计算进展',content:'一篇关于量子计算的文章',url:'https://example.com/1',hash:'unique-one'}]);
    const tag=db.addTag('科研');db.setEntryTags(db.entries()[0].id,[tag.id]);db.setFullContent(db.entries()[0].id,'<p>完整归档正文</p>');
    assert.equal(db.entries({query:'量子计算'}).length,1);
    const xml=exportOpml(db);assert.match(xml,/科学博客/);
    const other=await RivuDatabase.open(join(restored,'import.db'));try{const result=await importOpml(other,xml);assert.equal(result.imported,1);assert.equal(other.feeds().length,1);}finally{other.close();}
    const zip=join(dir,'backup.zip');await createBackup(db,dir,zip);db.close();await restoreBackup(zip,restored);
    const recovered=await RivuDatabase.open(join(restored,'rivu.db'));try{assert.equal(recovered.entries().length,1);assert.equal(recovered.categories().length,1);assert.equal(recovered.tags().length,1);assert.match(recovered.entry(recovered.entries()[0].id).full_content,/完整归档/);}finally{recovered.close();}
  }finally{try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});

test('OPML preview reports duplicates and invalid URLs, then imports selected feeds with category mapping',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-opml-preview-'));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const target=db.addCategory('目标分类');
    db.addFeed({title:'已有',url:'https://example.com/existing'});
    const xml='<?xml version="1.0"?><opml version="2.0"><body><outline text="来源分类"><outline text="文章 A" xmlUrl="https://example.com/a"/><outline text="已有" xmlUrl="https://example.com/existing"/><outline text="重复 A" xmlUrl="https://example.com/a"/><outline text="坏地址" xmlUrl="file:///private/feed"/><outline text="文章 B" xmlUrl="https://example.com/b"/></outline></body></opml>';
    const preview=previewOpml(db,xml);
    assert.equal(preview.newCount,2);assert.equal(preview.duplicateCount,2);assert.equal(preview.invalidCount,1);
    assert.equal(preview.items[0].sourceCategory,'来源分类');
    const result=await importOpml(db,xml,{selected:[0],categoryMap:{'来源分类':target.id}});
    assert.equal(result.imported,1);assert.equal(result.skipped,4);assert.equal(result.failed,0);
    assert.equal(db.feeds().find(feed=>feed.url==='https://example.com/a').category_id,target.id);
    assert.equal(db.feed(db.feeds().find(feed=>feed.url==='https://example.com/b')?.id||''),undefined);
    db.addFeed({title:'无尾斜杠',url:'https://canonical.example'});
    const equivalent=previewOpml(db,'<opml><body><outline text="相同" xmlUrl="https://canonical.example/"/></body></opml>');
    assert.equal(equivalent.newCount,0);assert.equal(equivalent.duplicateCount,1);
    assert.throws(()=>previewOpml(db,'<opml><body><outline></body></opml>'),/XML 格式无效/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('backup excludes AI key by default, supports explicit inclusion, and rejects invalid restore before replacement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-backup-'));
  const restored=mkdtempSync(join(tmpdir(),'rivu-restore-'));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  const current=await RivuDatabase.open(join(restored,'rivu.db'));
  try{
    const feed=db.addFeed({title:'备份订阅',url:'https://example.com/feed'});
    db.addEntries(feed.id,[{title:'备份文章',hash:'backup-one'}]);
    const old=current.addFeed({title:'当前订阅',url:'https://example.com/current'});
    writeFileSync(join(dir,'settings.json'),JSON.stringify({ai:{baseUrl:'http://127.0.0.1:1234/v1',apiKey:'top-secret',credentialId:'account-stamp'},imageCache:{enabled:false}}));
    const normal=join(dir,'normal.zip'),progress=[];await createBackup(db,dir,normal,{onSnapshotProgress:percent=>progress.push(percent)});
    assert.equal(progress.at(-1),100);
    assert.ok(progress.every((percent,index)=>percent>=0&&percent<=100&&(index===0||percent>=progress[index-1])));
    const zipped=new AdmZip(normal);
    assert.equal(JSON.parse(zipped.getEntry('settings.json').getData().toString()).ai.apiKey,undefined);
    assert.equal(JSON.parse(zipped.getEntry('settings.json').getData().toString()).ai.credentialId,undefined);
    assert.deepEqual(await inspectBackup(normal),{schemaVersion:SCHEMA_VERSION,hasSettings:true,includesSecrets:false});
    const withKey=join(dir,'with-key.zip');await createBackup(db,dir,withKey,{includeSecrets:true});
    assert.equal((await inspectBackup(withKey)).includesSecrets,true);
    assert.equal(JSON.parse(new AdmZip(withKey).getEntry('settings.json').getData().toString()).ai.apiKey,'top-secret');
    assert.equal(JSON.parse(new AdmZip(withKey).getEntry('settings.json').getData().toString()).ai.credentialId,'account-stamp');
    db.db.exec('PRAGMA foreign_keys=OFF');db.db.prepare('INSERT INTO entry_tags(entry_id,tag_id) VALUES (?,?)').run('missing-entry','missing-tag');
    const orphan=join(dir,'orphan.zip');await createBackup(db,dir,orphan);
    db.db.prepare('DELETE FROM entry_tags WHERE entry_id=?').run('missing-entry');db.db.exec('PRAGMA foreign_keys=ON');
    await assert.rejects(inspectBackup(orphan),/失效的关联记录/);
    const invalid=join(dir,'invalid.zip');const corrupt=new AdmZip(normal);corrupt.updateFile('manifest.json',Buffer.from('{"format":"rivu-backup","version":99}'));corrupt.writeZip(invalid);
    const malformedDb=join(dir,'malformed.db');const malformed=new DatabaseSync(malformedDb);malformed.exec('CREATE TABLE feeds(id TEXT); CREATE TABLE entries(id TEXT); CREATE TABLE categories(id TEXT); PRAGMA user_version=13;');malformed.close();const malformedZip=join(dir,'malformed.zip');const malformedArchive=new AdmZip();malformedArchive.addLocalFile(malformedDb,'','rivu.db');malformedArchive.addFile('manifest.json',Buffer.from('{"format":"rivu-backup","version":2,"schemaVersion":13}'));malformedArchive.writeZip(malformedZip);
    current.close();
    await assert.rejects(restoreBackup(invalid,restored),/不支持此备份版本/);
    await assert.rejects(restoreBackup(malformedZip,restored),/数据库结构不完整/);
    const unchanged=await RivuDatabase.open(join(restored,'rivu.db'));try{assert.equal(unchanged.feed(old.id).title,'当前订阅');}finally{unchanged.close();}
    await restoreBackup(normal,restored);
    const recovered=await RivuDatabase.open(join(restored,'rivu.db'));try{assert.equal(recovered.entries().length,1);assert.equal(recovered.feeds()[0].title,'备份订阅');}finally{recovered.close();}
    assert.equal(JSON.parse(readFileSync(join(restored,'settings.json'),'utf8')).ai.apiKey,undefined);
  }finally{try{db.close();}catch{}try{current.close();}catch{}rmSync(dir,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});

test('P2: configurable OpenAI-compatible provider, summary cache, translation and ask',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-'));let calls=0;const requests=[];
  const modelServer=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'test-model'}]}));return;}if(req.url==='/v1/chat/completions'){calls++;let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);requests.push(request);res.end(JSON.stringify({choices:[{message:{content:`reply:${request.messages[0].content.slice(0,5)}`}}]}));return;}res.statusCode=404;res.end('{}');});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'AI Feed',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'文章',content:'这是用于测试摘要和翻译的正文。',hash:'ai-entry'}]);const entry=db.entries()[0];const service=createService(db,'ai-token',join(dir,'settings.json'));const headers={'x-rivu-token':'ai-token'};
  try{
    const settings=await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'test-model',apiKey:'secret'}});assert.equal(settings.statusCode,200);assert.equal(settings.json().apiKeyConfigured,true);assert.equal(JSON.stringify(settings.json()).includes('secret'),false);
    for(const invalid of [{temperature:-1},{temperature:'hot'},{maxTokens:0},{maxTokens:1.5},{credentialId:'forged'},{baseUrl:'not-a-url'},{baseUrl:'http://localhost/v1?token=secret'}])assert.equal((await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:invalid})).statusCode,400);
    assert.equal((await service.app.inject({method:'GET',url:'/api/ai/settings',headers})).json().model,'test-model');
    const check=await service.app.inject({method:'POST',url:'/api/ai/test',headers});assert.equal(check.json().ok,true);
    const draftCheck=await service.app.inject({method:'POST',url:'/api/ai/test',headers,payload:{model:'draft-model'}});assert.equal(draftCheck.statusCode,200);assert.equal(draftCheck.json().model,'draft-model');
    const failedDraft=await service.app.inject({method:'POST',url:'/api/ai/test',headers,payload:{baseUrl:'http://127.0.0.1:1/v1'}});assert.notEqual(failedDraft.statusCode,200);
    assert.equal((await service.app.inject({method:'GET',url:'/api/ai/settings',headers})).json().model,'test-model');
    assert.equal(JSON.parse(readFileSync(join(dir,'settings.json'),'utf8')).ai.baseUrl,`http://127.0.0.1:${modelServer.address().port}/v1`);
    const savedSettings=readFileSync(join(dir,'settings.json'),'utf8');writeFileSync(join(dir,'settings.json'),'{broken','utf8');
    const corruptSave=await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{model:'must-not-save'}});assert.equal(corruptSave.statusCode,409);assert.equal(readFileSync(join(dir,'settings.json'),'utf8'),'{broken');const unknown=await service.app.inject({method:'GET',url:'/api/ai/settings',headers});assert.equal(unknown.statusCode,409);assert.match(unknown.json().error,/AI 配置读取失败/);assert.equal(calls,0);
    writeFileSync(join(dir,'settings.json'),savedSettings,'utf8');assert.equal((await service.app.inject({method:'GET',url:'/api/ai/settings',headers})).json().model,'test-model');
    const summaryPreview=await service.app.inject({method:'GET',url:`/api/entries/${entry.id}/ai/preview?type=summary`,headers});assert.equal(summaryPreview.statusCode,200);assert.match(summaryPreview.json().body,/测试摘要和翻译/);assert.equal(calls,0);
    const stale=await service.app.inject({method:'POST',url:`/api/entries/${entry.id}/ai`,headers,payload:{type:'summary',scopeHash:'wrong'}});assert.equal(stale.statusCode,409);assert.equal(calls,0);
    const summary=await service.app.inject({method:'POST',url:`/api/entries/${entry.id}/ai`,headers,payload:{type:'summary',scopeHash:summaryPreview.json().scopeHash}});assert.equal(summary.statusCode,200,summary.body);assert.equal(summary.json().cached,false);assert.equal(requests[0].messages.find(message=>message.role==='user').content,summaryPreview.json().prompt);assert.match(summaryPreview.json().prompt,/标题：文章/);
    const cached=await service.app.inject({method:'POST',url:`/api/entries/${entry.id}/ai`,headers,payload:{type:'summary',scopeHash:summaryPreview.json().scopeHash}});assert.equal(cached.json().cached,true);assert.equal(calls,1);
    const translationPreview=await service.app.inject({method:'GET',url:`/api/entries/${entry.id}/ai/preview?type=translation`,headers});assert.equal(translationPreview.statusCode,200);assert.equal(calls,1);
    const translated=await service.app.inject({method:'POST',url:`/api/entries/${entry.id}/ai`,headers,payload:{type:'translation',scopeHash:translationPreview.json().scopeHash}});assert.equal(translated.statusCode,200);
    const asked=await service.app.inject({method:'POST',url:`/api/entries/${entry.id}/ai`,headers,payload:{type:'ask',question:'文章讲了什么？'}});assert.equal(asked.statusCode,200);assert.equal(calls,3);
    const previousCredential=JSON.parse(readFileSync(join(dir,'settings.json'),'utf8')).ai.credentialId;
    const cleared=await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{apiKey:''}});assert.equal(cleared.statusCode,200);assert.equal(cleared.json().apiKeyConfigured,false);
    const afterClear=JSON.parse(readFileSync(join(dir,'settings.json'),'utf8')).ai;assert.equal(afterClear.apiKey,'');assert.notEqual(afterClear.credentialId,previousCredential);
    assert.equal((await service.app.inject({method:'GET',url:'/api/ai/settings',headers})).json().apiKeyConfigured,false);
  }finally{await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('manual AI preview coalesces concurrent sends and binds the credential',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-coalesce-'));let calls=0,release,received;const gate=new Promise(resolve=>{release=resolve}),firstRequest=new Promise(resolve=>{received=resolve});
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}calls++;for await(const _chunk of req){}received();await gate;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'同一结果'}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'并发源',url:'https://example.com/coalesce'});db.addEntries(feed.id,[{title:'并发文章',content:'待发送正文',hash:'coalesce'}]);const id=db.entries()[0].id,service=createService(db,'coalesce-token'),headers={'x-rivu-token':'coalesce-token'};
  try{
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'test',apiKey:'first'}});
    const preview=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
    const post=()=>service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:preview.scopeHash}});
    const first=post(),second=post();
    await firstRequest;assert.equal(calls,1);
    release();const results=await Promise.all([first,second]);assert.deepEqual(results.map(result=>result.statusCode),[200,200]);assert.deepEqual(results.map(result=>result.json().content),['同一结果','同一结果']);assert.equal(calls,1);
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{apiKey:'second'}});
    assert.equal((await post()).statusCode,409);assert.equal(calls,1);
  }finally{release();await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('older in-flight AI response cannot overwrite a newer parameter result',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-parameter-race-'));let releaseOld,releaseNew,receivedOld,receivedNew,calls=0;
  const oldGate=new Promise(resolve=>{releaseOld=resolve}),newGate=new Promise(resolve=>{releaseNew=resolve});
  const oldSeen=new Promise(resolve=>{receivedOld=resolve}),newSeen=new Promise(resolve=>{receivedNew=resolve});
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}let raw='';for await(const chunk of req)raw+=chunk;const temperature=JSON.parse(raw).temperature;calls++;if(temperature===0.3){receivedOld();await oldGate;}else{receivedNew();await newGate;}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:temperature===0.3?'旧参数摘要':'新参数摘要'}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'参数竞态源',url:'https://example.com/parameter-race'});db.addEntries(feed.id,[{title:'参数竞态文章',content:'本地正文',hash:'parameter-race'}]);const id=db.entries()[0].id,service=createService(db,'parameter-token'),headers={'x-rivu-token':'parameter-token'};
  const preview=async()=>(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
  const send=scopeHash=>service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash}});
  try{
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'test'}});
    const first=send((await preview()).scopeHash);await oldSeen;
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{temperature:0.7}});
    const second=send((await preview()).scopeHash);await newSeen;assert.equal(calls,2);
    releaseNew();assert.equal((await second).json().content,'新参数摘要');
    releaseOld();assert.equal((await first).json().content,'旧参数摘要');
    const cached=await service.app.inject({method:'GET',url:`/api/entries/${id}/ai?type=summary`,headers});assert.equal(cached.json().content,'新参数摘要');
  }finally{releaseOld();releaseNew();await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('AI cache follows content, provider model and prompt version',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-cache-'));let calls=0;const requests=[];
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:`摘要 ${calls}`}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'缓存源',url:'https://example.com/cache'});db.addEntries(feed.id,[{title:'缓存文章',content:'第一版正文',hash:'cache-one'}]);const id=db.entries()[0].id,service=createService(db,'cache-token');const headers={'x-rivu-token':'cache-token'};
  try{
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'first'}});
    const run=async()=>{const preview=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();return service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:preview.scopeHash}});};
    assert.equal((await run()).json().cached,false);assert.equal((await run()).json().cached,true);assert.equal(calls,1);
    const previousPreview=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{model:'second'}});
    assert.equal((await service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:previousPreview.scopeHash}})).statusCode,409);assert.equal(calls,1);
    assert.equal((await service.app.inject({method:'GET',url:`/api/entries/${id}/ai?type=summary`,headers})).json(),null);
    assert.equal((await run()).json().cached,false);assert.equal(calls,2);
    const beforeChange=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
    db.setFullContent(id,'<p>第二版正文</p>');
    assert.equal((await service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:beforeChange.scopeHash}})).statusCode,409);assert.equal(calls,2);
    assert.equal((await run()).json().cached,false);assert.equal(calls,3);
    db.setFullContent(id,'<p>第二版正文</p>');
    assert.equal((await run()).json().cached,true);assert.equal(calls,3,'相同全文重抓不得重复请求模型');
    db.setFullContent(id,'<div>第二版正文</div>');
    assert.equal((await run()).json().cached,true);assert.equal(calls,3,'HTML 标签变化但实际发送正文相同应保留缓存');
    db.db.prepare("UPDATE ai_results SET prompt_version='old' WHERE entry_id=?").run(id);
    assert.equal((await run()).json().cached,false);assert.equal(calls,4);
    const prefix='长'.repeat(40000);db.setFullContent(id,`<p>${prefix}甲</p>`);
    assert.equal((await run()).json().cached,false);assert.equal(calls,5);
    db.setFullContent(id,`<p>${prefix}乙</p>`);
    assert.equal((await run()).json().cached,true);assert.equal(calls,5,'实际发送文本截断点之后的变化不应重新请求模型');
    const beforeTemperature=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{temperature:0.7}});
    assert.equal((await service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:beforeTemperature.scopeHash}})).statusCode,409);
    assert.equal((await service.app.inject({method:'GET',url:`/api/entries/${id}/ai?type=summary`,headers})).json(),null);
    assert.equal((await run()).json().cached,false);assert.equal(calls,6);assert.equal(requests[5].temperature,0.7);
    const beforeTokens=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{maxTokens:1600}});
    assert.equal((await service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:beforeTokens.scopeHash}})).statusCode,409);
    assert.equal((await run()).json().cached,false);assert.equal(calls,7);assert.equal(requests[6].max_tokens,1600);
    assert.equal((await run()).json().cached,true);assert.equal(calls,7);
  }finally{await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('in-flight AI response keeps the Provider identity used for its request',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-switch-'));let signal,release;const received=new Promise(resolve=>{signal=resolve}),gate=new Promise(resolve=>{release=resolve});
  const oldProvider=createServer(async(_req,res)=>{signal();await gate;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'来自旧 Provider'}}]}));});
  const newProvider=createServer((_req,res)=>{res.statusCode=503;res.end('unused');});
  await Promise.all([new Promise(resolve=>oldProvider.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>newProvider.listen(0,'127.0.0.1',resolve))]);
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'切换源',url:'https://example.com/switch'});db.addEntries(feed.id,[{title:'切换文章',content:'可缓存正文',hash:'switch'}]);const id=db.entries()[0].id,service=createService(db,'switch-token'),headers={'x-rivu-token':'switch-token'};
  try{
    const oldUrl=`http://127.0.0.1:${oldProvider.address().port}/v1`,newUrl=`http://127.0.0.1:${newProvider.address().port}/v1`;
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:oldUrl,model:'same'}});
    const preview=(await service.app.inject({method:'GET',url:`/api/entries/${id}/ai/preview?type=summary`,headers})).json();
    const pending=service.app.inject({method:'POST',url:`/api/entries/${id}/ai`,headers,payload:{type:'summary',scopeHash:preview.scopeHash}});
    await received;
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:newUrl}});
    release();assert.equal((await pending).statusCode,200);
    assert.equal(db.aiResult(id,'summary','zh-CN').provider,oldUrl);
    assert.equal((await service.app.inject({method:'GET',url:`/api/entries/${id}/ai?type=summary`,headers})).json(),null);
  }finally{release();await service.stop();db.close();oldProvider.close();newProvider.close();rmSync(dir,{recursive:true,force:true});}
});

test('local AI conversation previews exact scope, requires fresh consent and persists cited history',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-chat-'));let calls=0;const requests=[];
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}calls++;let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'证据来自第一段 [1]'}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'对话源',url:'https://example.com/chat'});db.addEntries(feed.id,[{title:'第一篇',content:'<p>第一段证据。</p><p>第二段证据。</p>',hash:'chat-one'},{title:'第二篇',content:'<p>另一篇文章。</p>',hash:'chat-two'}]);const entries=db.entries(),headers={'x-rivu-token':'chat-token'},service=createService(db,'chat-token');
  try{
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'test-model'}});
    const preview=(await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:entries.map(item=>item.id)}})).json();assert.equal(preview.entryIds.length,2);assert.ok(preview.sources.some(source=>source.excerpt.includes('第一段证据')));assert.equal(calls,0);
    const created=await service.app.inject({method:'POST',url:'/api/ai/conversations',headers,payload:{entryIds:entries.map(item=>item.id)}});assert.equal(created.statusCode,201);const id=created.json().id;
    const stale=await service.app.inject({method:'POST',url:`/api/ai/conversations/${id}/messages`,headers,payload:{question:'讲了什么？',contextHash:'wrong'}});assert.equal(stale.statusCode,409);assert.equal(calls,0);
    const sent=await service.app.inject({method:'POST',url:`/api/ai/conversations/${id}/messages`,headers,payload:{question:'讲了什么？',contextHash:preview.contextHash,lastMessageId:null}});assert.equal(sent.statusCode,200,sent.body);assert.equal(sent.json().messages.length,2);assert.equal(sent.json().messages[1].citations.length,1);assert.equal(calls,1);assert.ok(requests[0].messages.some(message=>message.content.includes('第一段证据')));
    const staleHistory=await service.app.inject({method:'POST',url:`/api/ai/conversations/${id}/messages`,headers,payload:{question:'历史变了吗？',contextHash:preview.contextHash,lastMessageId:null}});assert.equal(staleHistory.statusCode,409);assert.equal(calls,1);
    const again=await service.app.inject({method:'POST',url:`/api/ai/conversations/${id}/messages`,headers,payload:{question:'再解释一下',contextHash:preview.contextHash,lastMessageId:sent.json().messages.at(-1).id}});assert.equal(again.statusCode,200);assert.equal(again.json().messages.length,4);assert.ok(requests[1].messages.some(message=>message.content==='讲了什么？'));
    const sendWithHash=(contextHash)=>service.app.inject({method:'POST',url:`/api/ai/conversations/${id}/messages`,headers,payload:{question:'设置变化了吗？',contextHash,lastMessageId:again.json().messages.at(-1).id}});
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{temperature:0.8}});assert.equal((await sendWithHash(preview.contextHash)).statusCode,409);assert.equal(calls,2);
    const temperaturePreview=(await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:entries.map(item=>item.id)}})).json();assert.equal(temperaturePreview.temperature,0.8);
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{maxTokens:900}});assert.equal((await sendWithHash(temperaturePreview.contextHash)).statusCode,409);assert.equal(calls,2);
    const parameterPreview=(await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:entries.map(item=>item.id)}})).json();assert.equal(parameterPreview.maxTokens,900);
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{apiKey:'changed-secret'}});assert.equal((await sendWithHash(parameterPreview.contextHash)).statusCode,409);assert.equal(calls,2);
    const credentialPreview=(await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:entries.map(item=>item.id)}})).json();
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{model:'changed-model'}});const changedProvider=await sendWithHash(credentialPreview.contextHash);assert.equal(changedProvider.statusCode,409);assert.equal(calls,2);
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{model:'test-model'}});
    db.setFullContent(entries[0].id,'<p>正文已经变更。</p>');const changed=await sendWithHash(credentialPreview.contextHash);assert.equal(changed.statusCode,409);assert.equal(calls,2);
    assert.equal((await service.app.inject({method:'GET',url:`/api/ai/conversations/${id}`,headers})).json().messages.length,4);
    assert.equal((await service.app.inject({method:'GET',url:'/api/ai/conversations',headers})).json().length,1);
    assert.equal((await service.app.inject({method:'DELETE',url:`/api/ai/conversations/${id}`,headers})).json().deleted,1);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_messages').get().n,0);
  }finally{await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('keyword and classification models persist and bind rule authorization independently of chat',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-tag-model-')),models=[];
  const modelServer=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;models.push(JSON.parse(raw).model);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'本地主题'}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const path=join(dir,'settings.json'),db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'模型分工',url:'https://example.com/tag-model'});
  db.addEntries(feed.id,[{title:'本地文章',content:'本地正文内容',hash:'tag-model'}]);const entryId=db.entries()[0].id;
  let service=createService(db,'tag-model-token',path);const headers={'x-rivu-token':'tag-model-token'},request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload?{payload}:{})});
  const waitDone=async(id)=>{for(let attempt=0;attempt<60;attempt++){if((await request('GET',`/api/ai-rules/${id}/jobs`)).json().some(job=>job.status==='done'))return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('模型分工任务未完成');};
  try{
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'default-model',askModel:'chat-model'});
    const draft={name:'模型分工',conditions:{},actionType:'keywords',maxItems:1};
    assert.equal((await request('POST','/api/ai-rules/preview',draft)).json().model,'chat-model','旧设置保持原问答模型回退');
    assert.equal((await request('PATCH','/api/ai/settings',{tagModel:123})).statusCode,400);
    assert.equal((await request('PATCH','/api/ai/settings',{tagModel:'x'.repeat(201)})).statusCode,400);
    await request('PATCH','/api/ai/settings',{tagModel:'tag-model-one'});
    const rules=[];
    for(const actionType of ['keywords','classification']){
      const rule=(await request('POST','/api/ai-rules',{...draft,actionType})).json(),preview=(await request('GET',`/api/ai-rules/${rule.id}/preview`)).json();
      assert.equal(preview.model,'tag-model-one');
      assert.equal((await request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false})).statusCode,200);
      rules.push({id:rule.id,actionType,preview});
    }
    await request('PATCH','/api/ai/settings',{askModel:'chat-model-two'});
    assert.equal((await request('POST','/api/ai/chat/preview',{entryIds:[entryId]})).json().model,'chat-model-two');
    assert.ok((await request('GET','/api/ai-rules')).json().every(rule=>!rule.needsAuthorization));
    for(const rule of rules){assert.equal((await request('POST',`/api/ai-rules/${rule.id}/run`,{})).statusCode,200);await waitDone(rule.id);}
    assert.deepEqual(models,['tag-model-one','tag-model-one']);
    await request('PATCH','/api/ai/settings',{tagModel:'tag-model-two'});
    assert.ok((await request('GET','/api/ai-rules')).json().every(rule=>rule.needsAuthorization));
    for(const rule of rules){
      assert.equal((await request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:rule.preview.scopeHash,confirmSend:true,autoRun:false})).statusCode,409);
      assert.equal((await request('POST',`/api/ai-rules/${rule.id}/run`,{})).statusCode,409);
      assert.equal((await request('GET',`/api/entries/${entryId}/ai?type=${rule.actionType}`)).json(),null);
      const fresh=(await request('GET',`/api/ai-rules/${rule.id}/preview`)).json();
      await request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:fresh.scopeHash,confirmSend:true,autoRun:false});
      await request('POST',`/api/ai-rules/${rule.id}/run`,{});await waitDone(rule.id);
    }
    assert.deepEqual(models,['tag-model-one','tag-model-one','tag-model-two','tag-model-two']);
    await service.stop();service=createService(db,'tag-model-token',path);
    assert.equal((await request('GET','/api/ai/settings')).json().tagModel,'tag-model-two');
    assert.ok((await request('GET','/api/ai-rules')).json().every(rule=>!rule.needsAuthorization));
    const backupPath=join(dir,'models.zip'),restoredDir=join(dir,'restored');await createBackup(db,dir,backupPath);await restoreBackup(backupPath,restoredDir);
    assert.equal(JSON.parse(readFileSync(join(restoredDir,'settings.json'),'utf8')).ai.tagModel,'tag-model-two');
  }finally{await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('first AI chat send commits history only after model reply',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-first-send-'));let calls=0,fail=true,resumeSuccess=()=>{},successStarted=()=>{};
  const successStartedPromise=new Promise(resolve=>{successStarted=resolve;});
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}calls++;for await(const _chunk of req){}if(fail){res.statusCode=503;res.end('fixture failure');return;}successStarted();await new Promise(resolve=>{resumeSuccess=resolve;});res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'有证据 [1]'}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'首次发送',url:'https://example.com/first-send'});db.addEntries(feed.id,[{title:'第一篇',content:'本地正文',hash:'first-send'}]);const entryIds=[db.entries()[0].id],service=createService(db,'first-send-token'),headers={'x-rivu-token':'first-send-token'};
  try{
    await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'test-model'}});
    const preview=(await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds}})).json(),url='/api/ai/chat/messages',payload={entryIds,question:'第一篇说了什么？',contextHash:preview.contextHash};
    assert.equal((await service.app.inject({method:'POST',url,headers,payload:{...payload,contextHash:'stale'}})).statusCode,409);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM ai_conversations').get().n,0);assert.equal(calls,0);
    assert.notEqual((await service.app.inject({method:'POST',url,headers,payload})).statusCode,200);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM ai_conversations').get().n,0);assert.equal(db.db.prepare('SELECT count(*) AS n FROM ai_messages').get().n,0);
    fail=false;const pending=service.app.inject({method:'POST',url,headers,payload});await successStartedPromise;
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM ai_conversations').get().n,0);
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM ai_messages').get().n,0);
    resumeSuccess();const sent=await pending;assert.equal(sent.statusCode,200,sent.body);assert.equal(sent.json().messages.length,2);assert.equal(calls,2);
    assert.equal((await service.app.inject({method:'GET',url:'/api/ai/conversations',headers})).json().length,1);
  }finally{resumeSuccess();await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('AI preview includes every selected article and rejects missing local body',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-many-')),db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'多篇',url:'https://example.com/many'});const items=Array.from({length:10},(_,index)=>({title:`文章 ${index}`,content:Array.from({length:5},(_,part)=>`<p>${index}-${part} ${'正文'.repeat(350)}</p>`).join(''),hash:`many-${index}`}));db.addEntries(feed.id,items);const service=createService(db,'many-token'),headers={'x-rivu-token':'many-token'};
  try{const ids=db.entries().map(item=>item.id),response=await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:ids}});assert.equal(response.statusCode,200,response.body);assert.equal(new Set(response.json().sources.map(source=>source.entryId)).size,10);assert.ok(response.json().totalChars<=24000);db.addEntries(feed.id,[{title:'空正文',hash:'empty-many'}]);const empty=db.entries().find(item=>item.title==='空正文');const rejected=await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:[ids[0],empty.id]}});assert.equal(rejected.statusCode,400);assert.match(rejected.body,/没有可发送的本地正文/);}finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('parallel sends to one local conversation do not duplicate model calls or fork history',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-parallel-'));let calls=0;
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}calls++;await new Promise(resolve=>setTimeout(resolve,150));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'并发回答 [1]'}}]}));});
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'并发源',url:'https://example.com/parallel'});db.addEntries(feed.id,[{title:'并发文章',content:'<p>本地正文</p>',hash:'parallel-one'}]);const id=db.entries()[0].id,service=createService(db,'parallel-token'),headers={'x-rivu-token':'parallel-token'};
  try{await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'test-model'}});const preview=(await service.app.inject({method:'POST',url:'/api/ai/chat/preview',headers,payload:{entryIds:[id]}})).json(),conversation=(await service.app.inject({method:'POST',url:'/api/ai/conversations',headers,payload:{entryIds:[id]}})).json();const payload={question:'两个请求',contextHash:preview.contextHash,lastMessageId:null},url=`/api/ai/conversations/${conversation.id}/messages`;const results=await Promise.all([service.app.inject({method:'POST',url,headers,payload}),service.app.inject({method:'POST',url,headers,payload})]);assert.deepEqual(results.map(item=>item.statusCode).sort(),[200,409]);assert.equal(calls,1);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_messages').get().n,2);}finally{await service.stop();db.close();modelServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('v0.2 RSSHub instances, routed subscription and feed health',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-hub-'));
  let fail=false,requests=0;
  const hub=createServer((_req,res)=>{requests++;if(fail){res.statusCode=503;res.end('unavailable');return;}res.setHeader('content-type','application/rss+xml');res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>RSSHub 测试</title><link>https://example.com</link><item><title>路由文章</title><guid>hub-one</guid><description>内容</description></item></channel></rss>');});
  await new Promise(resolve=>hub.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const service=createService(db,'hub-token');const headers={'x-rivu-token':'hub-token'};
  try{
    const untrusted=await service.app.inject({method:'POST',url:'/api/rsshub/instances',headers,payload:{name:'未授权本地实例',baseUrl:`http://127.0.0.1:${hub.address().port}`}});assert.equal(untrusted.statusCode,201);assert.equal(untrusted.json().allow_private,0);
    const denied=await service.app.inject({method:'POST',url:'/api/rsshub/preview',headers,payload:{instanceId:untrusted.json().id,route:'/example/route'}});assert.equal(denied.statusCode,500);assert.match(denied.body,/禁止访问本机或内网地址/);assert.equal(requests,0);db.deleteRsshubInstance(untrusted.json().id);
    const added=await service.app.inject({method:'POST',url:'/api/rsshub/instances',headers,payload:{name:'本地 RSSHub',baseUrl:`http://127.0.0.1:${hub.address().port}`,allowPrivate:true}});assert.equal(added.statusCode,201,added.body);const instance=added.json();
    const blocked=await service.app.inject({method:'POST',url:'/api/rsshub/preview',headers,payload:{instanceId:instance.id,route:'//outside.example/feed'}});assert.notEqual(blocked.statusCode,200);
    const preview=await service.app.inject({method:'POST',url:'/api/rsshub/preview',headers,payload:{instanceId:instance.id,route:'/example/route'}});assert.equal(preview.json().title,'RSSHub 测试');
    const subscribed=await service.app.inject({method:'POST',url:'/api/rsshub/subscribe',headers,payload:{instanceId:instance.id,route:'/example/route'}});assert.equal(subscribed.statusCode,201,subscribed.body);const feed=subscribed.json();assert.equal(feed.type,'rsshub');assert.equal(db.entries().length,1);
    fail=true;for(let i=0;i<5;i++){const attempt=await service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});assert.equal(attempt.statusCode,500);}const unhealthy=(await service.app.inject({method:'GET',url:'/api/feeds',headers})).json()[0];assert.equal(unhealthy.health,'error');assert.equal(unhealthy.failure_count,5);assert.match(unhealthy.last_error,/HTTP 503/);
    fail=false;await service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});assert.equal((await service.app.inject({method:'GET',url:'/api/feeds',headers})).json()[0].health,'healthy');
  }finally{await service.stop();db.close();hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('refresh all limits concurrent requests and reports partial failure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-refresh-'));
  let active=0,maxActive=0,requests=0;
  const server=createServer(async(req,res)=>{active++;requests++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,50));if(req.url==='/fail'){res.statusCode=503;res.end('failed');}else{res.setHeader('content-type','application/rss+xml');res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>批量刷新</title><item><title>一篇文章</title><guid>one</guid></item></channel></rss>');}active--;});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  const base=`http://127.0.0.1:${server.address().port}`;
  for(let i=0;i<6;i++)db.addFeed({title:`订阅 ${i}`,url:`${base}/${i===5?'fail':i}`,allowPrivate:true});
  const service=createService(db,'refresh-token');
  try{const [result,again]=await Promise.all(Array.from({length:2},()=>service.app.inject({method:'POST',url:'/api/feeds/refresh',headers:{'x-rivu-token':'refresh-token'}})));for(const response of [result,again]){assert.equal(response.statusCode,200,response.body);assert.equal(response.json().total,6);assert.equal(response.json().succeeded,5);assert.equal(response.json().failed,1);}assert.ok(maxActive<=4,`并发请求 ${maxActive} 超过上限`);assert.equal(requests,6,'同一订阅的并发刷新应合并');assert.equal(db.feeds().filter(feed=>feed.health==='retrying').length,1);}
  finally{await service.stop();db.close();server.close();rmSync(dir,{recursive:true,force:true});}
});

test('bulk read changes only the selected scope and undo restores those entries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-bulk-read-'));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  const feedA=db.addFeed({title:'A',url:'https://example.com/a'});
  const feedB=db.addFeed({title:'B',url:'https://example.com/b'});
  db.addEntries(feedA.id,[{title:'A1',hash:'a1'},{title:'A2',hash:'a2'}]);
  db.addEntries(feedB.id,[{title:'B1',hash:'b1'}]);
  const service=createService(db,'bulk-token');const headers={'x-rivu-token':'bulk-token'};
  try{
    const invalid=await service.app.inject({method:'POST',url:'/api/entries/mark-read',headers,payload:{view:'all',feedId:feedA.id}});assert.equal(invalid.statusCode,400);
    const marked=await service.app.inject({method:'POST',url:'/api/entries/mark-read',headers,payload:{feedId:feedA.id}});assert.equal(marked.statusCode,200,marked.body);assert.equal(marked.json().changed,2);
    assert.equal(db.entries({feedId:feedA.id}).every(entry=>entry.read===1),true);assert.equal(db.entries({feedId:feedB.id})[0].read,0);
    const undone=await service.app.inject({method:'POST',url:'/api/entries/mark-read/undo',headers,payload:{token:marked.json().undoToken}});assert.equal(undone.statusCode,200);assert.equal(undone.json().changed,2);assert.equal(db.entries({feedId:feedA.id}).every(entry=>entry.read===0),true);
    const repeated=await service.app.inject({method:'POST',url:'/api/entries/mark-read/undo',headers,payload:{token:marked.json().undoToken}});assert.equal(repeated.statusCode,404);
    const one=db.entries({feedId:feedA.id})[0];const selected=await service.app.inject({method:'POST',url:'/api/entries/mark-read',headers,payload:{ids:[one.id]}});assert.equal(selected.json().changed,1);assert.equal(db.entries({feedId:feedA.id}).filter(entry=>entry.read===1).length,1);
    await service.app.inject({method:'PATCH',url:`/api/entries/${one.id}`,headers,payload:{read:false}});
    await service.app.inject({method:'PATCH',url:`/api/entries/${one.id}`,headers,payload:{read:true}});
    const staleUndo=await service.app.inject({method:'POST',url:'/api/entries/mark-read/undo',headers,payload:{token:selected.json().undoToken}});
    assert.equal(staleUndo.json().changed,0);assert.equal(db.entry(one.id).read,1,'撤销不能覆盖之后的阅读操作');
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('v0.2 full-text extraction persists readable HTML and updates search',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-fulltext-'));
  const article=createServer((_req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<html><head><title>完整文章</title></head><body><header>导航栏</header><article><h1>完整文章</h1><p>${'星际探索带来新发现。'.repeat(35)}</p><p><img src="/cover.png" alt="封面"></p><script>window.bad=true</script></article></body></html>`);});
  await new Promise(resolve=>article.listen(0,'127.0.0.1',resolve));const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'摘要源',url:`http://127.0.0.1:${article.address().port}/feed`,allowPrivate:true});db.addEntries(feed.id,[{title:'简短标题',description:'很短的摘要',url:`http://127.0.0.1:${article.address().port}/article`,hash:'fulltext-one'}]);const id=db.entries()[0].id;db.saveAI(id,'summary','zh-CN','test','model','旧摘要');const service=createService(db,'full-token');
  try{const response=await service.app.inject({method:'POST',url:`/api/entries/${id}/full-text`,headers:{'x-rivu-token':'full-token'}});assert.equal(response.statusCode,200,response.body);assert.match(response.json().full_content,/星际探索/);assert.match(response.json().full_content,new RegExp(`http://127\\.0\\.0\\.1:${article.address().port}/cover.png`));assert.doesNotMatch(response.json().full_content,/<script/);assert.equal(db.entries({query:'星际探索'}).length,1);assert.equal(db.aiResult(id,'summary','zh-CN'),undefined);db.close();const reopened=await RivuDatabase.open(join(dir,'rivu.db'));try{assert.match(reopened.entry(id).full_content,/星际探索/);}finally{reopened.close();}}
  finally{await service.stop();try{db.close();}catch{}article.close();rmSync(dir,{recursive:true,force:true});}
});

test('v0.2 tags support article assignment, navigation filter and tag search',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-tags-'));const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'标签源',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'科研文章',hash:'tag-a'},{title:'生活文章',hash:'tag-b'}]);const entries=db.entries();const service=createService(db,'tags-token');const headers={'x-rivu-token':'tags-token'};
  try{const created=await service.app.inject({method:'POST',url:'/api/tags',headers,payload:{name:'科研'}});assert.equal(created.statusCode,201);const tag=created.json();const assigned=await service.app.inject({method:'PATCH',url:`/api/entries/${entries[0].id}/tags`,headers,payload:{tagIds:[tag.id]}});assert.equal(assigned.statusCode,200,assigned.body);assert.equal(db.entries({tagId:tag.id}).length,1);assert.equal(db.entries({query:'tag:科研'}).length,1);db.close();const reopened=await RivuDatabase.open(join(dir,'rivu.db'));try{assert.equal(reopened.entryTags(entries[0].id).length,1);}finally{reopened.close();}}
  finally{await service.stop();try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('v0.2 image cache is opt-in, persistent and readable offline',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-images-'));let requests=0;const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
  const imageServer=createServer((_req,res)=>{requests++;res.setHeader('content-type','image/png');res.end(png);});await new Promise(resolve=>imageServer.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${imageServer.address().port}/photo.png`;const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'本地图片源',url:`http://127.0.0.1:${imageServer.address().port}/feed`,allowPrivate:true});db.addEntries(feed.id,[{title:'图片文章',url:`http://127.0.0.1:${imageServer.address().port}/article`,content:`<img src="${url}">`,hash:'image-one'}]);const entryId=db.entries()[0].id;const service=createService(db,'image-token',join(dir,'settings.json'),dir);const headers={'x-rivu-token':'image-token'};
  try{const disabled=await service.app.inject({method:'POST',url:'/api/image-cache/cache',headers,payload:{url,entryId}});assert.equal(disabled.json().cached,false);assert.equal(requests,0);const configured=await service.app.inject({method:'PATCH',url:'/api/image-cache/settings',headers,payload:{enabled:true,maxBytes:1024**3}});assert.equal(configured.statusCode,200);const cached=await service.app.inject({method:'POST',url:'/api/image-cache/cache',headers,payload:{url,entryId}});assert.equal(cached.statusCode,200,cached.body);assert.equal(cached.json().cached,true);assert.equal(requests,1);imageServer.close();const stored=await service.app.inject({method:'GET',url:`/api/image-cache/lookup?entryId=${entryId}&url=${encodeURIComponent(url)}`,headers});assert.match(stored.json().dataUrl,/^data:image\/png;base64,/);assert.equal((await service.app.inject({method:'GET',url:'/api/image-cache/stats',headers})).json().count,1);db.close();const reopened=await RivuDatabase.open(join(dir,'rivu.db'));try{assert.equal(reopened.cachedImages().length,1);}finally{reopened.close();}}
  finally{await service.stop();try{db.close();}catch{}imageServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('offline save explicitly caches full text and images, reports failure, and retries missing images',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-offline-save-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
  let imageCalls=0;
  const site=createServer((req,res)=>{
    if(req.url==='/parallel.png'){res.setHeader('content-type','image/png');res.end(png);return;}
    if(req.url==='/parallel'){setTimeout(()=>{res.setHeader('content-type','text/html');res.end(`<html><body><article><h1>并发文章</h1><p>${'一段完整正文。'.repeat(30)}</p><img src="/parallel.png"></article></body></html>`);},80);return;}
    if(req.url==='/image.png'){imageCalls++;if(imageCalls===1){res.statusCode=503;res.end('retry');return;}res.setHeader('content-type','image/png');res.end(png);return;}
    if(req.url==='/article'){res.setHeader('content-type','text/html');res.end(`<html><body><article><h1>离线文章</h1><p>${'这是一段可离线阅读的完整正文。'.repeat(20)}</p><img src="/image.png"></article></body></html>`);return;}
    res.statusCode=404;res.end('missing');
  });
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${site.address().port}`;
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'离线源',url:`${origin}/feed`,allowPrivate:true});
  db.addEntries(feed.id,[{title:'可保存文章',url:`${origin}/article`,content:'订阅中的原始正文',hash:'offline-ok'},{title:'全文失败文章',url:`${origin}/missing`,content:'订阅正文仍然可读',hash:'offline-fail'},{title:'并发文章',url:`${origin}/parallel`,content:'摘要',hash:'offline-parallel'}]);
  const good=db.entries().find(row=>row.title==='可保存文章').id,bad=db.entries().find(row=>row.title==='全文失败文章').id;
  const service=createService(db,'offline-token',join(dir,'settings.json'),dir);const headers={'x-rivu-token':'offline-token'};
  try{
    assert.equal((await service.app.inject({method:'GET',url:'/api/image-cache/settings',headers})).json().enabled,false);
    const invalid=await service.app.inject({method:'POST',url:`/api/entries/${good}/offline`,headers,payload:{includeImages:'yes'}});assert.equal(invalid.statusCode,400);
    const first=await service.app.inject({method:'POST',url:`/api/entries/${good}/offline`,headers,payload:{includeImages:true}});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().status,'partial');assert.equal(first.json().fullText,true);assert.equal(first.json().images.total,1);assert.equal(first.json().images.cached,0);assert.match(first.json().lastError,/图片/);
    assert.equal(db.entry(good).saved,1);assert.match(db.entry(good).full_content,/完整正文/);
    const retry=await service.app.inject({method:'POST',url:`/api/entries/${good}/offline`,headers,payload:{includeImages:true}});assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().status,'ready');assert.equal(retry.json().images.cached,1);assert.equal(imageCalls,2);
    const failed=await service.app.inject({method:'POST',url:`/api/entries/${bad}/offline`,headers,payload:{includeImages:false}});assert.equal(failed.statusCode,200);assert.equal(failed.json().status,'partial');assert.equal(failed.json().feedBody,true);assert.equal(failed.json().fullText,false);assert.match(failed.json().lastError,/全文/);assert.equal(db.entry(bad).content,'订阅正文仍然可读');
    const parallel=db.entries().find(row=>row.title==='并发文章').id;
    const firstParallel=service.app.inject({method:'POST',url:`/api/entries/${parallel}/offline`,headers,payload:{includeImages:false}});
    const upgradedParallel=service.app.inject({method:'POST',url:`/api/entries/${parallel}/offline`,headers,payload:{includeImages:true}});
    const [textOnly,withImages]=await Promise.all([firstParallel,upgradedParallel]);assert.equal(textOnly.statusCode,200,textOnly.body);assert.equal(withImages.statusCode,200,withImages.body);assert.equal(withImages.json().requestedImages,true);assert.equal(withImages.json().images.cached,1);assert.equal(db.offlineSave(parallel).include_images,1);
    site.close();
    const offline=await service.app.inject({method:'GET',url:`/api/entries/${good}/offline`,headers});assert.equal(offline.json().status,'ready');
    const cached=await service.app.inject({method:'GET',url:`/api/image-cache/lookup?entryId=${good}&url=${encodeURIComponent(`${origin}/image.png`)}`,headers});assert.match(cached.json().dataUrl,/^data:image\/png;base64,/);
    rmSync(join(dir,'cache','images',db.cachedImage(`${origin}/image.png`).file_name));
    const missing=await service.app.inject({method:'GET',url:`/api/entries/${good}/offline`,headers});assert.equal(missing.json().status,'partial');assert.equal(missing.json().images.cached,0);assert.match(missing.json().lastError,/缓存移除/);
  }finally{await service.stop();db.close();site.close();rmSync(dir,{recursive:true,force:true});}
});

test('v0.2 untrusted article URLs cannot fetch loopback full text or images',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-network-'));let requests=0;
  const local=createServer((req,res)=>{requests++;if(req.url==='/feed'){res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>本地测试</title><item><title>一篇</title><guid>local-one</guid></item></channel></rss>');return;}res.setHeader('content-type','image/png');res.end('image');});
  await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${local.address().port}/private`;
  const redirect=createServer((_req,res)=>{res.writeHead(302,{location:url});res.end();});await new Promise(resolve=>redirect.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'远程订阅',url:'https://example.com/feed'});
  db.addEntries(feed.id,[{title:'恶意链接',url,content:`<img src="${url}">`,hash:'ssrf-one'}]);
  const entryId=db.entries()[0].id;const service=createService(db,'network-token',join(dir,'settings.json'),dir);const headers={'x-rivu-token':'network-token'};
  try{
    const full=await service.app.inject({method:'POST',url:`/api/entries/${entryId}/full-text`,headers});assert.equal(full.statusCode,500);assert.match(full.body,/禁止访问本机或内网地址/);
    await service.app.inject({method:'PATCH',url:'/api/image-cache/settings',headers,payload:{enabled:true,maxBytes:1024**3}});
    const image=await service.app.inject({method:'POST',url:'/api/image-cache/cache',headers,payload:{entryId,url}});assert.equal(image.statusCode,403);assert.match(image.body,/未授权访问该本机或内网图片/);
    const unrelated=await service.app.inject({method:'POST',url:'/api/image-cache/cache',headers,payload:{entryId,url:'https://example.com/other.png'}});assert.equal(unrelated.statusCode,500);assert.match(unrelated.body,/图片不属于这篇文章/);
    const localFeed=db.addFeed({title:'显式本地订阅',url:`http://127.0.0.1:${redirect.address().port}/feed`,allowPrivate:true});db.addEntries(localFeed.id,[{title:'跨来源跳转',url:`http://127.0.0.1:${redirect.address().port}/redirect`,hash:'redirect-one'}]);
    const redirected=await service.app.inject({method:'POST',url:`/api/entries/${db.entries({feedId:localFeed.id})[0].id}/full-text`,headers});assert.equal(redirected.statusCode,500);assert.match(redirected.body,/禁止访问本机或内网地址/);
    assert.equal(requests,0);
    const imported=await importOpml(db,`<opml><body><outline text="本地 OPML" xmlUrl="http://127.0.0.1:${local.address().port}/feed"/></body></opml>`);assert.equal(imported.imported,1);
    const untrusted=db.feeds().find(feed=>feed.title==='本地 OPML');assert.equal(untrusted.allow_private,0);
    const denied=await service.app.inject({method:'POST',url:`/api/feeds/${untrusted.id}/refresh`,headers});assert.equal(denied.statusCode,500);assert.match(denied.body,/禁止访问本机或内网地址/);assert.equal(requests,0);
    const invalid=await service.app.inject({method:'PATCH',url:`/api/feeds/${untrusted.id}`,headers,payload:{allowPrivate:'yes'}});assert.equal(invalid.statusCode,400);assert.equal(db.feed(untrusted.id).allow_private,0);
    const trusted=await service.app.inject({method:'PATCH',url:`/api/feeds/${untrusted.id}`,headers,payload:{allowPrivate:true}});assert.equal(trusted.statusCode,200);assert.equal(trusted.json().allow_private,1);
    const refreshed=await service.app.inject({method:'POST',url:`/api/feeds/${untrusted.id}/refresh`,headers});assert.equal(refreshed.statusCode,200,refreshed.body);assert.ok(requests>0);
  }finally{await service.stop();db.close();local.close();redirect.close();rmSync(dir,{recursive:true,force:true});}
});

test('local rules preview, priority, automatic effects, undo and manual state remain separate',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rules-'));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  const feed=db.addFeed({title:'科研源',url:'https://example.com/rules'});
  db.addEntries(feed.id,[{title:'科研突破',content:'正文含关键字',hash:'rule-a'},{title:'手动保存',content:'普通文章',hash:'rule-b'},{title:'普通文章',content:'正文含关键字',hash:'rule-c'}]);
  const a=db.entries().find(row=>row.title==='科研突破').id,b=db.entries().find(row=>row.title==='手动保存').id,c=db.entries().find(row=>row.title==='普通文章').id;
  db.updateEntry(b,{saved:true});const tag=db.addTag('重点');db.setEntryTags(b,[tag.id]);
  const service=createService(db,'rules-token');const headers={'x-rivu-token':'rules-token'};
  const post=(url,payload)=>service.app.inject({method:'POST',url,headers,payload});
  try{
    const invalid=await post('/api/rules',{name:'无效',conditions:{feedId:feed.id},action:{type:'tag',tagId:'missing'}});assert.equal(invalid.statusCode,400);
    const tagged=await post('/api/rules',{name:'科研加标签',priority:20,conditions:{feedId:feed.id,titleKeyword:'科研'},action:{type:'tag',tagId:tag.id}});assert.equal(tagged.statusCode,201,tagged.body);const tagRule=tagged.json();
    const saved=await post('/api/rules',{name:'重点稍后读',priority:10,conditions:{tagId:tag.id},action:{type:'save'}});assert.equal(saved.statusCode,201,saved.body);const saveRule=saved.json();
    const muted=await post('/api/rules',{name:'静音普通文章',priority:0,conditions:{titleKeyword:'普通文章'},action:{type:'mute'}});assert.equal(muted.statusCode,201,muted.body);
    const preview=await service.app.inject({method:'GET',url:`/api/rules/${tagRule.id}/preview`,headers});assert.equal(preview.json().matching,1);assert.equal(preview.json().pending,1);assert.equal(preview.json().sample[0].id,a);
    const single=await post(`/api/rules/${tagRule.id}/apply`,{});assert.equal(single.statusCode,200,single.body);assert.equal(single.json().inserted,1);assert.equal(db.entry(a).rule_saved,0);assert.equal(db.entry(c).rule_muted,0);
    const applied=await post('/api/rules/apply',{});assert.equal(applied.statusCode,200,applied.body);assert.equal(applied.json().inserted,3);
    const repeat=await post('/api/rules/apply',{});assert.equal(repeat.json().inserted,0);assert.equal(repeat.json().removed,0);
    assert.equal(db.entry(a).saved,0);assert.equal(db.entry(a).rule_saved,1);assert.equal(db.entry(b).saved,1);assert.equal(db.entry(b).rule_saved,1);assert.equal(db.entry(c).rule_muted,1);
    assert.deepEqual(db.entries({view:'unread'}).map(row=>row.id).sort(),[a,b].sort());
    assert.deepEqual(db.entries({view:'saved'}).map(row=>row.id).sort(),[a,b].sort());
    assert.equal(db.entryTags(a)[0].rule_based,1);assert.equal(db.entryTags(a)[0].manual,0);assert.equal(db.entryTags(b)[0].manual,1);
    const lowered=await service.app.inject({method:'PATCH',url:`/api/rules/${tagRule.id}`,headers,payload:{priority:0}});assert.equal(lowered.statusCode,200);assert.equal(db.entry(a).rule_saved,0,'低优先级规则产生的标签不能触发高优先级规则');
    const raised=await service.app.inject({method:'PATCH',url:`/api/rules/${tagRule.id}`,headers,payload:{priority:20}});assert.equal(raised.statusCode,200);assert.equal(db.entry(a).rule_saved,1);
    const stop=await service.app.inject({method:'PATCH',url:`/api/rules/${tagRule.id}`,headers,payload:{enabled:false}});assert.equal(stop.statusCode,200);assert.equal(db.entry(a).rule_saved,0);assert.equal(db.entryTags(a).length,0);assert.equal(db.entry(b).saved,1);assert.equal(db.entryTags(b)[0].manual,1);
    const restart=await service.app.inject({method:'PATCH',url:`/api/rules/${tagRule.id}`,headers,payload:{enabled:true}});assert.equal(restart.statusCode,200);assert.equal(db.entry(a).rule_saved,1);
    const undone=await post(`/api/rules/${tagRule.id}/undo`,{});assert.equal(undone.statusCode,200);assert.equal(undone.json().enabled,false);assert.equal(db.entry(a).rule_saved,0);assert.equal(db.entry(b).saved,1);assert.equal(db.entryTags(b)[0].manual,1);
    const blocked=await post('/api/rules',{name:'屏蔽普通文章',conditions:{titleKeyword:'普通文章'},action:{type:'block'}});assert.equal(blocked.statusCode,201);await post('/api/rules/apply',{});assert.equal(db.entries({view:'all'}).some(row=>row.id===c),false);assert.equal(db.entries({view:'blocked'})[0].id,c);
    await service.app.inject({method:'DELETE',url:`/api/rules/${blocked.json().id}`,headers});assert.equal(db.entries({view:'all'}).some(row=>row.id===c),true);
    assert.equal((await service.app.inject({method:'GET',url:'/api/rules',headers})).json().length,3);
    assert.equal(saveRule.action.type,'save');
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('enabled local rule applies to newly refreshed feed entries without AI or network service',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rule-refresh-'));
  const rss=createServer((_req,res)=>{res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>自动规则订阅</title><item><title>规则命中文章</title><guid>new-one</guid></item></channel></rss>');});
  await new Promise(resolve=>rss.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'自动规则订阅',url:`http://127.0.0.1:${rss.address().port}/feed`,allowPrivate:true});const service=createService(db,'rule-refresh-token');const headers={'x-rivu-token':'rule-refresh-token'};
  try{
    const created=await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'新文章稍后读',conditions:{feedId:feed.id,titleKeyword:'命中'},action:{type:'save'}}});assert.equal(created.statusCode,201,created.body);
    const refreshed=await service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});assert.equal(refreshed.statusCode,200,refreshed.body);
    const entry=db.entries({view:'saved'})[0];assert.equal(entry.title,'规则命中文章');assert.equal(entry.saved,0);assert.equal(entry.rule_saved,1);
    assert.equal((await service.app.inject({method:'GET',url:`/api/entries/${entry.id}/offline`,headers})).json().saved,true);
    await service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});assert.equal(db.db.prepare('SELECT count(*) n FROM rule_matches').get().n,1);
  }finally{await service.stop();db.close();rss.close();rmSync(dir,{recursive:true,force:true});}
});

test('multi-rule apply rolls back all effects when a later rule fails',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rule-rollback-'));const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'回滚源',url:'https://example.com/rollback'});db.addEntries(feed.id,[{title:'第一篇',hash:'one'},{title:'第二篇',hash:'two'}]);const service=createService(db,'rollback-token');const headers={'x-rivu-token':'rollback-token'};
  try{
    const first=(await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'第一条',priority:2,conditions:{titleKeyword:'第一'},action:{type:'save'}}})).json();
    const second=(await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'第二条',priority:1,conditions:{titleKeyword:'第二'},action:{type:'save'}}})).json();
    db.db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON rule_matches WHEN NEW.rule_id='${second.id}' BEGIN SELECT RAISE(ABORT,'synthetic'); END;`);
    const failed=await service.app.inject({method:'POST',url:'/api/rules/apply',headers,payload:{}});assert.equal(failed.statusCode,500);assert.equal(db.db.prepare('SELECT count(*) n FROM rule_matches').get().n,0);
    db.db.exec('DROP TRIGGER reject_second');const recovered=await service.app.inject({method:'POST',url:'/api/rules/apply',headers,payload:{}});assert.equal(recovered.statusCode,200);assert.equal(recovered.json().inserted,2);assert.equal(db.db.prepare('SELECT count(*) n FROM rule_matches').get().n,2);assert.notEqual(first.id,second.id);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('manual full-text extraction re-evaluates body keyword rules',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rule-fulltext-'));
  const site=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(`<html><body><article><h1>完整文章</h1><p>${'全文触发规则的独有关键词。'.repeat(30)}</p></article></body></html>`);});await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'全文源',url:`http://127.0.0.1:${site.address().port}/feed`,allowPrivate:true});db.addEntries(feed.id,[{title:'摘要文章',description:'摘要未包含关键词',url:`http://127.0.0.1:${site.address().port}/article`,hash:'one'}]);const id=db.entries()[0].id;const service=createService(db,'rule-full-token');const headers={'x-rivu-token':'rule-full-token'};
  try{
    const rule=await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'全文规则',conditions:{bodyKeyword:'独有关键词'},action:{type:'save'}}});assert.equal(rule.statusCode,201);assert.equal(db.entry(id).rule_saved,0);
    const extracted=await service.app.inject({method:'POST',url:`/api/entries/${id}/full-text`,headers});assert.equal(extracted.statusCode,200,extracted.body);assert.equal(db.entry(id).rule_saved,1);
  }finally{await service.stop();db.close();site.close();rmSync(dir,{recursive:true,force:true});}
});

test('deleting a tag removes dependent rules and downstream effects',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rule-tag-delete-'));const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'标签规则源',url:'https://example.com/tag-rules'});db.addEntries(feed.id,[{title:'目标文章',hash:'one'}]);const id=db.entries()[0].id;const tagA=db.addTag('条件 A'),tagB=db.addTag('动作 B');db.setEntryTags(id,[tagA.id]);const service=createService(db,'tag-delete-token');const headers={'x-rivu-token':'tag-delete-token'};
  try{
    const first=await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'A 加 B',priority:20,conditions:{tagId:tagA.id},action:{type:'tag',tagId:tagB.id}}});assert.equal(first.statusCode,201);
    const second=await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'B 屏蔽',priority:10,conditions:{tagId:tagB.id},action:{type:'block'}}});assert.equal(second.statusCode,201);
    await service.app.inject({method:'POST',url:'/api/rules/apply',headers,payload:{}});assert.equal(db.entry(id).rule_blocked,1);
    const deleted=await service.app.inject({method:'DELETE',url:`/api/tags/${tagA.id}`,headers});assert.equal(deleted.statusCode,200,deleted.body);assert.equal(deleted.json().removedRules,1);assert.equal(db.entry(id).rule_blocked,0);assert.equal(db.entryTags(id).length,0);assert.equal(db.entries({view:'all'}).length,1);assert.equal(db.db.prepare('SELECT count(*) n FROM rules').get().n,1);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('rule metadata update rolls back if dependent effect recomputation fails',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rule-meta-rollback-'));const db=await RivuDatabase.open(join(dir,'rivu.db'));const feed=db.addFeed({title:'事务源',url:'https://example.com/rule-transaction'});db.addEntries(feed.id,[{title:'待匹配',hash:'one'}]);const service=createService(db,'rule-transaction-token');const headers={'x-rivu-token':'rule-transaction-token'};
  try{
    const created=(await service.app.inject({method:'POST',url:'/api/rules',headers,payload:{name:'待启用',enabled:false,conditions:{titleKeyword:'待匹配'},action:{type:'save'}}})).json();
    db.db.exec(`CREATE TRIGGER reject_rule_enable BEFORE INSERT ON rule_matches BEGIN SELECT RAISE(ABORT,'synthetic'); END;`);
    const failed=await service.app.inject({method:'PATCH',url:`/api/rules/${created.id}`,headers,payload:{enabled:true}});assert.equal(failed.statusCode,500);assert.equal(db.db.prepare('SELECT enabled FROM rules WHERE id=?').get(created.id).enabled,0);assert.equal(db.db.prepare('SELECT count(*) n FROM rule_matches').get().n,0);
    db.db.exec('DROP TRIGGER reject_rule_enable');const enabled=await service.app.inject({method:'PATCH',url:`/api/rules/${created.id}`,headers,payload:{enabled:true}});assert.equal(enabled.statusCode,200);assert.equal(db.entry(db.entries()[0].id).rule_saved,1);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('opt-in AI rules preview locally, authorize scope, process batches, retry failures and auto-run new feed items',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-rules-'));let calls=0,fail=false,feedGuid='initial';const modelRequests=[];
  const modelServer=createServer(async(req,res)=>{if(req.url!=='/v1/chat/completions'){res.statusCode=404;res.end();return;}calls++;let raw='';for await(const chunk of req)raw+=chunk;const modelRequest=JSON.parse(raw);modelRequests.push(modelRequest);assert.ok(modelRequest.messages.some(message=>message.content.includes('正文')));res.setHeader('content-type','application/json');if(fail){res.statusCode=503;res.end('temporary');}else res.end(JSON.stringify({choices:[{message:{content:'关键词：本地、测试'}}]}));});
  const feedServer=createServer((_req,res)=>{res.setHeader('content-type','application/rss+xml');res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>AI 规则源</title><link>https://example.com</link><item><title>匹配自动文章</title><guid>${feedGuid}</guid><link>https://example.com/posts/${feedGuid}</link><description>自动正文内容</description></item></channel></rss>`);});
  await Promise.all([new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>feedServer.listen(0,'127.0.0.1',resolve))]);
  const db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'AI 规则源',url:`http://127.0.0.1:${feedServer.address().port}/feed`,allowPrivate:true});db.addEntries(feed.id,[{title:'匹配手动文章',content:'手动正文内容',hash:'manual-ai'},{title:'无关文章',content:'无关正文',hash:'other-ai'}]);const service=createService(db,'rule-ai-token'),headers={'x-rivu-token':'rule-ai-token'};
  const request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload?{payload}:{})});
  const waitStatus=async(id,status,count)=>{for(let attempt=0;attempt<60;attempt++){const rows=(await request('GET',`/api/ai-rules/${id}/jobs`)).json();if(rows.filter(row=>row.status===status).length>=count)return rows;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(`AI 任务未进入 ${status}`);};
  try{
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'local-test'});
    const draft={name:'关键词规则',conditions:{titleKeyword:'匹配'},actionType:'keywords',maxItems:3};
    const previewDraft=await request('POST','/api/ai-rules/preview',draft);assert.equal(previewDraft.statusCode,200,previewDraft.body);assert.equal(previewDraft.json().matching,1);assert.match(previewDraft.json().sample[0].prompt,/标题：匹配手动文章\n\n正文：\n手动正文内容/);assert.equal(calls,0);
    const created=await request('POST','/api/ai-rules',draft);assert.equal(created.statusCode,201);const id=created.json().id;assert.equal(created.json().enabled,false);
    await request('POST','/api/rules/apply',{});assert.equal(calls,0,'确定性规则不能自动调用 AI');
    const preview=(await request('GET',`/api/ai-rules/${id}/preview`)).json();
    assert.equal((await request('POST',`/api/ai-rules/${id}/enable`,{scopeHash:preview.scopeHash,autoRun:false})).statusCode,400);
    assert.equal((await request('POST',`/api/ai-rules/${id}/enable`,{scopeHash:'stale',confirmSend:true,autoRun:false})).statusCode,409);
    await request('PATCH','/api/ai/settings',{baseUrl:'https://api.example.com/v1'});const remote=(await request('GET',`/api/ai-rules/${id}/preview`)).json();assert.equal(remote.isLocal,false);assert.equal((await request('POST',`/api/ai-rules/${id}/enable`,{scopeHash:remote.scopeHash,confirmSend:true,autoRun:true})).statusCode,400);assert.equal(calls,0);
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`});const local=(await request('GET',`/api/ai-rules/${id}/preview`)).json();const enabled=await request('POST',`/api/ai-rules/${id}/enable`,{scopeHash:local.scopeHash,confirmSend:true,autoRun:false});assert.equal(enabled.statusCode,200,enabled.body);assert.equal(calls,0);
    assert.equal((await request('POST',`/api/ai-rules/${id}/run`,{})).json().queued,1);await waitStatus(id,'done',1);assert.equal(calls,1);assert.equal(modelRequests[0].messages.find(message=>message.role==='user').content,local.sample[0].prompt);assert.equal((await request('POST',`/api/ai-rules/${id}/run`,{})).json().queued,0);assert.equal(calls,1);
    const manual=db.entries({query:'匹配手动'})[0];assert.equal((await request('GET',`/api/entries/${manual.id}/ai?type=keywords`)).json().content,'关键词：本地、测试');
    db.setFullContent(manual.id,'<p>更新后的正文内容</p>');assert.equal((await request('POST',`/api/ai-rules/${id}/run`,{})).json().queued,1);await waitStatus(id,'done',1);assert.equal(calls,2);
    db.addEntries(feed.id,[{title:'匹配失败文章',content:'失败正文内容',hash:'failure-ai'}]);fail=true;assert.equal((await request('POST',`/api/ai-rules/${id}/run`,{})).json().queued,1);await waitStatus(id,'failed',1);assert.equal(calls,3);fail=false;assert.equal((await request('POST',`/api/ai-rules/${id}/retry`,{})).json().queued,1);await waitStatus(id,'done',2);assert.equal(calls,4);
    await request('PATCH','/api/ai/settings',{model:'changed'});assert.equal((await request('POST',`/api/ai-rules/${id}/run`,{})).statusCode,409);assert.equal(calls,4);
    assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,true);
    feedGuid='stale-authorization';await request('POST',`/api/feeds/${feed.id}/refresh`,{});assert.equal(calls,4);
    await request('PATCH','/api/ai/settings',{model:'local-test'});const reauth=(await request('GET',`/api/ai-rules/${id}/preview`)).json();await request('POST',`/api/ai-rules/${id}/enable`,{scopeHash:reauth.scopeHash,confirmSend:true,autoRun:true});
    feedGuid='new-article';const refreshed=await request('POST',`/api/feeds/${feed.id}/refresh`,{});assert.equal(refreshed.statusCode,200,refreshed.body);await waitStatus(id,'done',3);assert.equal(calls,5);
    await request('POST',`/api/feeds/${feed.id}/refresh`,{});assert.equal(calls,5,'重复刷新不应重复调用模型');
    const beforeKeyChange=(await request('GET',`/api/ai-rules/${id}/preview`)).json();
    await request('PATCH','/api/ai/settings',{apiKey:'another-provider-account'});
    assert.equal((await request('POST',`/api/ai-rules/${id}/enable`,{scopeHash:beforeKeyChange.scopeHash,confirmSend:true,autoRun:true})).statusCode,409);
    assert.equal((await request('POST',`/api/ai-rules/${id}/run`,{})).statusCode,409);
    assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,true);
    feedGuid='key-changed';await request('POST',`/api/feeds/${feed.id}/refresh`,{});assert.equal(calls,5,'凭据更换后不能自动发送新文章');
    const disabled=await request('POST',`/api/ai-rules/${id}/disable`,{});assert.equal(disabled.json().enabled,false);
    const deleted=await request('DELETE',`/api/ai-rules/${id}`);assert.equal(deleted.json().deleted,true);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_rule_jobs').get().n,0);
  }finally{await service.stop();db.close();modelServer.close();feedServer.close();rmSync(dir,{recursive:true,force:true});}
});

test('AI rule authorization survives restart with the same credential and rejects a changed one',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-rule-identity-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  const path=join(dir,'settings.json'),headers={'x-rivu-token':'identity-token'};
  let service=createService(db,'identity-token',path);
  const request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload?{payload}:{})});
  try{
    await request('PATCH','/api/ai/settings',{model:'local-model',apiKey:'account-one'});
    const created=(await request('POST','/api/ai-rules',{name:'持久授权',conditions:{},actionType:'summary',maxItems:1})).json();
    const preview=(await request('GET',`/api/ai-rules/${created.id}/preview`)).json();
    assert.equal((await request('POST',`/api/ai-rules/${created.id}/enable`,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:true})).statusCode,200);
    assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,false);
    await service.stop();service=createService(db,'identity-token',path);
    assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,false);
    const backupPath=join(dir,'without-credentials.zip'),restoredDir=join(dir,'restored');
    await createBackup(db,dir,backupPath);await restoreBackup(backupPath,restoredDir);
    const restoredDb=await RivuDatabase.open(join(restoredDir,'rivu.db')),restoredService=createService(restoredDb,'restored-token',join(restoredDir,'settings.json'));
    try{const restoredRules=(await restoredService.app.inject({method:'GET',url:'/api/ai-rules',headers:{'x-rivu-token':'restored-token'}})).json();assert.equal(restoredRules[0].needsAuthorization,true);}finally{await restoredService.stop();restoredDb.close();}
    await request('PATCH','/api/ai/settings',{apiKey:'account-two'});
    assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,true);
    assert.equal((await request('POST',`/api/ai-rules/${created.id}/run`,{})).statusCode,409);
    await service.stop();
    const legacy=JSON.parse(readFileSync(path,'utf8'));delete legacy.ai.credentialId;writeFileSync(path,JSON.stringify(legacy));
    service=createService(db,'identity-token',path);
    const refreshed=(await request('GET',`/api/ai-rules/${created.id}/preview`)).json();
    assert.equal((await request('POST',`/api/ai-rules/${created.id}/enable`,{scopeHash:refreshed.scopeHash,confirmSend:true,autoRun:true})).statusCode,200);
    assert.ok(JSON.parse(readFileSync(path,'utf8')).ai.credentialId);
    await service.stop();service=createService(db,'identity-token',path);
    assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,false);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('AI rule batch reaches older matching articles beyond 2000 completed jobs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-rules-page-'));const db=await RivuDatabase.open(join(dir,'rivu.db'));
  const feed=db.addFeed({title:'分页源',url:'https://example.com/page'});
  db.addEntries(feed.id,Array.from({length:2001},(_,index)=>({title:`分页文章 ${String(index).padStart(4,'0')}`,content:'正文',hash:`page-${index}`,publishedAt:new Date(Date.now()-index*1000).toISOString()})));
  const service=createService(db,'page-token'),headers={'x-rivu-token':'page-token'},request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload?{payload}:{})});
  const sha=value=>createHash('sha256').update(value).digest('hex');
  try{
    await request('PATCH','/api/ai/settings',{baseUrl:'http://127.0.0.1:1/v1',model:'local-test'});
    const created=(await request('POST','/api/ai-rules',{name:'分页规则',conditions:{},actionType:'summary',maxItems:1})).json();
    const preview=(await request('GET',`/api/ai-rules/${created.id}/preview`)).json();
    await request('POST',`/api/ai-rules/${created.id}/enable`,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false});
    const rows=db.db.prepare('SELECT id,title FROM entries ORDER BY COALESCE(published_at,fetched_at) DESC,id LIMIT 2000').all();
    const insert=db.db.prepare("INSERT INTO ai_rule_jobs(rule_id,entry_id,source_hash,provider,model,status,created_at,updated_at) VALUES (?,?,?,?,?,'done',?,?)");
    const now=new Date().toISOString();for(const row of rows){const contentHash=sha(JSON.stringify({title:row.title,body:'正文',language:'zh-CN',type:'summary',temperature:0.3,maxTokens:1200}));insert.run(created.id,row.id,sha(JSON.stringify({contentHash,promptVersion:'v2'})),preview.provider,preview.model,now,now);}
    const queued=(await request('POST',`/api/ai-rules/${created.id}/run`,{})).json();assert.equal(queued.queued,1);assert.equal(queued.scanned,2001);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('Smart Folder saves a live local query, supports relative dates and scoped read undo without copying entries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-smart-folder-'));const db=await RivuDatabase.open(join(dir,'rivu.db'));const alpha=db.addFeed({title:'Alpha News',url:'https://example.com/alpha'}),beta=db.addFeed({title:'Beta',url:'https://example.com/beta'});const recent=new Date().toISOString(),old=new Date(Date.now()-14*86_400_000).toISOString();
  db.addEntries(alpha.id,[{title:'AI 近闻',content:'近期',publishedAt:recent,hash:'a-recent'},{title:'AI 旧闻',content:'历史',publishedAt:old,hash:'a-old'}]);db.addEntries(beta.id,[{title:'AI 其他源',publishedAt:recent,hash:'b-recent'},{title:'普通新闻',publishedAt:recent,hash:'b-other'}]);const originalCount=db.db.prepare('SELECT count(*) n FROM entries').get().n;
  const service=createService(db,'smart-token');const headers={'x-rivu-token':'smart-token'};
  try{
    const invalid=await service.app.inject({method:'POST',url:'/api/smart-folders',headers,payload:{name:'错条件',query:'AI is:unknown'}});assert.equal(invalid.statusCode,400);
    const invalidDate=await service.app.inject({method:'POST',url:'/api/smart-folders/preview',headers,payload:{query:'after:0d'}});assert.equal(invalidDate.statusCode,400);
    const invalidOr=await service.app.inject({method:'POST',url:'/api/smart-folders/preview',headers,payload:{query:'AI OR unread'}});assert.equal(invalidOr.statusCode,400);
    const sample=await service.app.inject({method:'POST',url:'/api/smart-folders/preview',headers,payload:{query:'AI AND unread AND after:7d'}});assert.equal(sample.json().sample.length,2);
    const query='AI AND unread AND after:7d feed:"Alpha News"';const draft=await service.app.inject({method:'POST',url:'/api/smart-folders/preview',headers,payload:{query}});assert.equal(draft.statusCode,200);assert.equal(draft.json().sample.length,1);assert.equal(draft.json().sample[0].title,'AI 近闻');
    const created=await service.app.inject({method:'POST',url:'/api/smart-folders',headers,payload:{name:'一周 AI',query}});assert.equal(created.statusCode,201,created.body);const id=created.json().id;assert.match(created.json().query,/is:unread/);assert.equal(db.db.prepare('SELECT count(*) n FROM entries').get().n,originalCount);
    const duplicate=await service.app.inject({method:'POST',url:'/api/smart-folders',headers,payload:{name:'一周 ai',query}});assert.equal(duplicate.statusCode,409);
    const entries=()=>service.app.inject({method:'GET',url:`/api/smart-folders/${id}/entries`,headers});assert.equal((await entries()).json().length,1);
    const first=(await entries()).json()[0];db.updateEntry(first.id,{read:true});assert.equal((await entries()).json().length,0);db.updateEntry(first.id,{read:false});
    db.addEntries(alpha.id,[{title:'AI 新增',publishedAt:recent,hash:'a-new'}]);assert.equal((await entries()).json().length,2);assert.equal(db.db.prepare('SELECT count(*) n FROM entries').get().n,originalCount+1);
    const marked=await service.app.inject({method:'POST',url:'/api/entries/mark-read',headers,payload:{smartFolderId:id}});assert.equal(marked.statusCode,200,marked.body);assert.equal(marked.json().changed,2);assert.equal((await entries()).json().length,0);assert.equal(db.entries({feedId:beta.id,view:'unread'}).length,2);
    const undone=await service.app.inject({method:'POST',url:'/api/entries/mark-read/undo',headers,payload:{token:marked.json().undoToken}});assert.equal(undone.statusCode,200);assert.equal((await entries()).json().length,2);
    const updated=await service.app.inject({method:'PATCH',url:`/api/smart-folders/${id}`,headers,payload:{name:'所有 AI',query:'AI is:unread'}});assert.equal(updated.statusCode,200);assert.equal((await entries()).json().length,4);
    const deleted=await service.app.inject({method:'DELETE',url:`/api/smart-folders/${id}`,headers});assert.equal(deleted.statusCode,200);assert.equal((await entries()).statusCode,404);assert.equal(db.db.prepare('SELECT count(*) n FROM entries').get().n,originalCount+1);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});


