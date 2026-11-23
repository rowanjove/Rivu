import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const bundle=await build({entryPoints:['src/article-anchor.ts'],bundle:true,format:'esm',write:false});
const {createArticleAnchor,parseArticleAnchor,resolveArticleAnchor}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const revision='a'.repeat(64);
const dom=new JSDOM('<main><p>First</p><div><p>正文 <b>nested</b> tail</p></div></main>');
const root=dom.window.document.querySelector('main');
test.after(()=>dom.window.close());
test('serialized nested anchor resolves against an equivalent new DOM without retaining old nodes',()=>{
 const node=root.querySelector('div p'),anchor=createArticleAnchor(root,node,revision,-12.5);
 assert.deepEqual(anchor.path,[1,0]);assert.equal(anchor.head,'正文 nested tail');assert.equal(anchor.tail,anchor.head);
 const copy=root.cloneNode(true),resolved=resolveArticleAnchor(copy,JSON.parse(JSON.stringify(anchor)),revision);
 assert.equal(resolved.node,copy.querySelector('div p'));assert.notEqual(resolved.node,node);assert.equal(resolved.offset,-12.5);
 const parsed=parseArticleAnchor(anchor);parsed.path[0]=0;assert.deepEqual(anchor.path,[1,0]);
});
test('revision changes, missing paths, altered text or tags fail closed for ratio fallback',()=>{
 const anchor=createArticleAnchor(root,root.querySelector('div p'),revision,20);
 assert.equal(resolveArticleAnchor(root,anchor,'b'.repeat(64)),null);
 for(const html of ['<p>First</p>','<p>First</p><div><p>Changed</p></div>','<p>First</p><div><section>正文 <b>nested</b> tail</section></div>']){
  const copy=root.cloneNode(false);copy.innerHTML=html;assert.equal(resolveArticleAnchor(copy,anchor,revision),null);
 }
});
test('untrusted payloads reject invalid versions, paths, bounds and extra fields',()=>{
 const valid=createArticleAnchor(root,root.querySelector('p'),revision,0);
 for(const patch of [{version:2},{path:[]},{path:Array(33).fill(0)},{path:Array(2)},{path:[-1]},{path:[1.5]},{path:[65536]},{revision:''},{head:'x'.repeat(97)},{tail:3},{offset:NaN},{offset:Infinity},{offset:1e8},{tag:'script:svg'},{extra:true}])assert.equal(parseArticleAnchor({...valid,...patch}),null);
 assert.equal(createArticleAnchor(root,root,revision,0),null);
 assert.equal(createArticleAnchor(root,root.ownerDocument.createElement('p'),revision,0),null);
});
test('giant text fingerprints allocate only bounded edges and reject altered trailing content',()=>{
 const copy=root.cloneNode(false),node=copy.appendChild(copy.ownerDocument.createElement('p'));
 node.textContent='start '+('word '.repeat(210000))+' end';
 const anchor=createArticleAnchor(copy,node,revision,20);assert.equal(anchor.head.length,96);assert.equal(anchor.tail.length,96);assert.ok(anchor.tail.endsWith(' end'));assert.ok(JSON.stringify(anchor).length<400);
 node.lastChild.nodeValue+=' changed';assert.equal(resolveArticleAnchor(copy,anchor,revision),null);
});
