import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=mkdtempSync(join(tmpdir(),'rivu-image-direct-'));
for(const name of ['image-direct','image-protocol'])buildSync({entryPoints:['electron/'+name+'.ts'],outfile:join(directory,name+'.mjs'),bundle:true,platform:'node',format:'esm'});
const {createDirectImageFetch}=await import(pathToFileURL(join(directory,'image-direct.mjs'))),{NativeImageProtocol}=await import(pathToFileURL(join(directory,'image-protocol.mjs')));
test.after(()=>rmSync(directory,{recursive:true,force:true}));
const baseUrl='http://127.0.0.1:6543',token='private-token',raw='https://example.invalid/a.png',target=baseUrl+'/api/image-cache/load?'+new URLSearchParams({entryId:'entry',url:raw,transport:'binary'});
const init=signal=>({method:'GET',headers:{'X-Rivu-Token':token,Cookie:'ignored',Authorization:'ignored'},signal});
const request=url=>({url,method:'GET',initiatorOrigin:'file://'});
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('direct cancellation fixture deadline')),3000);})]);}finally{clearTimeout(timer);}}

test('direct native response preserves8MiB binary bytes and copies before later buffer mutation',async()=>{
 const bytes=Buffer.alloc(8*1024*1024,197),expected=Buffer.from(bytes);let checks=0;
 const fetch=createDirectImageFetch({baseUrl,token,read:async(id,url,mode)=>{assert.equal(id,'entry');assert.equal(url,raw);assert.equal(mode,'load');return {image:{data:bytes,mime:'image/png'},authorize:()=>checks++};}});
 const response=await fetch(target,init());assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(bytes.length));assert.equal(response.headers.get('cache-control'),'no-store');bytes.fill(0);assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);assert.equal(checks,1);
});

test('direct transport rejects unrelated targets and stale bindings without invoking the service',async()=>{
 let reads=0;const fetch=createDirectImageFetch({baseUrl,token,read:async()=>{reads++;throw Error('must not read');}});
 for(const url of [target.replace(baseUrl,'https://evil.invalid'),target.replace('127.0.0.1','user@127.0.0.1'),target+'#x',target.replace('/load?','/settings?'),target+'&entryId=other',target+'&extra=x',target.replace('transport=binary','transport=text')])await assert.rejects(fetch(url,init()));
 await assert.rejects(fetch(target,{...init(),method:'POST'}));await assert.rejects(fetch(target,{...init(),headers:{'X-Rivu-Token':'stale'}}));assert.equal(reads,0);
 assert.throws(()=>createDirectImageFetch({baseUrl:'http://evil.invalid:6543',token,read:async()=>{}}));
});

test('direct publication rechecks final authorization and validates binary bounds without native streams',async()=>{
 let image={data:Buffer.from([1,2,3]),mime:'image/png'},revoked=false;
 const fetch=createDirectImageFetch({baseUrl,token,read:async()=>({image,authorize(){if(revoked)throw Object.assign(Error('revoked'),{statusCode:409});}})});
 revoked=true;assert.equal((await fetch(target,init())).status,409);revoked=false;
 for(const bad of [{data:Buffer.alloc(0),mime:'image/png'},{data:Buffer.alloc(8*1024*1024+1),mime:'image/png'},{data:Buffer.from([1]),mime:'text/html'},{data:Buffer.from(new SharedArrayBuffer(3)),mime:'image/png'}]){image=bad;assert.equal((await fetch(target,init())).status,502);}
 image=null;assert.equal((await fetch(target,init())).status,204);
 const controller=new AbortController();controller.abort();assert.equal((await fetch(target,init(controller.signal))).status,503);
});

for(const reason of ['client','rotate','timeout'])test('direct '+reason+' cancellation drains16 accepted reads and makes every protocol slot reusable',async()=>{
 let full=false,aborted=0;const pending=new Set();
 const fetch=createDirectImageFetch({baseUrl,token,read:async(_id,_url,_mode,signal)=>{
  if(full)return {image:{data:Buffer.from([1,2,3]),mime:'image/png'},authorize(){}};
  return new Promise((_,reject)=>{pending.add(signal);signal.addEventListener('abort',()=>{aborted++;pending.delete(signal);reject(Object.assign(Error('aborted'),{statusCode:503}));},{once:true});});
 }}),channel=new NativeImageProtocol(fetch,'file://',reason==='timeout'?100:120000);channel.setEndpoint({baseUrl,token});
 const clients=Array.from({length:16},()=>new AbortController());
 try{
  const replies=clients.map(client=>channel.handle({...request(channel.url('entry',raw)),signal:client.signal}));assert.equal((await channel.handle(request(channel.url('entry',raw)))).status,429);
  if(reason==='client')clients.forEach(client=>client.abort());else if(reason==='rotate')channel.rotate();
  assert.ok((await bounded(Promise.all(replies))).every(response=>response.status===503));assert.equal(aborted,16);assert.equal(pending.size,0);
  full=true;const response=await channel.handle(request(channel.url('entry',raw)));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from([1,2,3]));
 }finally{channel.setEndpoint(null);}
});
