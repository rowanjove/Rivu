import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const bundle=await build({entryPoints:['src/reading-position.ts'],bundle:true,format:'esm',write:false});
const {trackReadingPosition,articleSourceRevision}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const rev='a'.repeat(64),key='rivu-reading-pending:fixture';
let resize;
globalThis.ResizeObserver=class{constructor(callback){resize=callback;}observe(){}unobserve(){}disconnect(){}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
test.after(()=>{delete globalThis.ResizeObserver;delete globalThis.MutationObserver;});
function fixture(){
 const dom=new JSDOM('<article><div class="rich-body"><p>First</p><p>Target body</p></div></article>',{url:'https://app.invalid/'}),view=dom.window,root=view.document.querySelector('article'),node=root.querySelector('p:last-child'),frames=[];
 let base=600,stop=()=>{};const writes=[];
 Object.defineProperties(root,{scrollHeight:{get:()=>2000,configurable:true},clientHeight:{get:()=>300}});
 root.getBoundingClientRect=()=>({top:0,left:0,right:760,bottom:300});node.getBoundingClientRect=()=>({top:base-root.scrollTop});view.document.elementFromPoint=()=>node;
 view.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
 const flush=async()=>{for(let i=0;i<8;i++){await new Promise(done=>setImmediate(done));for(const callback of frames.splice(0))callback(0);}};
 return {dom,view,root,node,writes,frames,flush,setBase:value=>{base=value;},scroll(value){root.scrollTop=value;root.dispatchEvent(new view.Event('scroll'));},
  start(options={}){stop=trackReadingPosition(root,'fixture','Source body',{read:async()=>({progress:.2}),write:async value=>{writes.push(value);},revision:async()=>rev,...options});return stop;},
  async close(){stop();await flush();dom.window.close();}};
}
const anchor={version:1,revision:rev,path:[1],tag:'P',head:'Target body',tail:'Target body',offset:20};
test('source SHA is exact UTF8 and computed independently of DOM text',async()=>{
 const source='<p>中文 😀 &amp; \0</p>';assert.equal(await articleSourceRevision(source),createHash('sha256').update(source).digest('hex'));
});
test('matching serialized anchor wins over ratio; scroll saves ratio and anchor together',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor:JSON.parse(JSON.stringify(anchor))})});await f.flush();assert.equal(f.root.scrollTop,580);
  f.scroll(700);const journal=JSON.parse(f.view.localStorage.getItem(key));assert.equal(journal.anchor.revision,rev);assert.equal(journal.anchor.offset,-100);
 }finally{await f.close();}
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].progress,700/1700);assert.equal(f.writes[0].anchor.offset,-100);
});

test('layout growth below the source anchor refreshes ratio without moving the reading point',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor:JSON.parse(JSON.stringify(anchor))})});await f.flush();assert.equal(f.root.scrollTop,580);
  Object.defineProperty(f.root,'scrollHeight',{get:()=>2500,configurable:true});resize();
  const journal=JSON.parse(f.view.localStorage.getItem(key));assert.equal(f.root.scrollTop,580);assert.equal(journal.progress,580/2200);assert.deepEqual(journal.anchor.path,[1]);assert.equal(journal.anchor.offset,20);
 }finally{await f.close();}
});

test('a duplicate scroll notification cannot replace the anchor during reflow',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor})});await f.flush();
  f.scroll(700);const journal=f.view.localStorage.getItem(key);
  f.setBase(800);f.root.dispatchEvent(new f.view.Event('scroll'));
  assert.equal(f.view.localStorage.getItem(key),journal);
  resize();assert.equal(f.root.scrollTop,900);
  const corrected=f.view.localStorage.getItem(key);
  f.root.dispatchEvent(new f.view.Event('scroll'));
  assert.equal(f.view.localStorage.getItem(key),corrected);
  f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(700);
  assert.equal(JSON.parse(f.view.localStorage.getItem(key)).anchor.offset,100);
 }finally{await f.close();}
});

test('layout changes between restore frames realign the saved source before capturing a new anchor',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor:JSON.parse(JSON.stringify(anchor))})});await new Promise(done=>setImmediate(done));
  assert.equal(f.frames.length,1);f.frames.shift()(0);assert.equal(f.root.scrollTop,580);
  f.setBase(800);resize();f.frames.shift()(0);assert.equal(f.root.scrollTop,780);f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(780);
  assert.equal(JSON.parse(f.view.localStorage.getItem(key)).anchor.offset,20);
 }finally{await f.close();}
});

test('user scroll between restore frames wins over the second alignment',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor})});await new Promise(done=>setImmediate(done));f.frames.shift()(0);
  f.setBase(800);f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(777);f.frames.shift()(0);assert.equal(f.root.scrollTop,777);
 }finally{await f.close();}
});

test('asynchronous restore scroll does not create a local journal or write the database',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor})});await new Promise(done=>setImmediate(done));f.frames.shift()(0);
  f.setBase(800);f.frames.shift()(0);f.root.dispatchEvent(new f.view.Event('scroll'));
  assert.equal(f.view.localStorage.getItem(key),null);
 }finally{await f.close();}
 assert.equal(f.writes.length,0);
});
test('legacy ratio, changed body and digest failure fall back without losing position',async()=>{
 for(const mode of ['legacy','changed','hash-failed']){
  const f=fixture();try{
   f.start({read:async()=>({progress:.4,...(mode==='legacy'?{}:{anchor})}),revision:mode==='hash-failed'?async()=>{throw Error('Unavailable');}:async()=>mode==='changed'?'b'.repeat(64):rev});
   await f.flush();assert.equal(f.root.scrollTop,680);
  }finally{await f.close();}
 }
});
test('wheel intent prevents a delayed response from overriding user scroll',async()=>{
 const f=fixture();let respond;try{
  f.start({read:()=>new Promise(resolve=>{respond=resolve;})});await f.flush();
  f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(777);respond({progress:.9,anchor});await f.flush();assert.equal(f.root.scrollTop,777);
 }finally{await f.close();}
 assert.equal(f.writes[0].progress,777/1700);
});
test('clicking a reader tool does not masquerade as scroll intent before restore',async()=>{
 const f=fixture();let respond;try{
  f.start({read:()=>new Promise(resolve=>{respond=resolve;})});await f.flush();
  const button=f.view.document.createElement('button');f.root.appendChild(button);button.dispatchEvent(new f.view.Event('pointerdown',{bubbles:true}));
  respond({progress:.4});await f.flush();assert.equal(f.root.scrollTop,680);
 }finally{await f.close();}
});
test('space activates a tool without cancelling restore, while PageDown remains scroll intent',async()=>{
 for(const key of [' ','PageDown']){
  const f=fixture();let respond;try{
   f.start({read:()=>new Promise(resolve=>{respond=resolve;})});await f.flush();
   const button=f.view.document.createElement('button');f.root.appendChild(button);button.dispatchEvent(new f.view.KeyboardEvent('keydown',{key,bubbles:true}));
   if(key==='PageDown')f.scroll(777);respond({progress:.4});await f.flush();assert.equal(f.root.scrollTop,key===' '?680:777);
  }finally{await f.close();}
 }
});
test('cleanup prevents late restore and pending image-resize callbacks',async()=>{
 const f=fixture();let respond;try{
  const stop=f.start({read:()=>new Promise(resolve=>{respond=resolve;})});await f.flush();stop();f.root.scrollTop=123;
  respond({progress:.9,anchor});resize();await f.flush();assert.equal(f.root.scrollTop,123);assert.equal(f.writes.length,0);
 }finally{await f.close();}
});
test('entry cleanup aborts in-flight source revision work',async()=>{
 const f=fixture();let signal,aborts=0;try{
  const stop=f.start({revision:(_source,current)=>new Promise((_resolve,reject)=>{signal=current;current.addEventListener('abort',()=>{aborts++;reject(current.reason);},{once:true});})});
  await f.flush();assert.equal(signal.aborted,false);stop();await f.flush();assert.equal(signal.aborted,true);assert.equal(aborts,1);assert.equal(f.writes.length,0);
 }finally{await f.close();}
});
test('image size changes preserve the visible anchor and save its corrected ratio',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor})});await f.flush();f.setBase(700);resize();assert.equal(f.root.scrollTop,680);
 }finally{await f.close();}
 assert.equal(f.writes[0].progress,680/1700);assert.equal(f.writes[0].anchor.offset,20);
});
test('wheel scrolling during resize correction captures the new user anchor',async()=>{
 const f=fixture();try{
  f.start({read:async()=>({progress:.1,anchor})});await f.flush();f.setBase(700);resize();
  f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(800);
 }finally{await f.close();}
 assert.equal(f.writes[0].anchor.offset,-100);assert.equal(f.writes[0].progress,800/1700);
});
test('failed API read recovers a newer journal anchor',async()=>{
 const f=fixture();try{
  f.view.localStorage.setItem(key,JSON.stringify({progress:.8,anchor,at:Date.now()}));
  f.start({read:async()=>{throw Error('Offline');}});await f.flush();assert.equal(f.root.scrollTop,580);
 }finally{await f.close();}
 assert.deepEqual(f.writes[0].anchor,anchor);
});
test('old save cannot remove a newer journal and same-entry lifetimes serialize writes',async()=>{
 const f=fixture();let finishOld,finishNew;const order=[];
 try{
  const old=f.start({write:value=>new Promise(resolve=>{order.push(value.progress);finishOld=resolve;})});await f.flush();f.scroll(100);old();await f.flush();
  f.start({write:value=>new Promise(resolve=>{order.push(value.progress);finishNew=resolve;})});await f.flush();
  f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(200);f.view.dispatchEvent(new f.view.Event('pagehide'));
  assert.equal(order.length,1);finishOld();await f.flush();assert.deepEqual(order,[100/1700,200/1700]);
  assert.equal(JSON.parse(f.view.localStorage.getItem(key)).progress,200/1700);finishNew();await f.flush();assert.equal(f.view.localStorage.getItem(key),null);
 }finally{await f.close();}
});

test('paragraph margin hit uses bounded nearby probes to find a content anchor',async()=>{
 const f=fixture();let probes=0;try{
  f.view.document.elementFromPoint=()=>++probes%2?f.root.querySelector('.rich-body'):f.node;
  f.start();await f.flush();f.scroll(500);assert.ok(JSON.parse(f.view.localStorage.getItem(key)).anchor);assert.ok(probes<20);
 }finally{await f.close();}
 assert.ok(f.writes[0].anchor);
});
test('late digest supplements a ratio already saved by the debounce timer',async()=>{
 const f=fixture();let finishDigest;try{
  f.start({revision:()=>new Promise(resolve=>{finishDigest=resolve;})});await f.flush();
  f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(500);
  await new Promise(done=>setTimeout(done,500));await f.flush();assert.equal(f.writes.length,1);assert.equal(f.writes[0].anchor,undefined);
  finishDigest(rev);await f.flush();assert.ok(JSON.parse(f.view.localStorage.getItem(key)).anchor);
 }finally{await f.close();}
 assert.equal(f.writes.length,2);assert.ok(f.writes[1].anchor);assert.equal(f.writes[1].progress,500/1700);
});
test('legacy nonzero ratio waits for exact layout height before restoring',async()=>{
 const f=fixture(),body=f.root.querySelector('.rich-body');try{
  body.dataset.rivuLayout='pending';f.start({read:async()=>({progress:.4})});await f.flush();assert.equal(f.root.scrollTop,0);
  Object.defineProperty(f.root,'scrollHeight',{get:()=>4000,configurable:true});body.removeAttribute('data-rivu-layout');body.dispatchEvent(new f.view.CustomEvent('rivu-article-layout-ready',{detail:{cancelled:false}}));
  await f.flush();assert.equal(f.root.scrollTop,1480);
 }finally{await f.close();}
});
test('user input cancels waiting ratio restoration while an existing anchor can restore early',async()=>{
 for(const mode of ['user','anchor']){
  const f=fixture(),body=f.root.querySelector('.rich-body');try{
   body.dataset.rivuLayout='pending';f.start({read:async()=>({progress:.4,...(mode==='anchor'?{anchor}:{})})});await f.flush();
   if(mode==='anchor')assert.equal(f.root.scrollTop,580);
   else{f.root.dispatchEvent(new f.view.Event('wheel'));f.scroll(777);body.removeAttribute('data-rivu-layout');body.dispatchEvent(new f.view.CustomEvent('rivu-article-layout-ready',{detail:{cancelled:false}}));await f.flush();assert.equal(f.root.scrollTop,777);}
  }finally{await f.close();}
 }
});
test('a saved paragraph waits for grouped layout to replace estimated heights',async()=>{
 const f=fixture(),body=f.root.querySelector('.rich-body');try{
  body.dataset.rivuLayout='pending';body.dataset.rivuLayoutMode='groups';
  f.start({read:async()=>({progress:.4,anchor})});await f.flush();assert.equal(f.root.scrollTop,0);
  body.removeAttribute('data-rivu-layout');body.removeAttribute('data-rivu-layout-mode');
  body.dispatchEvent(new f.view.CustomEvent('rivu-article-layout-ready',{detail:{cancelled:false}}));
  await f.flush();assert.equal(f.root.scrollTop,580);assert.equal(f.writes.length,0);
 }finally{await f.close();}
});
