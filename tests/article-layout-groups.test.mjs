import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const built=await build({stdin:{contents:"export * from './src/article-layout-groups';export * from './src/article-anchor';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false});
const {createArticleLayoutGroups,isArticleLayoutGroup,articleSourceHit,createArticleAnchor,resolveArticleAnchor}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const revision='a'.repeat(64),flush=async()=>{await Promise.resolve();await Promise.resolve();};
function fixture(count=70){const dom=new JSDOM('<main>'+Array.from({length:count},(_,i)=>`<p>Paragraph ${i} 中文😀</p>`).join('')+'</main>'),root=dom.window.document.querySelector('main');return {dom,root,nodes:[...root.children],html:root.innerHTML};}
async function drain(queue){while(queue.length){queue.shift()();await flush();}}

test('source anchors retain paths before grouping, during partial unwrap and after completion',async()=>{
 const f=fixture(),queue=[];try{
  const targets=[0,15,16,40,69],anchors=targets.map(index=>JSON.parse(JSON.stringify(createArticleAnchor(f.root,f.nodes[index],revision,-12.5))));
  const layout=createArticleLayoutGroups(f.root,{groupSize:16}),wrappers=[...f.root.children];assert.equal(layout.groupCount,5);assert.ok(wrappers.every(isArticleLayoutGroup));
  const check=()=>targets.forEach((index,i)=>{assert.deepEqual(createArticleAnchor(f.root,f.nodes[index],revision,-12.5),anchors[i]);assert.equal(resolveArticleAnchor(f.root,anchors[i],revision).node,f.nodes[index]);});
  check();assert.equal(createArticleAnchor(f.root,wrappers[0],revision,0),null);
  const clone=f.root.cloneNode(true);assert.equal(resolveArticleAnchor(clone,anchors[0],revision),null,'Cloned/spoofed wrappers are not registry-owned');
  let batches=0;const work=layout.run({signal:new AbortController().signal,yieldTask:()=>new Promise(done=>queue.push(done)),onBatch:()=>{batches++;check();}});
  queue.shift()();await flush();assert.equal(batches,1);assert.equal(f.root.firstElementChild,f.nodes[0]);check();
  await drain(queue);assert.deepEqual(await work,{completed:true,batches:5});check();assert.equal(f.root.innerHTML,f.html);assert.ok(wrappers.every(node=>!isArticleLayoutGroup(node)));
 }finally{f.dom.window.close();}
});

test('abort and explicit reveal restore source synchronously while pending tasks retire safely',async()=>{
 for(const mode of ['abort','reveal']){
  const f=fixture(),queue=[],controller=new AbortController();try{
   const layout=createArticleLayoutGroups(f.root),work=layout.run({signal:controller.signal,yieldTask:()=>new Promise(done=>queue.push(done))});
   if(mode==='abort')controller.abort();else layout.retire();assert.equal(f.root.innerHTML,f.html);
   await drain(queue);assert.deepEqual(await work,{completed:false,batches:0});assert.equal(f.root.innerHTML,f.html);
  }finally{f.dom.window.close();}
 }
});

test('superseded tasks and replaced roots never unwrap new groups or mutate new source nodes',async()=>{
 const f=fixture(),oldQueue=[],newQueue=[];try{
  const old=createArticleLayoutGroups(f.root),oldWork=old.run({signal:new AbortController().signal,yieldTask:()=>new Promise(done=>oldQueue.push(done))});
  const next=createArticleLayoutGroups(f.root),newWrappers=[...f.root.children],nextWork=next.run({signal:new AbortController().signal,yieldTask:()=>new Promise(done=>newQueue.push(done))});
  await drain(oldQueue);assert.equal((await oldWork).completed,false);assert.ok(newWrappers.every(node=>node.parentElement===f.root&&isArticleLayoutGroup(node)));
  const replacement=f.dom.window.document.createElement('p');replacement.textContent='New article';replacement.style.color='red';f.root.replaceChildren(replacement);const html=f.root.innerHTML;
  await drain(newQueue);assert.equal((await nextWork).completed,false);assert.equal(f.root.innerHTML,html);assert.equal(f.root.firstChild,replacement);assert.ok(newWrappers.every(node=>!isArticleLayoutGroup(node)));
 }finally{f.dom.window.close();}
});

test('failed scheduling, callbacks and repeated runs clean only their own state',async()=>{
 const f=fixture();try{
  let layout=createArticleLayoutGroups(f.root);await assert.rejects(layout.run({signal:new AbortController().signal,yieldTask:async()=>{throw Error('schedule failed');}}),/schedule failed/);assert.equal(f.root.innerHTML,f.html);
  layout=createArticleLayoutGroups(f.root);await assert.rejects(layout.run({signal:new AbortController().signal,yieldTask:async()=>{},onBatch:()=>{throw Error('callback failed');}}),/callback failed/);assert.equal(f.root.innerHTML,f.html);
  await assert.rejects(layout.run({signal:new AbortController().signal}),/already started/);assert.equal(f.root.innerHTML,f.html);
 }finally{f.dom.window.close();}
});

test('unsupported source and fake marker attributes retain ordinary source path semantics',()=>{
 const f=fixture();try{
  for(const html of ['<p>Only one</p>','<p>Text <b>nested</b></p>'.repeat(20),'<p class=x>styled</p>'.repeat(20),'<p>text</p>\n'.repeat(20)]){
   f.root.innerHTML=html;const before=f.root.innerHTML;assert.equal(createArticleLayoutGroups(f.root),null);assert.equal(f.root.innerHTML,before);
  }
  f.root.innerHTML='<div data-rivu-layout-group><p>Real source</p></div>';const wrapper=f.root.firstElementChild,node=wrapper.firstElementChild;
  assert.equal(isArticleLayoutGroup(wrapper),false);const anchor=createArticleAnchor(f.root,node,revision,0);assert.deepEqual(anchor.path,[0,0]);assert.equal(resolveArticleAnchor(f.root,anchor,revision).node,node);
  assert.throws(()=>createArticleLayoutGroups(f.root,{groupSize:1}),RangeError);
 }finally{f.dom.window.close();}
});

test('wrapper margin hits resolve to the nearest owned paragraph within a bounded group',()=>{
 const f=fixture();try{
  const layout=createArticleLayoutGroups(f.root),wrapper=f.root.firstElementChild;
  f.nodes.forEach((node,i)=>{node.getBoundingClientRect=()=>({top:i*20,bottom:i*20+10});});
  assert.equal(articleSourceHit(f.root,wrapper,15),f.nodes[0]);assert.equal(articleSourceHit(f.root,wrapper,19),f.nodes[1]);assert.equal(articleSourceHit(f.root,wrapper,105),f.nodes[5]);
  assert.equal(articleSourceHit(f.root,wrapper,NaN),null);assert.equal(articleSourceHit(f.root,f.nodes[0],0),f.nodes[0]);
  layout.retire();
 }finally{f.dom.window.close();}
});

test('oversized paragraphs fall back and grouped native layout work has a character budget',()=>{
 const f=fixture();try{
  f.nodes[0].textContent='x'.repeat(32769);assert.equal(createArticleLayoutGroups(f.root),null);
  for(const node of f.nodes)node.textContent='x'.repeat(20000);
  const layout=createArticleLayoutGroups(f.root);assert.ok(layout.groupCount>3);assert.ok([...f.root.children].every(group=>group.textContent.length<=65536));layout.retire();
 }finally{f.dom.window.close();}
});
