import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=mkdtempSync(join(tmpdir(),'rivu-image-protocol-')),out=join(directory,'module.mjs');
buildSync({entryPoints:['electron/image-protocol.ts'],outfile:out,bundle:true,platform:'node',format:'esm'});
const {NativeImageProtocol}=await import(pathToFileURL(out));test.after(()=>rmSync(directory,{recursive:true,force:true}));
const endpoint={baseUrl:'http://127.0.0.1:6543',token:'private-service-token'},raw='https://example.invalid/picture.png';
const request=url=>({url,method:'GET',initiatorOrigin:'null'});
function pixels(bytes=new Uint8Array([1,2,3])){return new Response(bytes,{headers:{'Content-Type':'image/png','Content-Length':String(bytes.length)}});}

test('Windows Electron file initiators require the exact verified origin plus a current image capability',async()=>{
 let calls=0;const channel=new NativeImageProtocol(async()=>{calls++;return pixels();},'file://');channel.setEndpoint(endpoint);const url=channel.url('entry',raw);
 for(const initiatorOrigin of [undefined,null,'null','file://evil','https://evil.invalid'])assert.equal((await channel.handle({...request(url),initiatorOrigin})).status,403);
 assert.equal((await channel.handle({...request(url.replace(/cap=[^&]+/,'cap='+'0'.repeat(64))),initiatorOrigin:'file://'})).status,403);
 const response=await channel.handle({...request(url),initiatorOrigin:'file://'});assert.equal(response.status,200);await response.arrayBuffer();assert.equal(calls,1);channel.setEndpoint(null);
});

test('native image forwarding reconstructs only fixed loopback requests and preserves bytes without credentials or renderer headers',async()=>{
 const calls=[],source=new Uint8Array(8*1024*1024).fill(199),channel=new NativeImageProtocol(async(url,options)=>{calls.push({url,options});return pixels(source);},'null');channel.setEndpoint(endpoint);
 const url=channel.url('entry',raw),response=await channel.handle({...request(url),headers:{Cookie:'malicious','X-Rivu-Token':'forged'},referrer:'https://evil.invalid/'});
 assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),source);assert.equal(response.headers.get('cache-control'),'no-store');
 const sent=new URL(calls[0].url);assert.equal(sent.origin,endpoint.baseUrl);assert.equal(sent.pathname,'/api/image-cache/load');assert.equal(sent.searchParams.get('transport'),'binary');assert.equal(sent.searchParams.get('entryId'),'entry');assert.equal(sent.searchParams.get('url'),raw);
 assert.deepEqual(calls[0].options.headers,{'X-Rivu-Token':endpoint.token,Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif'});assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'manual');assert.ok(!url.includes(endpoint.token));channel.setEndpoint(null);
});

test('native scheme rejects untrusted origins, old capabilities, duplicate arguments and arbitrary operations before backend access',async()=>{
 let calls=0;const channel=new NativeImageProtocol(async()=>{calls++;return pixels();},'null');channel.setEndpoint(endpoint);const good=channel.url('entry',raw);
 for(const req of [{...request(good),method:'POST'},{...request(good),initiatorOrigin:undefined},{...request(good),initiatorOrigin:'https://evil.invalid'},request(good+'&url='+encodeURIComponent(raw)),request(good.replace('/load?','/other?')),request(good.replace('local/','local:44/')),request(good.replace('local/','user@local/')),request(good.replace('entryId=entry','entryId=entry&extra=1')),request(good.replace(/cap=[^&]+/,'cap='+'0'.repeat(64)))])assert.equal((await channel.handle(req)).status,403);
 channel.rotate();assert.equal((await channel.handle(request(good))).status,403);assert.equal(calls,0);channel.setEndpoint(null);
});

test('native protocol fails closed across bad endpoints, pending fetches and navigation or maintenance epoch changes',async()=>{
 let resolve,signal;const pending=new Promise(done=>resolve=done),channel=new NativeImageProtocol(async(_url,options)=>{signal=options.signal;return pending;},'null');channel.setEndpoint(endpoint);
 const running=channel.handle(request(channel.url('entry',raw)));channel.setEndpoint(null);assert.equal(signal.aborted,true);resolve(pixels());assert.equal((await running).status,503);assert.throws(()=>channel.url('entry',raw),/暂不可用/);
 channel.setEndpoint(endpoint);assert.throws(()=>channel.setEndpoint({baseUrl:'https://evil.invalid',token:'secret'}));assert.throws(()=>channel.url('entry',raw),/暂不可用/);
});

test('native responses reject redirects, active MIME, empty or oversized bodies and inconsistent lengths',async()=>{
 for(const [status,mime,length,body,expected]of [[302,'image/png','3',new Uint8Array(3),502],[409,'application/json','3',new Uint8Array(3),409],[200,'image/svg+xml','3',new Uint8Array(3),502],[200,'image/png','0',new Uint8Array(0),502],[200,'image/png',String(8*1024*1024+1),new Uint8Array(1),502]]){
  const channel=new NativeImageProtocol(async()=>new Response(body,{status,headers:{'content-type':mime,'content-length':length}}),'null');channel.setEndpoint(endpoint);assert.equal((await channel.handle(request(channel.url('entry',raw)))).status,expected);channel.setEndpoint(null);
 }
 const channel=new NativeImageProtocol(async()=>new Response(new Uint8Array([1]),{headers:{'content-type':'image/png','content-length':'2'}}),'null');channel.setEndpoint(endpoint);const response=await channel.handle(request(channel.url('entry',raw)));await assert.rejects(response.arrayBuffer(),/已中止/);channel.setEndpoint(null);
});

test('native body cancellation and an epoch change release stream readers and deny bytes still in flight',async()=>{
 let read,cancelled=false;const body=new ReadableStream({pull:()=>new Promise(resolve=>read=resolve),cancel(){cancelled=true;read?.();}}),channel=new NativeImageProtocol(async()=>new Response(body,{headers:{'content-type':'image/png','content-length':'3'}}),'null');channel.setEndpoint(endpoint);
 const response=await channel.handle(request(channel.url('entry',raw)));await response.body.cancel();assert.equal(cancelled,true);channel.setEndpoint(null);
});

test('abandoned native responses release all concurrency slots on timeout without requiring another pull',async()=>{
 const channel=new NativeImageProtocol(async()=>pixels(),'null',1000);channel.setEndpoint(endpoint);const responses=[];
 for(let i=0;i<16;i++)responses.push(await channel.handle(request(channel.url('entry',raw))));
 assert.equal((await channel.handle(request(channel.url('entry',raw)))).status,429);
 await new Promise(done=>setTimeout(done,1100));const next=await channel.handle(request(channel.url('entry',raw)));assert.equal(next.status,200);await next.arrayBuffer();
 for(const response of responses)await response.body.cancel().catch(()=>{});channel.setEndpoint(null);
});

test('browser cancellation before headers aborts the private fetch and epoch changes cancel a pending body read',async()=>{
 let resolve,signal;const pending=new Promise(done=>resolve=done),client=new AbortController(),channel=new NativeImageProtocol(async(_url,options)=>{signal=options.signal;return pending;},'null');channel.setEndpoint(endpoint);
 const response=channel.handle({...request(channel.url('entry',raw)),signal:client.signal});client.abort();assert.equal(signal.aborted,true);resolve(pixels());assert.equal((await response).status,503);channel.setEndpoint(null);
 let cancelled=false,finish;
 const stream=new ReadableStream({pull:()=>new Promise(done=>finish=done),cancel(){cancelled=true;finish?.();}}),bodyChannel=new NativeImageProtocol(async()=>new Response(stream,{headers:{'content-type':'image/png','content-length':'3'}}),'null');bodyChannel.setEndpoint(endpoint);
 const body=await bodyChannel.handle(request(bodyChannel.url('entry',raw))),reading=body.arrayBuffer();bodyChannel.rotate();await assert.rejects(reading,/已中止/);assert.equal(cancelled,true);bodyChannel.setEndpoint(null);
});


test('explicit cancellation rejects late dispatch and releases all sixteen pre-header slots',async()=>{
 const signals=[],channel=new NativeImageProtocol(async(_url,{signal})=>{signals.push(signal);return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(pixels()),{once:true}));},'null');channel.setEndpoint(endpoint);
 const late=channel.url('entry',raw);channel.cancel(late);assert.equal((await channel.handle(request(late))).status,503);assert.equal(signals.length,0);
 const urls=Array.from({length:16},()=>channel.url('entry',raw)),pending=urls.map(url=>channel.handle(request(url)));
 assert.equal((await channel.handle(request(channel.url('entry',raw)))).status,429);
 for(const url of urls)channel.cancel(url);
 assert.equal(signals.filter(signal=>signal.aborted).length,16);assert.deepEqual((await Promise.all(pending)).map(response=>response.status),Array(16).fill(503));
 const fresh=channel.url('entry',raw),next=channel.handle(request(fresh));channel.cancel(urls[0]);assert.equal(signals.at(-1).aborted,false);channel.cancel(fresh);assert.equal((await next).status,503);channel.setEndpoint(null);
});

test('revocations are bounded, malformed cancellation is inert and epoch rotation isolates old resources',async()=>{
 let calls=0;const channel=new NativeImageProtocol(async()=>{calls++;return pixels();},'null');channel.setEndpoint(endpoint);
 const initial=channel.url('entry',raw);
 for(const invalid of [null,{},'https://evil.invalid',initial+'&extra=x',initial.replace(/v=\d+/,'v=999999'),initial.replace('/load?','/unknown?')])channel.cancel(invalid);
 const first=await channel.handle(request(initial));assert.equal(first.status,200);await first.arrayBuffer();
 for(let index=0;index<4097;index++)channel.cancel(channel.url('entry',raw));
 assert.equal((await channel.handle(request(initial))).status,403);
 const fresh=channel.url('entry',raw);channel.cancel(initial);const response=await channel.handle(request(fresh));assert.equal(response.status,200);await response.arrayBuffer();assert.equal(calls,2);channel.setEndpoint(null);
});
