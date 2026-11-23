import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

test('saving gallery cache never mints an unused URL and repeated saves still refresh visible consumers',async()=>{
 const directory=mkdtempSync(join(resolve('artifacts'),'rivu-media-cache-')),file=join(directory,'component.mjs');
 const dom=new JSDOM('<div id="root"></div>'),keys=['window','document','HTMLElement','IntersectionObserver','IS_REACT_ACT_ENVIRONMENT'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let root;
 try{
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  let saves=0,mints=0,releases=0;const observers=[],loads=[];
  globalThis.__mediaApi={get:async()=>[{url:'https://example.invalid/image',kind:'image',source:'body'}],post:async()=>{saves++;return {cached:true};},imageUrl:async()=>{mints++;throw Error('unused mint');}};
  globalThis.__mediaLoad=(_image,_id,_url,options)=>{loads.push(options);return ()=>{releases++;};};
  globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  await build({entryPoints:['src/EntryMedia.tsx'],outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',plugins:[{name:'media-fixture',setup(build){build.onResolve({filter:/^\.\/(api|native-image)$/},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='./api'?'export const api=globalThis.__mediaApi;':'export const loadNativeImage=(...args)=>globalThis.__mediaLoad(...args);',loader:'js'}));}}]});
  const React=await import('react'),{createRoot}=await import('react-dom/client'),{EntryMedia}=await import(pathToFileURL(file));root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(React.createElement(EntryMedia,{entry:{id:'entry',title:'Entry'},expanded:true})));
  const save=async()=>React.act(async()=>document.querySelector('button').click());
  await save();assert.equal(saves,1);assert.equal(mints,0);assert.equal(loads.length,0,'offscreen consumer stays lazy after save');
  await React.act(async()=>observers.at(-1).callback([{isIntersecting:true}]));assert.equal(loads.length,1);assert.equal(loads[0].cacheOnly,true);
  await save();assert.equal(saves,2);assert.equal(mints,0);
  await React.act(async()=>observers.at(-1).callback([{isIntersecting:true}]));assert.equal(loads.length,2);assert.equal(loads[1].cacheOnly,true);
  await React.act(async()=>observers.at(-1).callback([{isIntersecting:false}]));assert.equal(releases,2);
  await React.act(async()=>observers.at(-1).callback([{isIntersecting:false}]));assert.equal(releases,2,'repeated hidden notifications cannot release another consumer');
  await React.act(async()=>observers.at(-1).callback([{isIntersecting:true}]));assert.equal(loads.length,3);
  const oldObserver=observers.at(-1);
  await React.act(async()=>root.unmount());root=null;
  assert.equal(releases,3);await React.act(async()=>oldObserver.callback([{isIntersecting:true}]));assert.equal(loads.length,3,'late observer delivery cannot recreate an unmounted image');
 }finally{if(root){const React=await import('react');await React.act(async()=>root.unmount());}dom.window.close();for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}delete globalThis.__mediaApi;delete globalThis.__mediaLoad;rmSync(directory,{recursive:true,force:true});}
});
