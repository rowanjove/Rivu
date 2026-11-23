import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {AIService} from '../dist-server/ai.js';
import {FeedParser} from '../dist-server/feed-parser.js';
import {createService} from '../dist-server/service.js';
import {createServer} from 'node:http';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-ai-body-')),db=new RivuDatabase(join(dir,'rivu.db')),feed=db.addFeed({title:'Local',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'A',content:'<p>Alpha</p><script>hidden</script><p>Next</p>',hash:'a'},{title:'B',content:'<p>Beta</p>',hash:'b'}]);return {dir,db,entries:db.entries()};}
test('AI text worker preserves paragraph semantics, isolates concurrent prepared scopes and reuses bounded cache',async()=>{
  const f=fixture(),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));let parses=0;
  const ai=new AIService(f.db,undefined,undefined,html=>{parses++;return parser.aiText(html);});
  try{const results=await Promise.all(f.entries.map(entry=>ai.withPreparedBodies([entry.id],()=>ai.previewAction(entry.id,'summary'))));
    assert.match(results.find(result=>result.title==='A').body,/Alpha\nNext/);assert.doesNotMatch(results.find(result=>result.title==='A').body,/hidden|Beta/);assert.equal(results.find(result=>result.title==='B').body,'Beta');assert.equal(parses,2);
    const preview=await ai.withPreparedBodies(f.entries.map(entry=>entry.id),()=>ai.preview(f.entries.map(entry=>entry.id)));assert.equal(new Set(preview.sources.map(source=>source.entryId)).size,2);assert.equal(parses,2);
    assert.throws(()=>ai.previewAction(f.entries[0].id,'summary'),/未准备/);
    const a=f.entries.find(entry=>entry.title==='A'),b=f.entries.find(entry=>entry.title==='B');f.db.setFullContent(b.id,a.content);
    const shared=await ai.withPreparedBodies([b.id],()=>ai.previewAction(b.id,'summary'));assert.equal(parses,2);assert.equal(shared.title,'B');assert.match(shared.body,/Alpha\nNext/);
  }finally{await parser.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('AI source changes while worker preparation waits reject before the action runs',async()=>{
  const f=fixture();let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);let acted=false;
  const ai=new AIService(f.db,undefined,undefined,async()=>{started();await gate;return 'Old body';});
  try{const id=f.entries[0].id,pending=ai.withPreparedBodies([id],()=>{acted=true;return ai.previewAction(id,'summary');});await ready;f.db.setFullContent(id,'<p>Changed</p>');release();await assert.rejects(pending,error=>error.statusCode===409);assert.equal(acted,false);
  }finally{release();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('AI preparation rejects oversized retained input before spawning a parser',async()=>{
  let parses=0,acted=false;const ai=new AIService({aiBodySnapshot:()=>({title:'Large',html:'x'.repeat(34*1024*1024),body_revision:'0'.repeat(32)})},undefined,undefined,async()=>{parses++;return '';});
  await assert.rejects(ai.withPreparedBodies(['large'],()=>{acted=true;}),error=>error.statusCode===503&&error.resourceBusy);assert.equal(parses,0);assert.equal(acted,false);
});
test('AI settings changes during preparation reject before starting an action with a changed Provider',async()=>{
  const f=fixture();let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);let acted=false;
  const ai=new AIService(f.db,undefined,undefined,async()=>{started();await gate;return 'Body';});
  try{const pending=ai.withPreparedBodies([f.entries[0].id],()=>{acted=true;return ai.previewAction(f.entries[0].id,'keywords');});await ready;ai.configure({baseUrl:'https://provider.invalid/v1',model:'changed'});release();await assert.rejects(pending,error=>error.statusCode===409);assert.equal(acted,false);
  }finally{release();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('first chat followers replay the started request when settings and source change during their preparation',async()=>{
  const f=fixture();let modelRelease,modelStarted,releaseA,releaseB,startedA,startedB,held=false,prepares=0,oldCalls=0,newCalls=0;
  const modelGate=new Promise(resolve=>modelRelease=resolve),modelReady=new Promise(resolve=>modelStarted=resolve),gateA=new Promise(resolve=>releaseA=resolve),gateB=new Promise(resolve=>releaseB=resolve),readyA=new Promise(resolve=>startedA=resolve),readyB=new Promise(resolve=>startedB=resolve);
  const oldProvider=createServer(async(req,res)=>{oldCalls++;for await(const _ of req){}modelStarted();await modelGate;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Answer [1]'}}]}));});
  const newProvider=createServer((_req,res)=>{newCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Wrong Provider'}}]}));});
  await Promise.all([new Promise(resolve=>oldProvider.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>newProvider.listen(0,'127.0.0.1',resolve))]);
  const ai=new AIService(f.db,undefined,undefined,async()=>{if(held){const n=++prepares;if(n===1){startedA();await gateA;}else{startedB();await gateB;}}return 'Body';});
  try{const id=f.entries[0].id;f.db.setFullContent(id,'<p>Body</p>');ai.configure({baseUrl:`http://127.0.0.1:${oldProvider.address().port}/v1`,model:'old'});const preview=await ai.withPreparedBodies([id],()=>ai.preview([id],{question:'Question'}));f.db.setFullContent(id,'<div>Body</div>');held=true;
    const a=ai.startConversation([id],'Question',preview.contextHash,'same_request_0123456789');await readyA;const b=ai.startConversation([id],'Question',preview.contextHash,'same_request_0123456789');await readyB;releaseA();await modelReady;
    ai.configure({baseUrl:`http://127.0.0.1:${newProvider.address().port}/v1`,model:'new'});f.db.setFullContent(id,'<p>Changed after request began</p>');releaseB();modelRelease();const [first,follower]=await Promise.all([a,b]);assert.equal(first.id,follower.id);assert.equal(oldCalls,1);assert.equal(newCalls,0);assert.equal(first.messages.length,2);
    assert.equal((await ai.startConversation([id],'Question',preview.contextHash,'same_request_0123456789')).id,first.id);assert.equal(oldCalls,1);
  }finally{releaseA();releaseB();modelRelease();f.db.close();await Promise.all([new Promise(resolve=>oldProvider.close(resolve)),new Promise(resolve=>newProvider.close(resolve))]);rmSync(f.dir,{recursive:true,force:true});}
});
test('AI rule preview prepares all 20 supported samples while chat still rejects 11 articles',async()=>{
  const f=fixture();const feedId=f.entries[0].feed_id;f.db.addEntries(feedId,Array.from({length:18},(_,i)=>({title:`Rule ${i}`,content:'<p>Local rule body</p>',hash:`rule-${i}`})));const service=createService(f.db,'token');
  const request=(url,payload)=>service.app.inject({method:'POST',url,payload,headers:{'x-rivu-token':'token'}});
  try{const preview=await request('/api/ai-rules/preview',{name:'20 samples',conditions:{},actionType:'summary',maxItems:20});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().sample.length,20);assert.ok(preview.json().sample.every(item=>item.chars>0&&item.prompt&&!item.error));
    const chat=await request('/api/ai/chat/preview',{entryIds:f.db.entries().slice(0,11).map(entry=>entry.id)});assert.equal(chat.statusCode,400,chat.body);assert.match(chat.json().error,/1 至 10/);
  }finally{await service.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
