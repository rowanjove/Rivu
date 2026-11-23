import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=mkdtempSync(join(tmpdir(),'rivu-image-disposal-'));
test.after(()=>rmSync(directory,{recursive:true,force:true}));
const output=join(directory,'loader.mjs');
await build({entryPoints:['src/native-image.ts'],outfile:output,bundle:true,platform:'node',format:'esm',plugins:[{name:'api',setup(build){build.onResolve({filter:/^\.\/api$/},()=>({path:'api',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const api=globalThis.__imageDisposalApi;',loader:'js'}));}}]});
let resolveMint,serial=0;const cancelled=[],modes=[];
globalThis.__imageDisposalApi={imageUrl:(_id,_url,mode)=>{modes.push(mode);return new Promise(resolve=>{resolveMint=()=>resolve('rivu-image://fixture/'+(++serial));});},cancelImageUrl:async url=>{cancelled.push(url);}};
const {loadNativeImage}=await import(pathToFileURL(output));
test('dispose during mint revokes late resource and remount always mints its own URI',async()=>{
 const listeners=new Map(),image={title:'original',src:'',addEventListener:(key,value)=>listeners.set(key,value),removeEventListener:key=>listeners.delete(key),removeAttribute(){this.src='';}};
 const dispose=loadNativeImage(image,'entry','https://example.invalid/image',{cacheOnly:true});
 dispose();resolveMint();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(image.src,'');assert.deepEqual(cancelled,['rivu-image://fixture/1']);assert.equal(listeners.size,0);
 const second=loadNativeImage(image,'entry','https://example.invalid/image',{cacheOnly:true});resolveMint();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(image.src,'rivu-image://fixture/2');assert.deepEqual(modes,['lookup','lookup']);second();assert.deepEqual(cancelled,['rivu-image://fixture/1','rivu-image://fixture/2']);assert.equal(image.title,'original');
});

test('failed resource clears the browser source before retry and repeated disposal cannot clear a remount',async()=>{
 const listeners=new Map(),image={title:'original',src:'',addEventListener:(key,value)=>listeners.set(key,value),removeEventListener:key=>listeners.delete(key),removeAttribute(){this.src='';}};
 const dispose=loadNativeImage(image,'entry','https://example.invalid/image');resolveMint();await new Promise(resolve=>setImmediate(resolve));
 const failedSource=image.src;listeners.get('error')();
 assert.equal(image.src,'','failed browser resource must be released during backoff');assert.ok(cancelled.includes(failedSource));
 dispose();const next=loadNativeImage(image,'entry','https://example.invalid/image');resolveMint();await new Promise(resolve=>setImmediate(resolve));
 const nextSource=image.src;assert.ok(nextSource);dispose();assert.equal(image.src,nextSource);assert.equal(listeners.size,2);
 next();assert.equal(image.src,'');assert.equal(listeners.size,0);
});
