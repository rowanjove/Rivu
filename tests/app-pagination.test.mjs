import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

for(const oldOutcome of ['success','error'])test(`App coalesces pagination, ignores old-view ${oldOutcome} and retries current failures`,{timeout:10000},async()=>{
 const artifactRoot=realpathSync('artifacts'),directory=mkdtempSync(join(artifactRoot,'rivu-app-pagination-')),file=join(directory,'app.mjs');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 const keys=['window','document','HTMLElement','navigator','localStorage','requestAnimationFrame','IS_REACT_ACT_ENVIRONMENT','__timelineApi','__timelineProps'];
 const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 let root;
 const page=(prefix,start=0)=>Array.from({length:100},(_,index)=>({id:`${prefix}-${start+index}`,feed_id:'feed',title:`${prefix} ${start+index}`,read:0,published_at:'2026-01-01T00:00:00Z',fetched_at:'2026-01-01T00:00:00Z'}));
 const pending=[];let allResolve;
 const allPage=new Promise(resolve=>{allResolve=resolve;});
 try{
  const globals={window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,navigator:dom.window.navigator,localStorage:dom.window.localStorage,requestAnimationFrame:callback=>setTimeout(callback,0),IS_REACT_ACT_ENVIRONMENT:true};
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  dom.window.rivu={onExternalError:()=>()=>{},setWindowTheme:async()=>{}};
  globalThis.__timelineApi={get:async path=>{
   if(path==='/api/reading/settings')return {preferences:{density:'standard',uiFontSize:'standard',theme:'light',font:'sans',fontSize:16,lineHeight:1.8,width:760,imageWidth:'column',linkTarget:'external'},densityConfigured:true};
   if(!path.startsWith('/api/entries?'))return [];
   const url=new URL(path,'http://localhost'),view=url.searchParams.get('view')??'all';
   if(!url.searchParams.has('beforeId'))return view==='all'?allPage:page(view);
   return new Promise((resolve,reject)=>pending.push({view,resolve,reject,path}));
  }};
  await build({entryPoints:['src/App.tsx'],outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',plugins:[{name:'timeline-boundaries',setup(builder){
   builder.onResolve({filter:/^react$/},()=>({path:'react',external:true}));
   builder.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'test'}));
   builder.onResolve({filter:/^react-virtuoso$/},()=>({path:'virtuoso',namespace:'test'}));
   builder.onResolve({filter:/^\.\/[A-Z][A-Za-z]+$/},args=>({path:args.path.slice(2),namespace:'test-ui'}));
   builder.onLoad({filter:/.*/,namespace:'test'},args=>({contents:args.path==='api'?'export const api=globalThis.__timelineApi;':"import * as React from 'react';export const Virtuoso=React.forwardRef((props,ref)=>{React.useImperativeHandle(ref,()=>({scrollToIndex(){}}));globalThis.__timelineProps=props;return React.createElement('div',{className:props.className});});",loader:'js'}));
   builder.onLoad({filter:/.*/,namespace:'test-ui'},args=>({contents:`export const ${args.path}=()=>null;`,loader:'js'}));
  }}]});
  const React=await import('react'),{createRoot}=await import('react-dom/client'),{App}=await import(pathToFileURL(file));
  root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(React.createElement(App)));
  assert.equal(globalThis.__timelineProps.data.length,100);
  let first,duplicate;const firstEnd=globalThis.__timelineProps.endReached;
  await React.act(async()=>{first=firstEnd();duplicate=firstEnd();await Promise.resolve();});
  assert.equal(pending.length,1,'two callbacks before React renders must share one page request');
  await React.act(async()=>{pending[0].resolve(page('unread',100));await Promise.all([first,duplicate]);const repeated=firstEnd();assert.equal(pending.length,1,'a settled request must stay guarded until the cursor changes');await repeated;});
  assert.equal(globalThis.__timelineProps.data.length,200);
  let old;
  await React.act(async()=>{old=globalThis.__timelineProps.endReached();await Promise.resolve();});
  const all=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='全部');assert.ok(all);
  await React.act(async()=>all.click());
  await React.act(async()=>{const stale=firstEnd();assert.equal(pending.length,2,'a refresh must synchronously reject an old-render page callback');await stale;});
  await React.act(async()=>{allResolve(page('all'));await allPage;});
  assert.equal(globalThis.__timelineProps.data[0].id,'all-0');
  let current;
  await React.act(async()=>{current=globalThis.__timelineProps.endReached();await Promise.resolve();});
  assert.equal(pending.length,3,'old view must not block paging in the new view');
  await React.act(async()=>{if(oldOutcome==='error')pending[1].reject(Error('old-view-only-error'));else pending[1].resolve(page('unread',200));await old;});
  assert.ok(!document.body.textContent.includes('old-view-only-error'),'stale failure must not replace the new view status');
  await React.act(async()=>{await globalThis.__timelineProps.endReached();});
  assert.equal(pending.length,3,'settling the old request must not unlock the current request');
  await React.act(async()=>{pending[2].resolve(page('all',100));await current;});
  assert.equal(globalThis.__timelineProps.data.length,200);
  assert.ok(globalThis.__timelineProps.data.every(row=>row.id.startsWith('all-')));
  await React.act(async()=>{const stale=firstEnd();assert.equal(pending.length,3,'a retired list callback must not query its old cursor in the new view');await stale;});
  let failed,retry;
  await React.act(async()=>{failed=globalThis.__timelineProps.endReached();await Promise.resolve();});
  assert.equal(pending.length,4);
  await React.act(async()=>{pending[3].reject(Error('current-view-error'));await failed;});
  assert.ok(document.body.textContent.includes('current-view-error'));
  assert.equal(globalThis.__timelineProps.data.length,200);
  await React.act(async()=>{retry=globalThis.__timelineProps.endReached();await Promise.resolve();});
  assert.equal(pending.length,5,'a failed current page must allow retry');
  assert.equal(pending[3].path,pending[4].path,'retry must use the same cursor');
  await React.act(async()=>{pending[4].resolve(page('all',200));await retry;});
  assert.equal(globalThis.__timelineProps.data.length,300);
  assert.equal(new Set(globalThis.__timelineProps.data.map(row=>row.id)).size,300);
 }finally{
  if(root){const React=await import('react');await React.act(async()=>root.unmount());}
  dom.window.close();
  for(const [key,value] of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}
  assert.equal(dirname(realpathSync(directory)),artifactRoot);
  assert.equal(lstatSync(directory).isSymbolicLink(),false);
  rmSync(directory,{recursive:true,force:true});
 }
});
