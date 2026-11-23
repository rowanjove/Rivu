import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<main id="mount"></main>',{url:'https://app.invalid/'});
const originalEvent=globalThis.Event;globalThis.Event=dom.window.Event;
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.__articleApi={get:()=>new Promise(()=>{}),post:()=>{throw Error("Unexpected action")}};
globalThis.__articleReact=React;globalThis.__articleJsx=jsxRuntime;globalThis.__articleObservers=[];
const {createRoot}=await import('react-dom/client');
const plugins=[{name:'article-test-bindings',setup(b){
 b.onResolve({filter:/^(react|react\/jsx-runtime|\.\/api|\.\/article-images)$/},args=>({path:args.path,namespace:'article-test'}));
 b.onLoad({filter:/.*/,namespace:'article-test'},({path})=>({loader:'js',contents:path==='react'?'export const {useEffect,useLayoutEffect,useMemo,useRef,useState}=globalThis.__articleReact;':path==='react/jsx-runtime'?'export const {jsx,jsxs,Fragment}=globalThis.__articleJsx;':path==='./api'?'export const api=globalThis.__articleApi;':'export function observeArticleImages(root,id){const row={id,root,startedWithChildren:root.childNodes.length,released:false};globalThis.__articleObservers.push(row);return()=>{row.released=true;row.releasedWithChildren=root.childNodes.length;};}'}));
}}];
const built=await build({entryPoints:['src/RichArticle.tsx'],bundle:true,format:'esm',platform:'node',write:false,plugins});
const {RichArticle}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
test.after(()=>{globalThis.Event=originalEvent;dom.window.close();for(const key of ['window','document','IS_REACT_ACT_ENVIRONMENT','__articleReact','__articleJsx','__articleObservers','__articleApi'])delete globalThis[key];});

test('real React StrictMode reuses sanitized nodes, preserves unchanged DOM and cleans images before replacement',async()=>{
 const host=document.getElementById('mount'),root=createRoot(host);
 const entry={id:'a',url:'https://source.invalid/post',content:'<pre>\n\n keep &lt;x&gt;</pre><p>A 中文</p><img src="/a.png" onerror="bad()"><script>bad()</script>',full_content:null,description:null};
 const render=async value=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(RichArticle,{entry:value,onUpdated(){},linkTarget:'external'}))));
 try{
  await render(entry);let body=host.querySelector('.rich-body');assert.ok(body.textContent.includes('A 中文'));assert.equal(body.querySelector('pre').textContent,'\n keep <x>');assert.equal(body.querySelectorAll('[src],[onerror],script').length,0);assert.equal(body.querySelector('img').dataset.rivuUrl,'https://source.invalid/a.png');
  const node=body.firstChild;body.scrollTop=17;await render({...entry,read:1});assert.equal(host.querySelector('.rich-body').firstChild,node);assert.equal(body.scrollTop,17);
  await render({...entry,id:'b',content:'<p>B exact</p><img src="/b.png">'});body=host.querySelector('.rich-body');assert.equal(node.isConnected,false);assert.ok(body.textContent.includes('B exact'));assert.equal(body.querySelector('img').dataset.rivuUrl,'https://source.invalid/b.png');
  await render({...entry,id:'empty',content:''});assert.equal(host.querySelector('.rich-body'),null);assert.ok(host.textContent.includes('此订阅只提供了文章标题'));
  await render({...entry,id:'back',content:'<p>Restored body</p>'});assert.equal(host.querySelector('.rich-body').textContent,'Restored body');assert.ok(!host.textContent.includes('此订阅只提供了文章标题'));
 }finally{await act(async()=>root.unmount());}
 assert.ok(globalThis.__articleObservers.length>=3);
 for(const row of globalThis.__articleObservers){assert.equal(row.released,true);assert.ok(row.startedWithChildren>0);assert.ok(row.releasedWithChildren>0);}
});


test('article actions ignore stale completions across navigation and same-id return',async()=>{
 const host=document.getElementById('mount'),root=createRoot(host),updates=[];
 const entry={id:'a',url:'https://source.invalid/post',content:'<p>Body</p>'};
 const pending=[];globalThis.__articleApi.post=(url)=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}));
 const render=async id=>act(async()=>root.render(React.createElement(RichArticle,{entry:{...entry,id},onUpdated:value=>updates.push(value),linkTarget:'external'})));
 const click=async label=>act(async()=>{const button=[...host.querySelectorAll('button')].find(node=>node.textContent===label);assert.ok(button);assert.equal(button.disabled,false);button.click();});
 try{
  await render('a');await click('获取全文');assert.ok(host.textContent.includes('正在处理'));
  await render('b');assert.ok(!host.textContent.includes('正在处理'));
  await click('获取全文');
  await act(async()=>pending[0].reject(Error('Old article failed')));
  assert.ok(!host.textContent.includes('Old article failed'));assert.ok(host.textContent.includes('正在处理'));
  await act(async()=>pending[1].resolve({...entry,id:'b',full_content:'New body'}));assert.equal(updates.length,1);assert.equal(updates[0].id,'b');
  await click('永久归档当前正文');await render('a');await render('b');
  await act(async()=>pending[2].resolve({newVersion:true,assetsAdded:99,errors:[]}));
  assert.ok(!host.textContent.includes('新增 99 个资源'));
  await click('获取全文');await render('a');
  await act(async()=>pending[3].resolve({...entry,id:'b'}));assert.equal(updates.length,1);
  await click('保存全文和配图');await render('b');
  let detailReads=0;globalThis.__articleApi.get=()=>{detailReads++;return new Promise(()=>{});};
  await act(async()=>pending[4].resolve({images:{total:9,cached:9},feedBody:true,fullText:true}));
  assert.equal(detailReads,0);assert.ok(!host.textContent.includes('9/9'));assert.equal(updates.length,1);
  let resolveDetail;globalThis.__articleApi.get=url=>url.endsWith('/offline')?new Promise(()=>{}):new Promise(resolve=>{resolveDetail=resolve;});
  await click('保存全文和配图');
  await act(async()=>pending[5].resolve({images:{total:1,cached:1},feedBody:true,fullText:true}));
  assert.equal(typeof resolveDetail,'function');assert.ok(host.textContent.includes('1/1'));
  await render('a');await act(async()=>resolveDetail({...entry,id:'b',saved:1}));assert.equal(updates.length,1);
  await click('获取全文');await act(async()=>root.unmount());
  await act(async()=>pending[6].resolve(entry));assert.equal(updates.length,1);
 }finally{await act(async()=>root.unmount());globalThis.__articleApi.get=()=>new Promise(()=>{});}
});

test('native accessibility reveal preserves mounted source nodes and active selection',async()=>{
 const host=document.getElementById('mount'),root=createRoot(host),oldScheduler=globalThis.scheduler,oldCSS=window.CSS,oldBridge=window.rivu;
 let notify;window.rivu={accessibilitySupportEnabled:()=>false,onAccessibilitySupportChanged:callback=>{notify=callback;return()=>{notify=null;};}};
 Object.defineProperty(window,'CSS',{configurable:true,value:{supports:()=>true}});
 globalThis.scheduler={postTask:(_callback,{signal})=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
 const entry={id:'a11y-source',content:Array.from({length:700},(_,i)=>`<p>Paragraph ${i} ${'plain source text '.repeat(15)}</p>`).join('')};
 try{
  await act(async()=>root.render(React.createElement(RichArticle,{entry,onUpdated(){},linkTarget:'external'})));
  const body=host.querySelector('.rich-body'),node=body.querySelector('p'),text=node.firstChild,selection=window.getSelection();assert.equal(body.dataset.rivuLayoutMode,'groups');
  selection.setBaseAndExtent(text,3,text,20);const expected=selection.toString(),observerCount=globalThis.__articleObservers.length;
  await act(async()=>notify(true));assert.equal(body.dataset.rivuLayout,undefined);assert.equal(body.firstElementChild,node);assert.equal(selection.toString(),expected);assert.equal(globalThis.__articleObservers.length,observerCount);
  await act(async()=>notify(false));assert.equal(body.dataset.rivuLayout,undefined);assert.equal(body.firstElementChild,node);
  selection.removeAllRanges();
 }finally{
  await act(async()=>root.unmount());window.rivu=oldBridge;Object.defineProperty(window,'CSS',{configurable:true,value:oldCSS});
  if(oldScheduler===undefined)delete globalThis.scheduler;else globalThis.scheduler=oldScheduler;
 }
});
