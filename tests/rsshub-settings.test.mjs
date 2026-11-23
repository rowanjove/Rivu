import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

test('RSSHub settings survive StrictMode effect replay and discard the first read',async()=>{
  process.env.NODE_ENV='development';
  const directory=mkdtempSync(join(resolve('artifacts'),'rivu-hub-strict-')),scope=relative(resolve('artifacts'),directory);assert.ok(scope.startsWith('rivu-hub-strict-')&&!scope.startsWith('..')&&!isAbsolute(scope));
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'}),keys=['window','document','HTMLElement','IS_REACT_ACT_ENVIRONMENT'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));let root;
  try{
    globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    const reads=[];dom.window.rivu={request:()=>new Promise(resolve=>reads.push(resolve))};
    const compiled=await build({entryPoints:['src/RsshubSettings.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',write:false,jsx:'automatic'});const file=join(directory,'component.mjs');writeFileSync(file,compiled.outputFiles[0].contents);
    const React=await import('react'),{createRoot}=await import('react-dom/client'),{RsshubSettings}=await import(pathToFileURL(file));root=createRoot(document.getElementById('root'));
    await React.act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(RsshubSettings))));assert.equal(reads.length,2);
    await React.act(async()=>{reads[1]([{id:'new',name:'Current response',base_url:'https://new.invalid',allow_private:0}]);});
    assert.equal(document.querySelector('input[aria-label="实例名称"]').disabled,false);
    await React.act(async()=>{reads[0]([{id:'old',name:'Old response',base_url:'https://old.invalid',allow_private:0}]);});
    assert.deepEqual([...document.querySelectorAll('.hub-instance strong')].map(e=>e.textContent),['Current response']);assert.equal(document.querySelector('input[aria-label="实例名称"]').disabled,false);assert.equal(document.querySelector('[role="alert"]'),null);assert.equal(document.body.textContent.includes('正在读取实例列表'),false);
    await React.act(async()=>root.unmount());root=null;
  }finally{if(root){const React=await import('react');await React.act(async()=>root.unmount());}dom.window.close();for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}rmSync(directory,{recursive:true,force:true});}
});
