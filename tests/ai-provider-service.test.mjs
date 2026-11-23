import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createService} from '../dist-server/service.js';
import {providerFixture} from './ai-provider-fixture.mjs';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
test('production service parses large provider JSON in Worker and rejects bad replies before persistence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-provider-service-')),fixture=await providerFixture(),db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'token',join(dir,'settings.json'));
 const request=(method,url,payload)=>service.app.inject({method,url,headers:{'x-rivu-token':'token'},...(payload?{payload}:{})});
 const parse=JSON.parse;let mainParses=0;JSON.parse=function(value,...args){if(typeof value==='string'&&value.length>1024*1024&&value.includes(fixture.marker))mainParses++;return parse.call(this,value,...args);};
 try{
  const feed=db.addFeed({title:'fixture',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'fixture',content:'本地正文',hash:'fixture'}]);const id=db.entries()[0].id;
  assert.equal((await request('PATCH','/api/ai/settings',{baseUrl:fixture.url,model:'fixture'})).statusCode,200);
  assert.equal((await request('POST','/api/ai/test',{})).statusCode,200);
  fixture.setMode('model-large');assert.equal((await request('POST','/api/ai/test',{})).statusCode,502);
  fixture.setMode('http-error');assert.notEqual((await request('POST','/api/ai/test',{})).statusCode,200);
  const until=Date.now()+2000;while(!fixture.closed&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fixture.closed,1,'non-2xx models body canceled promptly');
  const preview=(await request('GET',`/api/entries/${id}/ai/preview?type=summary`)).json(),payload={type:'summary',scopeHash:preview.scopeHash};
  for(const mode of ['declared','streamed','content-large','invalid-json','invalid-utf8']){
   fixture.setMode(mode);const response=await request('POST',`/api/entries/${id}/ai`,payload);assert.equal(response.statusCode,502,`${mode}: ${response.body}`);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_results').get().n,0);
  }
  fixture.setMode('valid');const response=await request('POST',`/api/entries/${id}/ai`,payload);assert.equal(response.statusCode,200,response.body);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_results').get().n,1);assert.equal(mainParses,0);
  fixture.setMode('invalid-json');const chat=(await request('POST','/api/ai/chat/preview',{entryIds:[id]})).json(),chatPayload={entryIds:[id],question:'问题',contextHash:chat.contextHash,requestId:'provider-failed-key-0001'};
  assert.equal((await request('POST','/api/ai/chat/messages',chatPayload)).statusCode,502);const calls=fixture.calls;fixture.setMode('valid');assert.equal((await request('POST','/api/ai/chat/messages',chatPayload)).statusCode,409);assert.equal(fixture.calls,calls);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_messages').get().n,0);
  assert.equal((await request('POST','/api/ai/chat/messages',{...chatPayload,requestId:'provider-fresh-key-0001'})).statusCode,200);assert.equal(db.db.prepare('SELECT count(*) n FROM ai_messages').get().n,2);assert.equal(mainParses,0);
 }finally{JSON.parse=parse;await service.stop();db.close();await fixture.close();rmSync(dir,{recursive:true,force:true});}
});

