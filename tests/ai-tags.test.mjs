import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createService } from '../dist-server/service.js';
import { createBackup,restoreBackup } from '../dist-server/backup.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');

test('AI tags require consent and reviewed selection, append atomically with rules, reuse existing tags and survive restart/backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-tags-')),db=new RivuDatabase(join(dir,'rivu.db')),requests=[];
  let responseContent=JSON.stringify({tags:[{name:'科研',reason:'正文记载研究成果'},{name:'航天',reason:'正文记载探测器任务'}]});
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:responseContent}}]}));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));let service=createService(db,'tags-token',join(dir,'settings.json'));
  const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'tags-token'},...(payload!==undefined?{payload}:{})});
  try{
    const feed=db.addFeed({title:'研究',url:'https://example.com/research'});db.addEntries(feed.id,[{title:'探测器研究',content:'探测器任务取得研究成果。',hash:'tags'}]);const id=db.entries()[0].id;
    const manual=db.addTag('阅读'),existing=db.addTag('科研'),ruleTag=db.addTag('规则标签');db.setEntryTags(id,[manual.id]);
    assert.equal((await request('POST','/api/rules',{name:'科研标记',conditions:{tagId:existing.id},action:{type:'tag',tagId:ruleTag.id}})).statusCode,201);
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'default',askModel:'large',tagModel:'small',contextLength:4096,maxTokens:500});
    assert.equal((await request('GET',`/api/entries/${id}/ai/tag-suggestions`)).json(),null);
    assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'tags'})).statusCode,409);assert.equal(requests.length,0);
    const preview=(await request('GET',`/api/entries/${id}/ai/preview?type=tags`)).json();assert.equal(preview.model,'small');
    assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'tags',scopeHash:preview.scopeHash})).statusCode,200);
    assert.equal(requests.length,1);assert.equal(requests[0].messages[0].content,preview.systemPrompt);assert.equal(requests[0].messages[1].content,preview.prompt);
    assert.deepEqual(db.entryTags(id).map(tag=>tag.name),['阅读'],'生成建议不修改标签');assert.equal(db.tags().length,3);
    let review=(await request('GET',`/api/entries/${id}/ai/tag-suggestions`)).json();assert.equal(review.tags.length,2);
    db.addEntries(feed.id,[{title:'另一篇文章',content:'另一篇研究记录',hash:'other-tags'}]);const other=db.entries().find(entry=>entry.id!==id).id;
    assert.equal((await request('POST',`/api/entries/${other}/ai/tag-suggestions/apply`,{names:['航天'],reviewHash:review.reviewHash})).statusCode,409,'不能将建议应用到另一篇文章');assert.deepEqual(db.entryTags(other),[]);
    const apply=(names,reviewHash=review.reviewHash)=>request('POST',`/api/entries/${id}/ai/tag-suggestions/apply`,{names,reviewHash});
    for(const names of [[],['航天','航天'],['伪造标签'],[123],null])assert.equal((await apply(names)).statusCode,400);
    assert.equal((await apply(['科研'],'wrong')).statusCode,409);assert.equal(db.tags().length,3);
    db.db.exec("CREATE TRIGGER fail_tag_link BEFORE INSERT ON entry_tags WHEN (SELECT name FROM tags WHERE id=NEW.tag_id)='航天' BEGIN SELECT RAISE(ABORT,'injected tag failure'); END");
    assert.equal((await apply(['科研','航天'])).statusCode,500);assert.equal(db.tags().length,3);assert.deepEqual(db.entryTags(id).map(tag=>tag.name),['阅读']);
    db.db.exec('DROP TRIGGER fail_tag_link');
    db.db.exec("CREATE TRIGGER fail_rule_reconcile BEFORE INSERT ON rule_matches BEGIN SELECT RAISE(ABORT,'injected rule failure'); END");
    assert.equal((await apply(['科研','航天'])).statusCode,500);assert.equal(db.tags().length,3);assert.deepEqual(db.entryTags(id).map(tag=>tag.name),['阅读']);
    db.db.exec('DROP TRIGGER fail_rule_reconcile');
    assert.equal((await apply(['科研','航天'])).statusCode,200);assert.equal(db.tags().length,4);
    const assigned=db.entryTags(id);assert.equal(assigned.find(tag=>tag.name==='科研').id,existing.id);assert.equal(assigned.find(tag=>tag.name==='规则标签').manual,0);assert.equal(assigned.find(tag=>tag.name==='规则标签').rule_based,1);assert.equal(assigned.find(tag=>tag.name==='阅读').manual,1);
    assert.equal((await apply(['科研','航天'])).statusCode,200);assert.equal(db.tags().length,4);assert.equal(requests.length,1,'应用及重复应用不调用模型');
    const zip=join(dir,'tags.zip'),restored=join(dir,'restored');await createBackup(db,dir,zip);await restoreBackup(zip,restored);const copy=new RivuDatabase(join(restored,'rivu.db'));assert.deepEqual(copy.entryTags(id),db.entryTags(id));copy.close();
    await service.stop();service=createService(db,'tags-token',join(dir,'settings.json'));assert.equal((await apply(['科研'])).statusCode,409,'重启后旧审阅凭据失效');review=(await request('GET',`/api/entries/${id}/ai/tag-suggestions`)).json();assert.equal((await apply(['科研'])).statusCode,200);
    await request('PATCH','/api/ai/settings',{tagModel:'changed'});assert.equal((await apply(['航天'])).statusCode,409);assert.equal(requests.length,1);
    await request('PATCH','/api/ai/settings',{tagModel:'small'});review=(await request('GET',`/api/entries/${id}/ai/tag-suggestions`)).json();db.setFullContent(id,'<p>新的探测器任务正文</p>');assert.equal((await apply(['航天'])).statusCode,409);assert.equal(db.aiResult(id,'tags','zh-CN'),undefined);
    for(const content of ['not json','{"tags":[{"name":"空依据","reason":""}]}','{"tags":[{"name":"超长","reason":"'+ 'x'.repeat(241)+'"}]}','{"tags":[{"name":"重复","reason":"证据"},{"name":"重复","reason":"证据"}]}','{"tags":'+JSON.stringify(Array.from({length:9},(_,i)=>({name:`标签${i}`,reason:'证据'})))+'}',JSON.stringify({tags:[{name:'x'.repeat(41),reason:'证据'}]})]){
      responseContent=content;const p=(await request('GET',`/api/entries/${id}/ai/preview?type=tags`)).json();assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'tags',scopeHash:p.scopeHash})).statusCode,502);assert.equal(db.aiResult(id,'tags','zh-CN'),undefined);assert.equal(db.tags().length,4);
    }
    responseContent='```json\n{"tags":[]}\n```';const empty=(await request('GET',`/api/entries/${id}/ai/preview?type=tags`)).json();assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'tags',scopeHash:empty.scopeHash})).statusCode,200);assert.deepEqual((await request('GET',`/api/entries/${id}/ai/tag-suggestions`)).json().tags,[]);
  }finally{await service.stop();db.close();await new Promise(resolve=>provider.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
