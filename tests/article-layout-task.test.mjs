import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const built=await build({entryPoints:['src/article-layout-task.ts'],bundle:true,format:'esm',write:false});
const {layoutArticleBlocks}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const fixture=()=>{
 const dom=new JSDOM('<main>'+Array.from({length:19},(_,i)=>`<p>Paragraph ${i}</p>`).join('')+'</main>');
 const root=dom.window.document.querySelector('main'),blocks=[...root.children];
 return {dom,root,blocks,controller:new AbortController()};
};
test('bounded batches yield and restore original style value and priority',async()=>{
 const f=fixture();let yields=0,stabilized=0;const batches=[];
 f.blocks[0].style.setProperty('content-visibility','auto','important');
 try{
  const result=await layoutArticleBlocks(f.root,f.blocks,{signal:f.controller.signal,yieldTask:async()=>{yields++;},stabilize:()=>{stabilized++;},onBatch:n=>batches.push(n)});
  assert.deepEqual(result,{completed:true,batches:3});assert.deepEqual(batches,[8,8,3]);assert.equal(yields,2);assert.equal(stabilized,3);
  assert.equal(f.blocks[0].style.getPropertyValue('content-visibility'),'auto');assert.equal(f.blocks[0].style.getPropertyPriority('content-visibility'),'important');
  assert.ok(f.blocks.slice(1).every(block=>!block.style.getPropertyValue('content-visibility')));
 }finally{f.dom.window.close();}
});

test('retirement restores absent style attributes and preserves original or independently added styles',async()=>{
 const f=fixture();try{
  const original=f.root.innerHTML;
  await layoutArticleBlocks(f.root,f.blocks,{signal:f.controller.signal,yieldTask:async()=>{},stabilize(){}});
  assert.equal(f.root.innerHTML,original,'Temporary rendering styles must retire without adding empty attributes');
  f.blocks[0].setAttribute('style','');f.blocks[1].style.fontStyle='italic';
  await layoutArticleBlocks(f.root,f.blocks,{signal:f.controller.signal,yieldTask:async()=>{f.blocks[2].style.color='red';},stabilize(){}});
  assert.equal(f.blocks[0].getAttribute('style'),'');assert.equal(f.blocks[1].style.fontStyle,'italic');assert.equal(f.blocks[2].style.color,'red');
  assert.ok(f.blocks.slice(3).every(block=>!block.hasAttribute('style')));
 }finally{f.dom.window.close();}
});
test('navigation abort cannot stabilize or mutate the replacement article',async()=>{
 const f=fixture();let stabilized=0;const replacement=f.dom.window.document.createElement('p');replacement.textContent='New article';replacement.style.contentVisibility='hidden';
 try{
  const result=await layoutArticleBlocks(f.root,f.blocks,{signal:f.controller.signal,stabilize:()=>{stabilized++;},yieldTask:async()=>{f.controller.abort();f.root.replaceChildren(replacement);}});
  assert.deepEqual(result,{completed:false,batches:1});assert.equal(stabilized,1);assert.equal(f.root.textContent,'New article');assert.equal(replacement.style.contentVisibility,'hidden');
  assert.ok(f.blocks.every(block=>!block.style.getPropertyValue('content-visibility')));
 }finally{f.dom.window.close();}
});
test('detached blocks, already aborted work and failed stabilization stop safely',async()=>{
 for(const mode of ['replaced','detached','aborted','failure']){
  const f=fixture();let stabilized=0;
  try{
   if(mode==='aborted')f.controller.abort();
   const work=layoutArticleBlocks(f.root,f.blocks,{signal:f.controller.signal,stabilize:()=>{stabilized++;if(mode==='failure')throw Error('Layout failed');},yieldTask:async()=>{if(mode==='detached')f.root.remove();else f.root.replaceChildren();}});
   if(mode==='failure')await assert.rejects(work,/Layout failed/);
   else assert.equal((await work).completed,false);
   assert.equal(stabilized,mode==='aborted'?0:1);assert.ok(f.blocks.every(block=>!block.style.getPropertyValue('content-visibility')));
  }finally{f.dom.window.close();}
 }
});

test('superseded work cannot restore styles owned by the next task on reused nodes',async()=>{
 const f=fixture();let resumeOld,resumeNew;
 try{
  const old=layoutArticleBlocks(f.root,f.blocks,{signal:f.controller.signal,stabilize(){},yieldTask:()=>new Promise(resolve=>{resumeOld=resolve;})});
  const newerController=new AbortController();
  const newer=layoutArticleBlocks(f.root,f.blocks,{signal:newerController.signal,stabilize(){},yieldTask:()=>new Promise(resolve=>{resumeNew=resolve;})});
  assert.equal(typeof resumeOld,'function');assert.equal(typeof resumeNew,'function');
  resumeOld();assert.equal((await old).completed,false);
  assert.ok(f.blocks.slice(0,8).every(block=>block.style.contentVisibility==='visible'));
  newerController.abort();resumeNew();assert.equal((await newer).completed,false);
  assert.ok(f.blocks.every(block=>!block.style.getPropertyValue('content-visibility')));
 }finally{f.dom.window.close();}
});
