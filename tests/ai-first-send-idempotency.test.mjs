import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createService} from '../dist-server/service.js';
import {createBackup,restoreBackup} from '../dist-server/backup.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');

test('first-send keys merge concurrent requests and replay committed history across restart without model calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-first-idempotent-'));let calls=0,release=()=>{},started=()=>{};
  let gate=new Promise(resolve=>{started=resolve;});
  const fixture=createServer(async(req,res)=>{calls++;for await(const chunk of req){}started();await new Promise(resolve=>{release=resolve;});res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'正文依据 [1]'}}]}));});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const path=join(dir,'rivu.db'),settings=join(dir,'settings.json');let db=new RivuDatabase(path),service=createService(db,'token',settings);
  const headers={'x-rivu-token':'token'},request=(method,url,payload)=>service.app.inject({method,url,headers,...(payload?{payload}:{})});
  try{
    const feed=db.addFeed({title:'源',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'正文',content:'本地正文',hash:'one'}]);
    const entryIds=[db.entries()[0].id];
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${fixture.address().port}/v1`,model:'fixture'});
    const preview=(await request('POST','/api/ai/chat/preview',{entryIds})).json();
    const payload={entryIds,question:'说了什么？',contextHash:preview.contextHash,requestId:'first-request-key-0001'},url='/api/ai/chat/messages';
    assert.equal((await request('POST',url,{...payload,requestId:'short'})).statusCode,400);
    assert.equal(calls,0);
    const first=request('POST',url,payload);await gate;
    assert.equal(db.db.prepare('SELECT count(*) n FROM ai_conversations').get().n,0);
    const second=request('POST',url,payload);
    assert.equal((await request('POST',url,{...payload,question:'不同问题'})).statusCode,409);assert.equal(calls,1);
    release();const responses=await Promise.all([first,second]);
    responses.forEach(response=>assert.equal(response.statusCode,200,response.body));assert.equal(responses[0].json().id,responses[1].json().id);
    const id=responses[0].json().id;
    assert.equal(db.db.prepare('SELECT count(*) n FROM ai_messages').get().n,2);
    assert.equal((await request('POST',url,payload)).json().id,id);assert.equal(calls,1);
    await request('PATCH','/api/ai/settings',{model:'changed-model'});db.setFullContent(entryIds[0],'新正文');
    assert.equal((await request('POST',url,payload)).json().id,id,'completed request returns its accepted result despite later settings/body changes');
    await service.stop();db.close();db=new RivuDatabase(path);service=createService(db,'token',settings);
    assert.equal((await request('POST',url,payload)).json().id,id);assert.equal(calls,1);
    const zip=join(dir,'chat.zip'),restored=join(dir,'restored');await createBackup(db,dir,zip);await restoreBackup(zip,restored);
    const copy=new RivuDatabase(join(restored,'rivu.db')),copyService=createService(copy,'token',join(restored,'settings.json'));
    try{const replay=await copyService.app.inject({method:'POST',url,headers,payload});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().id,id);assert.equal(calls,1);}finally{await copyService.stop();copy.close();}
    await request('DELETE',`/api/ai/conversations/${id}`);
    assert.equal((await request('POST',url,payload)).statusCode,410);assert.equal(calls,1);
    const current=(await request('POST','/api/ai/chat/preview',{entryIds})).json();
    const interrupted={...payload,requestId:'interrupted-key-0001',contextHash:current.contextHash};
    const fingerprint=createHash('sha256').update(JSON.stringify({entryIds,question:interrupted.question,contextHash:interrupted.contextHash})).digest('hex');
    db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run(`ai_chat_request:${interrupted.requestId}`,JSON.stringify({fingerprint,status:'pending'}));
    await service.stop();db.close();db=new RivuDatabase(path);service=createService(db,'token',settings);
    assert.equal((await request('POST',url,interrupted)).statusCode,409);assert.equal(calls,1,'interrupted request must never silently call provider again');
    db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('ai_chat_request:corrupted-key-0001','not JSON');
    assert.equal((await request('POST',url,{...interrupted,requestId:'corrupted-key-0001'})).statusCode,409);assert.equal(calls,1);
  }finally{release();await service.stop();db.close();await new Promise(resolve=>fixture.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('failed provider or atomic commit stays non-replayable under the same key and leaves no partial chat',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-first-failure-'));let calls=0,fail=true;
  const fixture=createServer(async(req,res)=>{calls++;for await(const chunk of req){}res.setHeader('content-type','application/json');if(fail){res.statusCode=503;res.end('{}');}else res.end(JSON.stringify({choices:[{message:{content:'回答 [1]'}}]}));});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'token'),headers={'x-rivu-token':'token'},request=(method,url,payload)=>service.app.inject({method,url,headers,payload});
  try{
    const feed=db.addFeed({title:'源',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'文章',content:'正文',hash:'one'}]);const entryIds=[db.entries()[0].id];
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${fixture.address().port}/v1`,model:'fixture'});
    const preview=(await request('POST','/api/ai/chat/preview',{entryIds})).json(),payload={entryIds,question:'问题',contextHash:preview.contextHash,requestId:'failed-request-key-0001'},url='/api/ai/chat/messages';
    assert.notEqual((await request('POST',url,payload)).statusCode,200);assert.equal(calls,1);
    fail=false;assert.equal((await request('POST',url,payload)).statusCode,409);assert.equal(calls,1);
    db.db.exec("CREATE TRIGGER fail_first_assistant BEFORE INSERT ON ai_messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END");
    const failedCommit={...payload,requestId:'commit-failure-key-0001'};
    assert.equal((await request('POST',url,failedCommit)).statusCode,500);
    assert.equal(db.db.prepare('SELECT count(*) n FROM ai_messages').get().n,0);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_conversations').get().n,0);
    db.db.exec('DROP TRIGGER fail_first_assistant');
    assert.equal((await request('POST',url,failedCommit)).statusCode,409);assert.equal(calls,2);
    const fresh=await request('POST',url,{...payload,requestId:'explicit-new-key-0001'});assert.equal(fresh.statusCode,200,fresh.body);assert.equal(calls,3);
  }finally{await service.stop();db.close();await new Promise(resolve=>fixture.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
