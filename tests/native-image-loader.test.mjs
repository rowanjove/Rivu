import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';

test('disposed native image requests never install late URLs or overwrite a replacement article image',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-native-loader-')),out=join(directory,'loader.mjs'),page=new JSDOM('<img>'),previous=globalThis.window;
 try{
  buildSync({entryPoints:['src/native-image.ts'],outfile:out,bundle:true,platform:'node',format:'esm'});const {loadNativeImage}=await import(pathToFileURL(out));
  globalThis.window=page.window;let resolve;page.window.rivu={imageUrl:()=>new Promise(done=>resolve=done)};const image=page.window.document.querySelector('img');
  const dispose=loadNativeImage(image,'old','https://example.invalid/old');dispose();image.src='rivu-image://local/new';resolve('rivu-image://local/old');await new Promise(done=>setTimeout(done,0));assert.equal(image.src,'rivu-image://local/new');
 }finally{globalThis.window=previous;page.window.close();rmSync(directory,{recursive:true,force:true});}
});

test('native image failures retry boundedly with fresh capabilities and cancellation clears pending retries',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-native-retry-')),out=join(directory,'loader.mjs'),page=new JSDOM('<img>'),previous=globalThis.window;
 try{
  buildSync({entryPoints:['src/native-image.ts'],outfile:out,bundle:true,platform:'node',format:'esm'});const {loadNativeImage}=await import(pathToFileURL(out));
  globalThis.window=page.window;let calls=0;page.window.rivu={imageUrl:async()=>{calls++;throw Error('busy');}};const statuses=[],image=page.window.document.querySelector('img'),dispose=loadNativeImage(image,'entry','https://example.invalid/x',{onStatus:s=>statuses.push(s)});
  await new Promise(done=>setTimeout(done,600));assert.equal(calls,3);assert.equal(statuses.at(-1),'error');dispose();
  const next=loadNativeImage(image,'entry','https://example.invalid/x');await new Promise(done=>setTimeout(done,0));next();const count=calls;await new Promise(done=>setTimeout(done,250));assert.equal(calls,count);
 }finally{globalThis.window=previous;page.window.close();rmSync(directory,{recursive:true,force:true});}
});
