import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const built=await build({entryPoints:['src/article-layout-session.ts'],bundle:true,format:'esm',write:false});
const {startArticleLayout,waitForArticleLayout}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
function fixture(){const dom=new JSDOM('<main>'+('<p>Body</p>'.repeat(24))+'<table><tr><td><p>Cell</p></td></tr></table></main>');Object.defineProperty(dom.window,'CSS',{value:{supports:()=>true}});return {dom,root:dom.window.document.querySelector('main')};}
test('eligible session completes, restores paragraph styles and keeps table content untouched',async()=>{
 const f=fixture();try{
  const session=startArticleLayout(f.root,200000,{yieldTask:async()=>{}});assert.ok(session);assert.equal(f.root.dataset.rivuLayout,'pending');
  const ready=waitForArticleLayout(f.root,new AbortController().signal);assert.equal((await session.finished).completed,true);assert.equal(await ready,true);
  assert.equal(f.root.dataset.rivuLayout,undefined);assert.equal(f.root.querySelectorAll('p').length,25);assert.ok([...f.root.querySelectorAll('p')].every(p=>!p.style.contentVisibility));assert.equal(f.root.querySelector('td').textContent,'Cell');
 }finally{f.dom.window.close();}
});
test('cancellation releases waiters and an old completion cannot clear a new pending session',async()=>{
 const f=fixture(),queue=[];try{
  const old=startArticleLayout(f.root,200000,{yieldTask:()=>new Promise(done=>queue.push(done))});const ready=waitForArticleLayout(f.root,new AbortController().signal);
  const current=startArticleLayout(f.root,200000,{yieldTask:()=>new Promise(done=>queue.push(done))});assert.equal(await ready,false);
  queue.shift()();await old.finished;assert.equal(f.root.dataset.rivuLayout,'pending');
  current.cancel();queue.shift()();await current.finished;assert.equal(f.root.dataset.rivuLayout,undefined);
 }finally{f.dom.window.close();}
});
test('small content, unsupported CSS and aborted waits retain ordinary rendering',async()=>{
 const f=fixture();try{
  assert.equal(startArticleLayout(f.root,100),null);assert.equal(await waitForArticleLayout(f.root,new AbortController().signal),true);
  const session=startArticleLayout(f.root,200000,{yieldTask:async()=>{}}),controller=new AbortController(),ready=waitForArticleLayout(f.root,controller.signal);controller.abort();assert.equal(await ready,false);await session.finished;
 }finally{f.dom.window.close();}
});
test('accessibility mode disables deferred layout and runtime reveal releases ratio waiters',async()=>{
 const f=fixture();let resume;try{
  assert.equal(startArticleLayout(f.root,200000,{accessibilityEnabled:true}),null);
  const session=startArticleLayout(f.root,200000,{yieldTask:()=>new Promise(done=>{resume=done;})}),ready=waitForArticleLayout(f.root,new AbortController().signal);
  session.reveal();assert.equal(await ready,true);assert.equal(f.root.dataset.rivuLayout,undefined);resume();assert.equal((await session.finished).completed,false);
 }finally{f.dom.window.close();}
});

test('plain groups retire synchronously for accessibility, print and native find shortcuts',async()=>{
 for(const mode of ['accessibility','print','find','selection']){
  const f=fixture(),queue=[];try{
   f.root.querySelector('table').remove();const original=f.root.innerHTML;
   const session=startArticleLayout(f.root,200000,{yieldTask:()=>new Promise(done=>queue.push(done))});assert.equal(f.root.dataset.rivuLayoutMode,'groups');assert.equal(f.root.children.length,1);
   const ready=waitForArticleLayout(f.root,new AbortController().signal);
   if(mode==='accessibility')session.reveal();else if(mode==='print')f.dom.window.dispatchEvent(new f.dom.window.Event('beforeprint'));else if(mode==='selection')f.root.querySelector('p').dispatchEvent(new f.dom.window.Event('selectstart',{bubbles:true}));else f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'f',ctrlKey:true}));
   assert.equal(await ready,true);assert.equal(f.root.innerHTML,original);assert.equal(f.root.dataset.rivuLayoutMode,undefined);queue.shift()();assert.equal((await session.finished).completed,false);
  }finally{f.dom.window.close();}
 }
});

test('group session completes and removes temporary mode before source DOM transfer',async()=>{
 const f=fixture();try{
  f.root.querySelector('table').remove();const original=f.root.innerHTML,first=f.root.firstElementChild;
  const session=startArticleLayout(f.root,200000,{yieldTask:async()=>{}});assert.equal((await session.finished).completed,true);assert.equal(f.root.innerHTML,original);assert.equal(f.root.dataset.rivuLayoutMode,undefined);
  const cached=f.root.ownerDocument.createDocumentFragment();session.cancel();while(f.root.firstChild)cached.appendChild(f.root.firstChild);f.root.replaceChildren(cached);
  assert.equal(f.root.firstElementChild,first);assert.equal(f.root.innerHTML,original);
 }finally{f.dom.window.close();}
});
