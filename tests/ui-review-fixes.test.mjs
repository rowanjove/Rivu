import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';

const dom=new JSDOM('<div id="mount"></div>',{url:'https://app.invalid',pretendToBeVisual:true});
const saved=new Map(['window','document','HTMLElement','Event','Node','getComputedStyle','IS_REACT_ACT_ENVIRONMENT'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,Node:dom.window.Node,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});
globalThis.__reviewReact=React;globalThis.__reviewJsx=jsxRuntime;globalThis.__reviewApi={};
const {createRoot}=await import('react-dom/client');
const compiled=new Map();
async function component(name){
  if(compiled.has(name))return compiled.get(name);
  const built=await build({entryPoints:[`src/${name}.tsx`],bundle:true,format:'esm',platform:'node',write:false,jsx:'automatic',plugins:[{name:'controlled-ui-boundaries',setup(b){
    b.onResolve({filter:/^lucide-react$/},()=>({path:'lucide',namespace:'review-icons'}));
    b.onLoad({filter:/.*/,namespace:'review-icons'},()=>({contents:'export const X=()=>null;export const ChevronDown=()=>null;',loader:'js'}));
    b.onResolve({filter:/^(react|react\/jsx-runtime|\.\/api|\.\/useModalFocus|\.\/SourceIcon|\.\/article-images|\.\/AITagSuggestions|\.\/AIFilterReview)$/},a=>({path:a.path,namespace:'review'}));
    b.onLoad({filter:/.*/,namespace:'review'},({path})=>({loader:'js',contents:path==='react'?'export const {useEffect,useLayoutEffect,useMemo,useRef,useState}=globalThis.__reviewReact;':path==='react/jsx-runtime'?'export const {jsx,jsxs,Fragment}=globalThis.__reviewJsx;':path==='./api'?'export const api=globalThis.__reviewApi;':path==='./useModalFocus'?'export const useModalFocus=()=>{};':path==='./article-images'?'export const observeArticleImages=()=>()=>{};':`export const ${path.slice(2)}=()=>null;`}));
  }}]});
  const value=(await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64')))[name];compiled.set(name,value);return value;
}
const host=document.getElementById('mount');
const button=label=>[...host.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
const click=async label=>act(async()=>{const b=button(label);assert.ok(b,`Missing button ${label}`);assert.equal(b.disabled,false);b.click();});
const fill=async(input,value)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
test.after(()=>{dom.window.close();for(const [k,v] of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}for(const k of ['__reviewReact','__reviewJsx','__reviewApi'])delete globalThis[k];});

test('source preview rejects stale route responses, repeated Enter and mode changes',async()=>{
  const AddFeedDialog=await component('AddFeedDialog'),root=createRoot(host),pending=[],submissions=[];
  Object.assign(globalThis.__reviewApi,{get:async()=>[{id:'hub',name:'Fixture',enabled:1,base_url:'https://fixture.invalid'}],post:(path,body)=>path.endsWith('/preview')?new Promise(resolve=>pending.push({resolve,body})):Promise.resolve(submissions.push({path,body}))});
  try{
    await act(async()=>root.render(React.createElement(AddFeedDialog,{categories:[],onClose(){},onSubscribed:async()=>{}})));
    await click('RSSHub');let input=host.querySelector('input[placeholder="/github/repos/owner/repo"]');
    await fill(input,'/a');await click('预览');
    await act(async()=>input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
    assert.equal(pending.length,1,'busy Enter must not launch a duplicate');
    await fill(input,'/b');await click('预览');assert.equal(pending.length,2);
    await act(async()=>pending[0].resolve({title:'Old A',url:'https://fixture.invalid/a',items:[]}));
    assert.ok(!host.textContent.includes('Old A'));assert.equal(button('订阅'),undefined);
    await act(async()=>pending[1].resolve({title:'Current B',url:'https://fixture.invalid/b',items:[]}));
    assert.ok(host.textContent.includes('Current B'));await click('订阅');assert.equal(submissions[0].body.route,'/b');
    await fill(input,'/c');assert.equal(button('订阅'),undefined,'editing an accepted route invalidates it');await click('预览');await click('JSON API');
    await act(async()=>pending[2].resolve({title:'Old C',url:'https://fixture.invalid/c',items:[]}));assert.ok(!host.textContent.includes('Old C'));
  }finally{await act(async()=>root.unmount());}
});

test('offline and media failures remain visible, retry, and discard retired article reads',async()=>{
  const RichArticle=await component('RichArticle'),EntryMedia=await component('EntryMedia'),root=createRoot(host),reads=[];
  Object.assign(globalThis.__reviewApi,{get:path=>new Promise((resolve,reject)=>reads.push({path,resolve,reject}))});
  const entry={id:'a',url:'https://fixture.invalid/a',content:'<p>Saved local body</p>'};
  const render=async id=>act(async()=>root.render(React.createElement(React.Fragment,null,React.createElement(RichArticle,{entry:{...entry,id},onUpdated(){},linkTarget:'external'}),React.createElement(EntryMedia,{key:id,entry:{...entry,id},expanded:false}))));
  try{
    await render('a');assert.match(host.textContent,/正在检查本地保存状态/);assert.ok(!host.textContent.includes('订阅仅含标题'));
    await act(async()=>{reads[0].reject(Error('offline unavailable'));reads[1].reject(Error('media unavailable'));});
    assert.match(host.textContent,/暂时无法确认本地保存状态/);assert.match(host.textContent,/媒体信息读取失败/);assert.ok(!host.textContent.includes('订阅仅含标题'));
    await click('重试保存状态');await click('重试媒体信息');
    await act(async()=>{reads[2].resolve({feedBody:true,fullText:true,images:{total:0,cached:0}});reads[3].resolve([]);});
    assert.match(host.textContent,/全文已在本地/);assert.ok(!host.textContent.includes('读取失败'));
    await render('b');const retired=reads.slice(-2);await render('c');
    await act(async()=>{retired[0].resolve({feedBody:false,fullText:false,images:{total:0,cached:0}});retired[1].reject(Error('retired failure'));});
    assert.ok(!host.textContent.includes('retired failure'));assert.ok(!host.textContent.includes('订阅仅含标题'));
  }finally{await act(async()=>root.unmount());}
});

test('chat recovery preserves the original send error when preview recovery also fails',async()=>{
  const AIChatPanel=await component('AIChatPanel'),root=createRoot(host);let failed=false;
  Object.assign(globalThis.__reviewApi,{get:async()=>[],post:async path=>{if(path==='/api/ai/chat/messages'){failed=true;throw Error('first response lost');}if(failed)throw Error('preview temporarily unavailable');return {entryIds:['a'],sources:[],model:'fixture',provider:'http://localhost',contextLength:0};}});
  try{
    await act(async()=>root.render(React.createElement(AIChatPanel,{scopeIds:['a'],onClose(){},onNavigate(){},onConfigure(){}})));
    await act(async()=>{const input=host.querySelector('textarea');Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(input,'Question');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click('发送并允许本次内容');
    assert.match(host.querySelector('[role=alert]').textContent,/first response lost/);
    assert.ok(button('重试并获取上次结果'));
  }finally{await act(async()=>root.unmount());}
});

test('idle AI tools read full caches once; version changes refresh current results',async t=>{
  const AIBlock=await component('AIBlock'),root=createRoot(host);let revision=0,cacheReads=0,summary='Old result';
  Object.assign(globalThis.__reviewApi,{get:async path=>{if(path==='/api/ai/results-version')return {revision,running:false};cacheReads++;return path.endsWith('type=summary')?{content:summary}:null;}});
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    await act(async()=>root.render(React.createElement(AIBlock,{entry:{id:'a'},onTranslationVisible(){},onTagsChanged:async()=>{}})));
    await click('AI 阅读工具');assert.equal(cacheReads,7);assert.match(host.textContent,/Old result/);
    await act(async()=>t.mock.timers.tick(5000));assert.equal(cacheReads,7,'unchanged cache must not be re-read');
    summary='Fresh rule result';revision++;
    await act(async()=>t.mock.timers.tick(10000));assert.equal(cacheReads,14);assert.match(host.textContent,/Fresh rule result/);
    summary='';
    await act(async()=>root.render(React.createElement(AIBlock,{entry:{id:'a',full_content:'A different full text'},onTranslationVisible(){},onTagsChanged:async()=>{}})));
    assert.equal(cacheReads,21,'same article body changes must invalidate the displayed cache');assert.ok(!host.textContent.includes('Fresh rule result'));
  }finally{await act(async()=>root.unmount());t.mock.timers.reset();}
});
