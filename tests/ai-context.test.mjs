import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createService } from '../dist-server/service.js';
import { createBackup,restoreBackup } from '../dist-server/backup.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const cost=messages=>256+messages.reduce((n,message)=>n+16+Buffer.byteLength(message.content),0);

test('AI context budget binds action previews, caches and rule authorization, persists and preserves old defaults',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-context-'));const db=new RivuDatabase(join(dir,'rivu.db')),requests=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'预算内回答 [1]'}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let service=createService(db,'context-token',join(dir,'settings.json'));const headers={'x-rivu-token':'context-token'};
  const request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload!==undefined?{payload}:{})});
  try{
    const feed=db.addFeed({title:'上下文',url:'https://example.com/context'});db.addEntries(feed.id,[{title:'文章',content:`<p>${'中文😀'.repeat(15000)}</p>`,hash:'long'}]);const id=db.entries()[0].id;
    assert.equal((await request('GET','/api/ai/settings')).json().contextLength,0);
    const old=(await request('GET',`/api/entries/${id}/ai/preview?type=summary`)).json();assert.equal(old.chars,40000);
    for(const value of [-1,1,1023,4096.1,'4096',null,262145])assert.equal((await request('PATCH','/api/ai/settings',{contextLength:value})).statusCode,400);
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'budget-model',contextLength:4096,maxTokens:500});
    const preview=(await request('GET',`/api/entries/${id}/ai/preview?type=summary`)).json();assert.equal(preview.contextLength,4096);assert.equal(preview.truncated,true);assert.ok(preview.chars<40000);assert.ok(!/[\uD800-\uDBFF]$/.test(preview.body));
    const action=()=>request('POST',`/api/entries/${id}/ai`,{type:'summary',scopeHash:preview.scopeHash});
    assert.equal((await action()).statusCode,200);assert.equal(requests.length,1);assert.ok(cost(requests[0].messages)+requests[0].max_tokens<=4096);assert.equal(requests[0].messages[1].content,preview.prompt);
    assert.equal((await action()).json().cached,true);assert.equal(requests.length,1);
    const rule=(await request('POST','/api/ai-rules',{name:'上下文规则',conditions:{},actionType:'summary',maxItems:1})).json();const rulePreview=(await request('GET',`/api/ai-rules/${rule.id}/preview`)).json();
    assert.equal((await request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:rulePreview.scopeHash,confirmSend:true,autoRun:false})).statusCode,200);
    await request('PATCH','/api/ai/settings',{contextLength:8192});assert.equal((await action()).statusCode,409);assert.equal((await request('GET',`/api/entries/${id}/ai?type=summary`)).json(),null);assert.equal((await request('GET','/api/ai-rules')).json()[0].needsAuthorization,true);
    assert.equal((await request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:rulePreview.scopeHash,confirmSend:true,autoRun:false})).statusCode,409);assert.equal(requests.length,1);
    const backup=join(dir,'budget.zip');await createBackup(db,dir,backup);const restored=join(dir,'restored');await restoreBackup(backup,restored);
    await service.stop();service=createService(db,'context-token',join(restored,'settings.json'));assert.equal((await request('GET','/api/ai/settings')).json().contextLength,8192);
  }finally{await service.stop();db.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('configured chat preview budgets every selected source, question and exact history; stale question fails before sending',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-chat-budget-')),db=new RivuDatabase(join(dir,'rivu.db')),requests=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'预算回答 [1]'}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const service=createService(db,'chat-budget-token'),headers={'x-rivu-token':'chat-budget-token'},request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload!==undefined?{payload}:{})});
  try{
    const feed=db.addFeed({title:'来源',url:'https://example.com/chat'});db.addEntries(feed.id,Array.from({length:10},(_,i)=>({title:`文章${i}`,content:`<p>${'中文😀'.repeat(5000)}</p>`,hash:String(i)})));const entryIds=db.entries().map(row=>row.id),question='证据是什么？';
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'budget-chat',contextLength:4096,maxTokens:300});
    const preview=(await request('POST','/api/ai/chat/preview',{entryIds,question})).json();assert.equal(new Set(preview.sources.map(source=>source.entryId)).size,10);assert.equal(preview.history.length,0);
    assert.equal((await request('POST','/api/ai/chat/messages',{entryIds,question:'问题变了',contextHash:preview.contextHash})).statusCode,409);assert.equal(requests.length,0);
    const sent=await request('POST','/api/ai/chat/messages',{entryIds,question,contextHash:preview.contextHash});assert.equal(sent.statusCode,200,sent.body);assert.ok(cost(requests[0].messages)+300<=4096);
    const conversation=sent.json(),follow='再解释一下';const next=(await request('POST','/api/ai/chat/preview',{entryIds,question:follow,conversationId:conversation.id})).json();assert.equal(next.history.length,2);
    const again=await request('POST',`/api/ai/conversations/${conversation.id}/messages`,{question:follow,contextHash:next.contextHash,lastMessageId:conversation.messages.at(-1).id});assert.equal(again.statusCode,200,again.body);assert.ok(cost(requests[1].messages)+300<=4096);assert.deepEqual(requests[1].messages.slice(2,-1),next.history);
    db.db.prepare("UPDATE ai_messages SET content=? WHERE conversation_id=? AND role='assistant'").run('过大的历史'.repeat(10000),conversation.id);
    const tooLarge=await request('POST','/api/ai/chat/preview',{entryIds,question:follow,conversationId:conversation.id});assert.equal(tooLarge.statusCode,400);assert.equal(requests.length,2,'不能静默截断历史或超限发送');
  }finally{await service.stop();db.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
