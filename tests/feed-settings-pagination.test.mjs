import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

test('subscription pages preserve cross-page selection and whole-library select-all, and clamp after deletion',async()=>{
 const dir=mkdtempSync(join(resolve('artifacts'),'rivu-feed-pages-')),file=join(dir,'pages.mjs'),dom=new JSDOM('<div id="root"></div>');
 const keys=['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let root;
 try{
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  await build({entryPoints:['src/FeedSettingsList.tsx'],outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
  const React=await import('react'),{createRoot}=await import('react-dom/client'),{FeedSettingsList}=await import(pathToFileURL(file));
  function Host({feeds}){const [selected,setSelected]=React.useState(new Set());return React.createElement(React.Fragment,null,
   React.createElement('button',{id:'all',onClick:()=>setSelected(new Set(feeds.map(f=>f.id)))},'全选'),React.createElement('output',{id:'count'},selected.size),
   React.createElement(FeedSettingsList,{feeds},feed=>React.createElement('label',null,React.createElement('input',{type:'checkbox','data-id':feed.id,checked:selected.has(feed.id),onChange:()=>setSelected(old=>{const next=new Set(old);if(next.has(feed.id))next.delete(feed.id);else next.add(feed.id);return next;})}),feed.title)));}
  const feeds=Array.from({length:1001},(_,i)=>({id:String(i+1),title:'Feed '+(i+1)}));root=createRoot(document.getElementById('root'));
  const render=async value=>React.act(async()=>root.render(React.createElement(Host,{feeds:value}))),click=async element=>React.act(async()=>element.click());
  await render(feeds);assert.equal(document.querySelectorAll('input').length,50);assert.equal(document.querySelector('[data-id="51"]'),null);
  await click(document.querySelector('[data-id="1"]'));await click(document.querySelector('nav button:last-of-type'));assert.ok(document.querySelector('[data-id="51"]'));await click(document.querySelector('[data-id="51"]'));assert.equal(document.getElementById('count').textContent,'2');
  await click(document.querySelector('nav button:first-of-type'));assert.equal(document.querySelector('[data-id="1"]').checked,true);
  await click(document.getElementById('all'));assert.equal(document.getElementById('count').textContent,'1001');await click(document.querySelector('nav button:last-of-type'));assert.equal(document.querySelector('[data-id="51"]').checked,true);
  await render(feeds.slice(0,1));assert.equal(document.querySelectorAll('input').length,1);assert.ok(document.querySelector('[data-id="1"]'));assert.equal(document.querySelector('nav'),null);
  await render([]);assert.equal(document.querySelectorAll('input').length,0);await React.act(async()=>root.unmount());root=null;
 }finally{if(root){const React=await import('react');await React.act(async()=>root.unmount());}dom.window.close();for(const [key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}rmSync(dir,{recursive:true,force:true});}
});
