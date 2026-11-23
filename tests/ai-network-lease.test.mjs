import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
import {WriteCoordinator} from '../dist-server/write-coordinator.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(action){const deadline=Date.now()+30000;while(!action()){assert.ok(Date.now()<deadline,'等待AI任务超时');await delay(10);}}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('模型尚未释放时后台刷新被阻塞')),30000))]);}finally{clearTimeout(timer);}}
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-ai-network-')),ready=deferred(),gate=deferred();let calls=0,feedCalls=0;
  const provider=createServer(async(req,res)=>{calls++;for await(const _ of req){}ready.resolve();await gate.promise;res.setHeader('content-type','application/json');res.end(req.url.endsWith('/models')?JSON.stringify({data:[{id:'fixture'}]}):JSON.stringify({choices:[{message:{content:'Local answer [1]'}}]}));});
  const feeds=createServer((_req,res)=>{res.setHeader('content-type','application/feed+json');res.end(JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'Background',items:[{id:`new-${++feedCalls}`,title:'New article',content_text:'New local content'}]}));});await Promise.all([new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>feeds.listen(0,'127.0.0.1',resolve))]);
  let db,service;
  const close=async()=>{gate.resolve();await service?.stop();db?.close();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>feeds.close(resolve))]);rmSync(dir,{recursive:true,force:true});};
  try{
    db=new RivuDatabase(join(dir,'rivu.db'));
    const source=db.addFeed({title:'Local',url:'https://example.invalid/local',fetchInterval:0}),background=db.addFeed({title:'Background',url:`http://127.0.0.1:${feeds.address().port}/feed`,allowPrivate:true,fetchInterval:0});
    db.addEntries(source.id,[{title:'Local article',content:'<p>Local body</p>',guid:'local',hash:'local'}]);
    const id=db.entries()[0].id;service=createService(db,'token');const request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
    assert.equal((await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'fixture'})).statusCode,200);
    return {dir,db,source,background,id,service,request,ready,gate,calls:()=>calls,close};
  }catch(error){await close();throw error;}

}
for(const mode of ['action','first_chat','followup','models','rule'])test(`held AI ${mode} and duplicate waiters release their own permit so Feed Worker commits before model reply`,async()=>{
  const f=await fixture();let pending,follower;
  try{
    if(mode==='action'){const preview=(await f.request('GET',`/api/entries/${f.id}/ai/preview?type=summary`)).json();const payload={type:'summary',scopeHash:preview.scopeHash};pending=f.request('POST',`/api/entries/${f.id}/ai`,payload);await bounded(f.ready.promise);follower=f.request('POST',`/api/entries/${f.id}/ai`,payload);}
    if(mode==='first_chat'){const preview=(await f.request('POST','/api/ai/chat/preview',{entryIds:[f.id],question:'Question'})).json(),payload={entryIds:[f.id],question:'Question',contextHash:preview.contextHash,requestId:'network_first_0123456789'};pending=f.request('POST','/api/ai/chat/messages',payload);await bounded(f.ready.promise);follower=f.request('POST','/api/ai/chat/messages',payload);}
    if(mode==='followup'){const conversation=(await f.request('POST','/api/ai/conversations',{entryIds:[f.id]})).json(),preview=(await f.request('POST','/api/ai/chat/preview',{entryIds:[f.id],question:'Question',conversationId:conversation.id})).json();pending=f.request('POST',`/api/ai/conversations/${conversation.id}/messages`,{question:'Question',contextHash:preview.contextHash,lastMessageId:null});}
    if(mode==='models')pending=f.request('POST','/api/ai/test',{});
    if(mode==='rule'){const rule=(await f.request('POST','/api/ai-rules',{name:'Local rule',conditions:{feedId:f.source.id},actionType:'summary',maxItems:1})).json(),preview=(await f.request('GET',`/api/ai-rules/${rule.id}/preview`)).json();assert.equal((await f.request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false})).statusCode,200);assert.equal((await f.request('POST',`/api/ai-rules/${rule.id}/run`,{})).statusCode,200);}
    await bounded(f.ready.promise);await delay(30);const refreshed=await bounded(f.request('POST',`/api/feeds/${f.background.id}/refresh`));assert.equal(refreshed.statusCode,200,refreshed.body);assert.equal(refreshed.json().added,1);assert.equal(f.calls(),1);assert.equal(f.db.entries({feedId:f.background.id}).length,1);
    assert.equal((await f.request('PATCH',`/api/entries/${f.id}`,{read:true,starred:true})).statusCode,200);f.gate.resolve();if(pending){const response=await pending;assert.equal(response.statusCode,200,response.body);if(follower){const duplicate=await follower;assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal(duplicate.body,response.body);}}
    if(mode==='rule'){await until(()=>f.db.db.prepare("SELECT status FROM ai_rule_jobs").get()?.status==='done');assert.ok(f.db.aiResult(f.id,'summary','zh-CN'));}
    assert.equal(f.calls(),1);assert.equal(f.db.entry(f.id).read,1);assert.equal(f.db.entry(f.id).starred,1);
  }finally{f.gate.resolve();await Promise.allSettled([pending,follower].filter(Boolean));await f.close();}
});
test('service shutdown still waits for accepted AI network work while its write permit is paused',async()=>{
  const f=await fixture();let pending;
  try{const preview=(await f.request('GET',`/api/entries/${f.id}/ai/preview?type=summary`)).json();pending=f.request('POST',`/api/entries/${f.id}/ai`,{type:'summary',scopeHash:preview.scopeHash});await bounded(f.ready.promise);let ended=false;const stopped=f.service.stop().then(()=>ended=true);await delay(30);assert.equal(ended,false);assert.equal((await f.request('POST','/api/ai/test',{})).statusCode,503);f.gate.resolve();assert.equal((await pending).statusCode,200);await stopped;assert.ok(f.db.aiResult(f.id,'summary','zh-CN'));}finally{f.gate.resolve();await pending;await f.close();}
});
test('paused main permit is reacquired before caller continuation, including a rejected non-database wait',async()=>{
  const writes=new WriteCoordinator(),network=deferred(),worker=deferred();let continued=false,workerStarted=false;
  const main=writes.withMain(async()=>{try{await writes.waitWithoutMain(async()=>{await network.promise;throw Error('network fixture');});}catch(error){assert.match(error.message,/network fixture/);continued=true;}});await delay(10);const independent=writes.withWorker(async()=>{workerStarted=true;await worker.promise;});await until(()=>workerStarted);network.resolve();await delay(20);assert.equal(continued,false);worker.resolve();await Promise.all([main,independent]);assert.equal(continued,true);await writes.withWorker(async()=>{});
});
test('closing a logical permit during a paused wait does not leak a counter or reserve it again',async()=>{
  const writes=new WriteCoordinator(),gate=deferred(),release=await writes.enterMain();const waiting=writes.withLeaseContext(release,()=>writes.waitWithoutMain(async()=>{await gate.promise;return 'done';}));release();await writes.withWorker(async()=>{});gate.resolve();assert.equal(await waiting,'done');await writes.withMain(()=>{});await writes.withWorker(async()=>{});
});

async function startRule(f){
  const rule=(await f.request('POST','/api/ai-rules',{name:'Body race',conditions:{feedId:f.source.id},actionType:'summary',maxItems:1})).json();
  const preview=(await f.request('GET',`/api/ai-rules/${rule.id}/preview`)).json();
  assert.equal((await f.request('POST',`/api/ai-rules/${rule.id}/enable`,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false})).statusCode,200);
  assert.equal((await f.request('POST',`/api/ai-rules/${rule.id}/run`,{})).statusCode,200);
  await bounded(f.ready.promise);return rule;
}
for(const replacement of [false,true])test(`AI rule body change during model wait ${replacement?'preserves and completes replacement generation':'fails stale generation and remains retryable'}`,async()=>{
  const f=await fixture();
  try{
    const rule=await startRule(f);
    await f.service.withDatabaseAccess(()=>f.db.setFullContent(f.id,'<p>Changed body with new information</p>'));
    if(replacement){const queued=await f.request('POST',`/api/ai-rules/${rule.id}/run`,{});assert.equal(queued.statusCode,200,queued.body);assert.equal(queued.json().queued,1);}
    f.gate.resolve();
    await until(()=>['failed','done'].includes(f.db.db.prepare('SELECT status FROM ai_rule_jobs WHERE rule_id=?').get(rule.id)?.status));
    const job=f.db.db.prepare('SELECT * FROM ai_rule_jobs WHERE rule_id=?').get(rule.id);
    if(replacement){assert.equal(job.status,'done');assert.equal(f.calls(),2);assert.ok(f.db.aiResult(f.id,'summary','zh-CN'));}
    else{assert.equal(job.status,'failed');assert.equal(f.db.aiResult(f.id,'summary','zh-CN'),undefined);const retry=await f.request('POST',`/api/ai-rules/${rule.id}/retry`,{});assert.equal(retry.json().queued,1);await until(()=>f.db.db.prepare('SELECT status FROM ai_rule_jobs WHERE rule_id=?').get(rule.id)?.status==='done');assert.equal(f.calls(),2);assert.ok(f.db.aiResult(f.id,'summary','zh-CN'));}
  }finally{await f.close();}
});
