import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=(await build({entryPoints:['src/native-image-bytes.ts'],bundle:true,platform:'browser',format:'esm',write:false,plugins:[{name:'fixture',setup(build){build.onResolve({filter:/^\.\/api$/},()=>({path:'fixture-api',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const api=globalThis.__nativeByteApi;',loader:'js'}));}}]})).outputFiles[0].text;
const deferred=()=>{let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve:v=>resolve(v),reject:e=>reject(e)};};
const flush=()=>new Promise(done=>setImmediate(done));
const minted=[],revoked=[];let sequence=0,nextRead,nextMint,nextRevoke;
globalThis.__nativeByteApi={imageUrl:async()=>{const uri='rivu-image://fixture/'+(++sequence);minted.push(uri);return nextMint?await nextMint.promise:uri;},readImageUrl:()=>nextRead.promise,cancelImageUrl:async uri=>{revoked.push(uri);if(nextRevoke)await nextRevoke.promise;}};
const {readNativeImageBytes,prepareNativeImageBytes}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('completed and failed reads revoke their own capability without changing returned bytes',async()=>{
 const bytes=new Uint8Array([0,255,12]);nextRead=deferred();
 const read=readNativeImageBytes('entry','https://example.invalid/image','load',new AbortController().signal);await flush();nextRead.resolve({bytes,mime:'image/png'});
 assert.deepEqual(await read,{bytes,mime:'image/png'});assert.equal(revoked.at(-1),minted.at(-1));
 nextRead=deferred();const failure=readNativeImageBytes('entry','https://example.invalid/image','lookup',new AbortController().signal),rejected=assert.rejects(failure,/source changed/);await flush();nextRead.reject(Error('source changed'));await rejected;assert.equal(revoked.at(-1),minted.at(-1));
});

test('cancellation during mint revokes the late capability and never starts byte reading',async()=>{
 const stop=new AbortController();nextMint=deferred();nextRead=deferred();
 const work=readNativeImageBytes('entry','https://example.invalid/image','load',stop.signal),rejected=assert.rejects(work,{name:'AbortError'});
 stop.abort();nextMint.resolve('rivu-image://fixture/late');await rejected;assert.equal(revoked.at(-1),'rivu-image://fixture/late');nextMint=undefined;
});

test('cancellation dispatches revocation but cannot release admission before main settles the read',async()=>{
 const stop=new AbortController();nextRead=deferred();let settled=false;
 const work=readNativeImageBytes('entry','https://example.invalid/image','load',stop.signal),rejected=assert.rejects(work,{name:'AbortError'}).then(()=>settled=true);
 await flush();const uri=minted.at(-1);stop.abort();await flush();assert.equal(revoked.at(-1),uri);assert.equal(settled,false);
 nextRead.resolve({bytes:new Uint8Array([1]),mime:'image/png'});await rejected;assert.equal(settled,true);assert.equal(revoked.filter(value=>value===uri).length,1);
});

test('prepared bytes can start decoding during revocation while plain read still waits completion',async()=>{
 const image={bytes:new Uint8Array([1,2,3]),mime:'image/png'};nextRead=deferred();nextRevoke=deferred();
 try{
  const work=prepareNativeImageBytes('entry','https://example.invalid/image','load',new AbortController().signal);await flush();nextRead.resolve(image);
  const packet=await work;assert.equal(packet.image,image);let done=false;packet.released.then(()=>done=true);await flush();assert.equal(done,false);assert.equal(revoked.at(-1),minted.at(-1));nextRevoke.resolve();await packet.released;
  nextRead=deferred();nextRevoke=deferred();let plainDone=false;
  const plain=readNativeImageBytes('entry','https://example.invalid/image','load',new AbortController().signal).then(value=>{plainDone=true;return value;});await flush();nextRead.resolve(image);await flush();assert.equal(plainDone,false);nextRevoke.resolve();assert.equal(await plain,image);
 }finally{nextRevoke?.resolve();nextRevoke=undefined;}
});

test('prepared revocation failure is observable without exposing the capability or changing plain-read compatibility',async()=>{
 const image={bytes:new Uint8Array([1]),mime:'image/png'};nextRead=deferred();nextRevoke=deferred();
 try{
  const work=prepareNativeImageBytes('entry','https://example.invalid/image','load',new AbortController().signal);await flush();nextRead.resolve(image);const packet=await work;
  const rejected=assert.rejects(packet.released,/revoke failed/);nextRevoke.reject(Error('revoke failed'));await rejected;assert.equal('source' in packet,false);
  nextRead=deferred();nextRevoke=deferred();const plain=readNativeImageBytes('entry','https://example.invalid/image','load',new AbortController().signal);await flush();nextRead.resolve(image);await flush();nextRevoke.reject(Error('revoke failed'));assert.equal(await plain,image);
 }finally{nextRevoke=undefined;}
});
