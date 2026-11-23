import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createService } from '../dist-server/service.js';
import { createBackup, restoreBackup } from '../dist-server/backup.js';
const { RivuDatabase }=createRequire(import.meta.url)('../dist-server/database.cjs');

test('expanded reading actions require current consent, preserve original content and bind custom prompts to budgets and caches',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-expanded-')),db=new RivuDatabase(join(dir,'rivu.db')),requests=[];
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:`审阅草稿 ${body.messages[0].content}`}}]}));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  let service=createService(db,'expanded-token',join(dir,'settings.json'));
  const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'expanded-token'},...(payload!==undefined?{payload}:{})});
  try{
    const feed=db.addFeed({title:'测试来源',url:'https://example.com/expanded'});db.addEntries(feed.id,[{title:'待解释文章',content:`<p>${'证据😀'.repeat(2000)}</p>`,hash:'expanded'}]);const id=db.entries()[0].id;
    for(const value of [null,123,'x'.repeat(4001)])assert.equal((await request('PATCH','/api/ai/settings',{customPrompt:value})).statusCode,400);
    assert.equal((await request('GET',`/api/entries/${id}/ai/preview?type=custom`)).statusCode,400);
    await request('PATCH','/api/ai/settings',{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'fallback',askModel:'reading-model',tagModel:'tag-model',contextLength:4096,maxTokens:500,customPrompt:'提取有证据的问题与结论。'});
    const original=db.entry(id).content;
    for(const type of ['explain','rewrite','custom','keywords','classification']){
      if(['explain','rewrite','custom'].includes(type))assert.equal((await request('POST',`/api/entries/${id}/ai`,{type})).statusCode,409);
      const before=requests.length,preview=(await request('GET',`/api/entries/${id}/ai/preview?type=${type}`)).json();
      assert.equal(requests.length,before);assert.ok(preview.scopeHash);assert.equal(preview.truncated,true);
      const response=await request('POST',`/api/entries/${id}/ai`,{type,scopeHash:preview.scopeHash});assert.equal(response.statusCode,200,response.body);
      const sent=requests.at(-1);assert.equal(sent.messages[0].content,preview.systemPrompt);assert.equal(sent.messages[1].content,preview.prompt);
      assert.equal(sent.model,['keywords','classification'].includes(type)?'tag-model':'reading-model');
      assert.ok(256+sent.messages.reduce((n,m)=>n+16+Buffer.byteLength(m.content),0)+sent.max_tokens<=4096);
      assert.equal(db.entry(id).content,original);
      assert.equal((await request('POST',`/api/entries/${id}/ai`,{type,scopeHash:preview.scopeHash})).json().cached,true);
      assert.equal(requests.length,before+1);
    }
    const old=(await request('GET',`/api/entries/${id}/ai/preview?type=custom`)).json(),before=requests.length;
    await request('PATCH','/api/ai/settings',{customPrompt:'只列正文中的数字和对应事实。'});
    assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'custom',scopeHash:old.scopeHash})).statusCode,409);assert.equal(requests.length,before);
    assert.equal((await request('GET',`/api/entries/${id}/ai?type=custom`)).json(),null);
    assert.ok((await request('GET',`/api/entries/${id}/ai?type=explain`)).json().content,'无关提示词变化保留解释缓存');
    const fresh=(await request('GET',`/api/entries/${id}/ai/preview?type=custom`)).json();await request('PATCH','/api/ai/settings',{askModel:'changed-reading-model'});
    assert.equal((await request('POST',`/api/entries/${id}/ai`,{type:'custom',scopeHash:fresh.scopeHash})).statusCode,409);assert.equal(requests.length,before);
    await service.stop();service=createService(db,'expanded-token',join(dir,'settings.json'));
    assert.equal((await request('GET','/api/ai/settings')).json().customPrompt,'只列正文中的数字和对应事实。');
    const backup=join(dir,'expanded.zip'),restored=join(dir,'restored');await createBackup(db,dir,backup);await restoreBackup(backup,restored);
    assert.equal(JSON.parse(readFileSync(join(restored,'settings.json'),'utf8')).ai.customPrompt,'只列正文中的数字和对应事实。');
    db.setFullContent(id,'<p>更新后的正文</p>');assert.equal(db.db.prepare("SELECT count(*) n FROM ai_results WHERE entry_id=? AND type IN ('explain','rewrite','custom')").get(id).n,0);
    await request('PATCH','/api/ai/settings',{customPrompt:'长提示'.repeat(1300)});const count=requests.length;
    assert.equal((await request('GET',`/api/entries/${id}/ai/preview?type=custom`)).statusCode,400);assert.equal(requests.length,count);
    assert.equal((await request('GET',`/api/entries/${id}/ai/preview?type=unknown`)).statusCode,400);
  }finally{await service.stop();db.close();await new Promise(resolve=>provider.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
