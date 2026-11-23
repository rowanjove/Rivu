import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/article-revision.ts'],bundle:true,format:'esm',write:false});
const {encodeArticleSource,articleSourceRevision}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
test('chunk encoding preserves exact UTF8 bytes including boundary pairs, lone surrogates and NUL',async()=>{
 const sources=['','abc','中文\0😀尾','a😀b😀c','\ud800x\udc00','abc\ud800\udc00尾','中'.repeat(101)+'😀', 'x'.repeat(32767)+'😀tail'];
 for(const source of sources)for(const chunkChars of [2,3,4,32768]){
  let yields=0;const bytes=await encodeArticleSource(source,{chunkChars,yieldTask:async()=>{yields++;}});
  assert.deepEqual(bytes,new TextEncoder().encode(source));if(source.length>chunkChars)assert.ok(yields>=2);
 }
});
test('incremental source revision matches a whole-source SHA256 on a large mixed input',async()=>{
 const source=('中文😀\0 &amp; <p>text</p>').repeat(6000);
 assert.equal(await articleSourceRevision(source),createHash('sha256').update(source).digest('hex'));
});
test('abort before work, between encoding chunks and during concatenation stops further yields',async()=>{
 for(const abortAt of [0,1,4]){
  const controller=new AbortController();let yields=0;if(!abortAt)controller.abort();
  await assert.rejects(encodeArticleSource('0123456789',{signal:controller.signal,chunkChars:4,yieldTask:async()=>{yields++;if(yields===abortAt)controller.abort();}}),{name:'AbortError'});
  assert.equal(yields,abortAt);
 }
 for(const chunkChars of [0,1,-1,Infinity,3.5,65537])await assert.rejects(encodeArticleSource('test',{chunkChars}),RangeError);
});
