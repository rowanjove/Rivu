import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {deflateSync,crc32} from 'node:zlib';
const compiled=buildSync({entryPoints:['src/bitmap-frame.ts'],bundle:true,platform:'browser',format:'esm',write:false}).outputFiles[0].text;
const {inspectBitmapFrame,renderBitmapFrame,bitmapFrameUsage}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
function chunk(type,data=Buffer.alloc(0)){
 const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;
}
function png(width=1,height=1,extras=[]){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),...extras,chunk('IDAT',deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND')]);
 return {bytes:new Uint8Array(bytes),mime:'image/png'};
}
const canvas=()=>({width:1,height:1,frames:[],getContext(type){assert.equal(type,'bitmaprenderer');return {transferFromImageBitmap:bitmap=>this.frames.push(bitmap)};}});
const bitmap=(width=1,height=1)=>({width,height,closed:0,close(){this.closed++;}});
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
const flush=()=>new Promise(done=>setImmediate(done));

test('offset views, truncated chunks and oversized envelopes cannot bypass bounded preflight',()=>{
 const good=png(),wrapped=new Uint8Array(good.bytes.length+16);wrapped.set(good.bytes,8);
 assert.equal(inspectBitmapFrame({bytes:wrapped.subarray(8,-8),mime:'image/png'}).kind,'static');
 assert.equal(inspectBitmapFrame({bytes:good.bytes.subarray(0,-2),mime:'image/png'}).reason,'format');
 const broken=Uint8Array.from(good.bytes);new DataView(broken.buffer).setUint32(8,0xffffffff);
 assert.equal(inspectBitmapFrame({bytes:broken,mime:'image/png'}).reason,'format');
 assert.equal(inspectBitmapFrame({bytes:new Uint8Array(8*1024*1024+1),mime:'image/png'}).reason,'bytes');
});

test('animated formats, Exif/ICC, huge dimensions and hostile metadata fall back before bitmap allocation',async()=>{
 assert.equal(inspectBitmapFrame(png()).kind,'static');
 assert.equal(inspectBitmapFrame(png(1,1,[chunk('acTL',Buffer.alloc(8))])).reason,'animation');
 assert.equal(inspectBitmapFrame(png(4096,4096)).reason,'dimensions');
 assert.equal(inspectBitmapFrame(png(1,1,[chunk('iCCP')])).reason,'color-profile');
 assert.equal(inspectBitmapFrame(png(1,1,Array.from({length:4096},()=>chunk('tEXt')))).reason,'metadata-limit');
 for(const mime of ['image/gif','image/webp','image/avif','image/svg+xml'])assert.equal(inspectBitmapFrame({bytes:new Uint8Array([1]),mime}).kind,'fallback');
 for(const marker of [225,226])assert.equal(inspectBitmapFrame({bytes:new Uint8Array([255,216,255,marker,0,2]),mime:'image/jpeg'}).reason,'metadata');
 const original=globalThis.createImageBitmap;let calls=0;globalThis.createImageBitmap=async()=>{calls++;return bitmap();};
 try{assert.equal((await renderBitmapFrame(canvas(),async()=>png(1,1,[chunk('acTL',Buffer.alloc(8))]),new AbortController().signal)).reason,'animation');assert.equal(calls,0);}finally{globalThis.createImageBitmap=original;}
});

test('superseding an in-flight read aborts its provider and cannot clear the new frame',async()=>{
 const original=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>bitmap();
 const target=canvas(),pending=deferred();let readSignal;
 try{
  const old=renderBitmapFrame(target,signal=>{readSignal=signal;return pending.promise;},new AbortController().signal);
  const rejected=assert.rejects(old,{name:'AbortError'});
  const current=await renderBitmapFrame(target,async()=>png(),new AbortController().signal);
  assert.equal(readSignal.aborted,true);pending.resolve(png());await rejected;
  assert.equal(current.kind,'ready');assert.equal(target.frames.length,1);assert.equal(target.width,1);
  current.release();current.release();assert.equal(target.width,0);assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().inflight,0);
 }finally{globalThis.createImageBitmap=original;}
});

test('aborting non-cancellable decoder work keeps its reservation until late bitmap is closed',async()=>{
 const original=globalThis.createImageBitmap,pending=deferred(),decoded=bitmap(),stop=new AbortController();
 globalThis.createImageBitmap=()=>pending.promise;
 try{
  const target=canvas(),work=renderBitmapFrame(target,async()=>png(),stop.signal),rejected=assert.rejects(work,{name:'AbortError'});
  await flush();assert.equal(bitmapFrameUsage().decoders,1);assert.equal(bitmapFrameUsage().reservedBytes,4);assert.equal(bitmapFrameUsage().inflight,1);
  stop.abort();assert.equal(bitmapFrameUsage().reservedBytes,4);pending.resolve(decoded);await rejected;
  assert.equal(decoded.closed,1);assert.equal(target.frames.length,0);assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().decoders,0);assert.equal(bitmapFrameUsage().inflight,0);
 }finally{globalThis.createImageBitmap=original;}
});

test('live frames hold a decoded pixel budget and releasing an old receipt cannot erase its replacement',async()=>{
 const original=globalThis.createImageBitmap;globalThis.createImageBitmap=async()=>bitmap(2048,2048);
 const frames=[];
 try{
  const targets=Array.from({length:5},canvas);
  for(const target of targets.slice(0,4))frames.push(await renderBitmapFrame(target,async()=>png(2048,2048),new AbortController().signal));
  assert.ok(frames.every(f=>f.kind==='ready'));assert.equal(bitmapFrameUsage().reservedBytes,64*1024*1024);
  assert.equal((await renderBitmapFrame(targets[4],async()=>png(2048,2048),new AbortController().signal)).reason,'budget');
  const replacement=await renderBitmapFrame(targets[0],async()=>png(2048,2048),new AbortController().signal);frames.push(replacement);
  frames[0].release();assert.equal(targets[0].width,2048);assert.equal(bitmapFrameUsage().reservedBytes,64*1024*1024);
 }finally{for(const frame of frames)if(frame.kind==='ready')frame.release();globalThis.createImageBitmap=original;}
 assert.equal(bitmapFrameUsage().reservedBytes,0);
});

test('decoder admission, decode failures and missing canvas context leave no reservation behind',async()=>{
 const original=globalThis.createImageBitmap,a=deferred(),b=deferred();let calls=0;
 globalThis.createImageBitmap=()=>++calls===1?a.promise:b.promise;
 const releases=[];
 try{
  const first=renderBitmapFrame(canvas(),async()=>png(),new AbortController().signal),second=renderBitmapFrame(canvas(),async()=>png(),new AbortController().signal);
  await flush();let reads=0;assert.equal((await renderBitmapFrame(canvas(),async()=>{reads++;return png();},new AbortController().signal)).reason,'busy');assert.equal(reads,0);
  a.resolve(bitmap());b.resolve(bitmap());releases.push(await first,await second);
 }finally{for(const frame of releases)frame.release();globalThis.createImageBitmap=original;}
 globalThis.createImageBitmap=async()=>{throw Error('CRC rejected');};
 try{assert.equal((await renderBitmapFrame(canvas(),async()=>png(),new AbortController().signal)).reason,'decode');}finally{globalThis.createImageBitmap=original;}
 const decoded=bitmap();globalThis.createImageBitmap=async()=>decoded;
 try{assert.equal((await renderBitmapFrame({...canvas(),getContext:()=>null},async()=>png(),new AbortController().signal)).reason,'context');assert.equal(decoded.closed,1);}finally{globalThis.createImageBitmap=original;}
 const rejected=bitmap();globalThis.createImageBitmap=async()=>rejected;
 try{
  const target={...canvas(),getContext:()=>({transferFromImageBitmap(){throw Error('Context lost');}})};
  assert.equal((await renderBitmapFrame(target,async()=>png(),new AbortController().signal)).reason,'context');
  assert.equal(target.width,0);assert.equal(target.height,0);assert.equal(rejected.closed,1);
 }finally{globalThis.createImageBitmap=original;}
 assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().decoders,0);
});

test('cancelled providers retain admission until settlement and blocked providers are never started',async()=>{
 const a=deferred(),b=deferred(),stopA=new AbortController(),stopB=new AbortController();
 const first=renderBitmapFrame(canvas(),()=>a.promise,stopA.signal),second=renderBitmapFrame(canvas(),()=>b.promise,stopB.signal);
 const rejectedA=assert.rejects(first,{name:'AbortError'}),rejectedB=assert.rejects(second,{name:'AbortError'});
 stopA.abort();stopB.abort();assert.equal(bitmapFrameUsage().inflight,2);
 let calls=0;assert.equal((await renderBitmapFrame(canvas(),async()=>{calls++;return png();},new AbortController().signal)).reason,'busy');assert.equal(calls,0);
 a.resolve(png());b.resolve(png());await Promise.all([rejectedA,rejectedB]);assert.equal(bitmapFrameUsage().inflight,0);
});

test('decoding overlaps release acknowledgement but a frame cannot publish before acknowledgement',async()=>{
 const original=globalThis.createImageBitmap,released=deferred(),decoded=bitmap(),target=canvas();let started=false;
 globalThis.createImageBitmap=async()=>{started=true;return decoded;};
 try{
  const work=renderBitmapFrame(target,async()=>({...png(),released:released.promise}),new AbortController().signal);
  await flush();assert.ok(started);assert.equal(target.frames.length,0);assert.equal(bitmapFrameUsage().inflight,1);assert.equal(bitmapFrameUsage().reservedBytes,4);
  released.resolve();const frame=await work;assert.equal(frame.kind,'ready');assert.equal(target.frames.length,1);frame.release();
 }finally{released.resolve();globalThis.createImageBitmap=original;}
 assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().inflight,0);
});

test('abort while decoded pixels await release retains reservation and never publishes the late frame',async()=>{
 const original=globalThis.createImageBitmap,released=deferred(),decoded=bitmap(),target=canvas(),stop=new AbortController();globalThis.createImageBitmap=async()=>decoded;
 try{
  const work=renderBitmapFrame(target,async()=>({...png(),released:released.promise}),stop.signal),rejected=assert.rejects(work,{name:'AbortError'});
  await flush();stop.abort();assert.equal(bitmapFrameUsage().reservedBytes,4);assert.equal(bitmapFrameUsage().inflight,1);assert.equal(decoded.closed,0);assert.equal(target.frames.length,0);
  released.resolve();await rejected;assert.equal(decoded.closed,1);assert.equal(target.frames.length,0);
 }finally{released.resolve();globalThis.createImageBitmap=original;}
 assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().inflight,0);
});

test('late provider release is awaited even if cancellation precedes provider delivery',async()=>{
 const pending=deferred(),released=deferred(),stop=new AbortController();
 const work=renderBitmapFrame(canvas(),()=>pending.promise,stop.signal),rejected=assert.rejects(work,{name:'AbortError'});
 stop.abort();pending.resolve({...png(),released:released.promise});await flush();assert.equal(bitmapFrameUsage().inflight,1);released.resolve();await rejected;assert.equal(bitmapFrameUsage().inflight,0);
});

test('release rejection and unsupported input cannot bypass cleanup or show unacknowledged pixels',async()=>{
 const original=globalThis.createImageBitmap,decoded=bitmap(),target=canvas();globalThis.createImageBitmap=async()=>decoded;
 try{
  assert.equal((await renderBitmapFrame(target,async()=>({...png(),released:Promise.reject(Error('not revoked'))}),new AbortController().signal)).reason,'release');
  assert.equal(decoded.closed,1);assert.equal(target.frames.length,0);
  const released=deferred();let done=false;const work=renderBitmapFrame(canvas(),async()=>({...png(4096,4096),released:released.promise}),new AbortController().signal).then(value=>{done=true;return value;});
  await flush();assert.equal(done,false);assert.equal(bitmapFrameUsage().inflight,1);released.resolve();assert.equal((await work).reason,'dimensions');
 }finally{globalThis.createImageBitmap=original;}
 assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().inflight,0);
});

test('superseded decoded work cannot clear a replacement frame when its release acknowledgement arrives late',async()=>{
 const original=globalThis.createImageBitmap,released=deferred(),oldBitmap=bitmap(),newBitmap=bitmap(),target=canvas();let calls=0;globalThis.createImageBitmap=async()=>++calls===1?oldBitmap:newBitmap;
 let replacement;
 try{
  const previous=renderBitmapFrame(target,async()=>({...png(),released:released.promise}),new AbortController().signal),rejected=assert.rejects(previous,{name:'AbortError'});
  await flush();replacement=await renderBitmapFrame(target,async()=>png(),new AbortController().signal);assert.equal(replacement.kind,'ready');assert.equal(target.frames.length,1);
  released.resolve();await rejected;assert.equal(target.width,1);assert.equal(target.frames[0],newBitmap);assert.equal(oldBitmap.closed,1);assert.equal(bitmapFrameUsage().reservedBytes,4);
 }finally{released.resolve();replacement?.release();globalThis.createImageBitmap=original;}
 assert.equal(bitmapFrameUsage().reservedBytes,0);assert.equal(bitmapFrameUsage().inflight,0);
});
