import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright-core';
import {providerFixture} from './ai-provider-fixture.mjs';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-provider-exe-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-provider-exe-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'fixture',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'fixture',content:'本地正文',hash:'fixture'}]);db.updateFeed(feed.id,{enabled:false});const id=db.entries()[0].id;db.close();
const fixture=await providerFixture();let app;const errors=[];
try{
 app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(page);page.on('pageerror',error=>errors.push(error.message));
 await page.evaluate(()=>{window.__providerRejections=[];window.addEventListener('unhandledrejection',event=>window.__providerRejections.push(String(event.reason)));});
 await app.evaluate((_,marker)=>{globalThis.__providerParse=JSON.parse;globalThis.__providerParses=0;JSON.parse=function(value,...args){if(typeof value==='string'&&value.length>1024*1024&&value.includes(marker))globalThis.__providerParses++;return globalThis.__providerParse.call(this,value,...args);};},fixture.marker);
 const request=(method,url,body)=>page.evaluate(async({method,url,body})=>{try{return {ok:true,value:await window.rivu.request(method,url,body)};}catch(error){return {ok:false,error:String(error)};}},{method,url,body});
 assert.equal((await request('PATCH','/api/ai/settings',{baseUrl:fixture.url,model:'fixture'})).ok,true);
 assert.equal((await request('POST','/api/ai/test',{})).ok,true);fixture.setMode('model-large');assert.equal((await request('POST','/api/ai/test',{})).ok,false);
 const preview=await request('GET',`/api/entries/${id}/ai/preview?type=summary`);assert.equal(preview.ok,true);const payload={type:'summary',scopeHash:preview.value.scopeHash};
 for(const mode of ['declared','streamed','content-large','invalid-json','invalid-utf8']){fixture.setMode(mode);const response=await request('POST',`/api/entries/${id}/ai`,payload);assert.equal(response.ok,false,mode);const cache=await request('GET',`/api/entries/${id}/ai?type=summary`);assert.equal(cache.ok,true);assert.equal(cache.value,null);}
 fixture.setMode('valid');const summary=await request('POST',`/api/entries/${id}/ai`,payload);assert.equal(summary.ok,true,summary.error);assert.ok(JSON.stringify(summary.value).includes('本地模拟回答'));
 const previewChat=await request('POST','/api/ai/chat/preview',{entryIds:[id]}),chat={entryIds:[id],question:'问题',contextHash:previewChat.value.contextHash,requestId:'desktop-provider-key-0001'};fixture.setMode('invalid-json');assert.equal((await request('POST','/api/ai/chat/messages',chat)).ok,false);const calls=fixture.calls;fixture.setMode('valid');assert.equal((await request('POST','/api/ai/chat/messages',chat)).ok,false);assert.equal(fixture.calls,calls);assert.equal((await request('POST','/api/ai/chat/messages',{...chat,requestId:'desktop-provider-new-0001'})).ok,true);
 assert.equal(await app.evaluate(()=>globalThis.__providerParses),0);assert.deepEqual(await page.evaluate(()=>window.__providerRejections),[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({largePaddingMiB:6,mainProviderJsonParses:0,rejectedModes:5,noFailedCache:true,noAutomaticChatResend:true,explicitRecovery:true,errors}));
}finally{if(app){await app.evaluate(()=>{if(globalThis.__providerParse)JSON.parse=globalThis.__providerParse;}).catch(()=>{});await app.close();}await fixture.close();rmSync(directory,{recursive:true,force:true});}
