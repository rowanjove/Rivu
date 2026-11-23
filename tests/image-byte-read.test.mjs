import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
const source=buildSync({entryPoints:['electron/image-protocol.ts'],bundle:true,platform:'node',format:'esm',write:false}).outputFiles[0].text;
const {NativeImageProtocol}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const endpoint={baseUrl:'http://127.0.0.1:6543',token:'fixture-only'},raw='https://example.invalid/picture.png';
const request=url=>({url,method:'GET',initiatorOrigin:'file://'});
const setup=(timeout=120000)=>{const channel=new NativeImageProtocol(async()=>new Response(null,{status:204}),'file://',timeout);channel.setEndpoint(endpoint);return channel;};
const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
const prepared=(bytes=Buffer.from([1,2,3]))=>({image:{data:bytes,mime:'image/png'},authorize(){}});

test('original8MiB offset bytes and MIME survive, and recipient plus final article grants are rechecked',async()=>{
 const channel=setup(),storage=Buffer.alloc(8*1024*1024+16,7),bytes=storage.subarray(8,-8),checks=[];
 const envelope=await channel.readBytes(request(channel.url('entry',raw)),async()=>({image:{data:bytes,mime:'image/png'},authorize(){checks.push('article');}}),()=>checks.push('recipient'));
 assert.deepEqual(Buffer.from(envelope.imageBytes),bytes);assert.equal(envelope.imageBytes.byteOffset,0);assert.equal(envelope.imageBytes.buffer.byteLength,bytes.length);assert.notEqual(envelope.imageBytes.buffer,bytes.buffer);assert.equal(envelope.mime,'image/png');assert.deepEqual(checks,['recipient','article']);
 const small=await channel.readBytes(request(channel.url('entry',raw)),async()=>prepared(Buffer.concat([Buffer.from([7,8,9])])),()=>{});
 assert.equal(small.imageBytes.byteOffset,0);assert.equal(small.imageBytes.buffer.byteLength,3);assert.deepEqual([...small.imageBytes],[7,8,9]);
 assert.deepEqual(await channel.readBytes(request(channel.url('entry',raw)),async()=>({image:null,authorize(){checks.push('null');}}),()=>{}),{imageBytes:null});assert.equal(checks.at(-1),'null');
 await assert.rejects(channel.readBytes(request(channel.url('entry',raw)),async()=>prepared(),()=>{throw Error('wrong frame');}),{statusCode:403});
 await assert.rejects(channel.readBytes(request(channel.url('entry',raw)),async()=>({image:prepared().image,authorize(){throw Object.assign(Error('source changed'),{statusCode:409});}}),()=>{}),{statusCode:409});
});

test('forged, stale, wrong-origin and out-of-range capabilities never enter the byte provider',async()=>{
 const channel=setup(),uri=channel.url('entry',raw);let reads=0;const read=async()=>{reads++;return prepared();};
 const forged=new URL(uri);forged.searchParams.set('v','9999999');
 for(const value of [uri+'#fragment',uri+'&entryId=other',forged.href,uri.replace('/load?','/settings?'),uri.replace('rivu-image:','https:'),null])await assert.rejects(channel.readBytes(request(value),read,()=>{}),{statusCode:403});
 await assert.rejects(channel.readBytes({...request(uri),initiatorOrigin:'https://evil.invalid'},read,()=>{}),{statusCode:403});
 channel.rotate();await assert.rejects(channel.readBytes(request(uri),read,()=>{}),{statusCode:403});assert.equal(reads,0);
});

for(const reason of ['consumer','navigation','endpoint','abort-signal'])test(reason+' cancels only its scope and blocks late byte publication',async()=>{
 const channel=setup(),uri=channel.url('entry',raw),other=channel.url('entry',raw),pending=deferred(),client=new AbortController();let signal;
 const work=channel.readBytes({...request(uri),signal:client.signal},async(_id,_url,_mode,current)=>{signal=current;return pending.promise;},()=>{});
 const rejected=assert.rejects(work,{statusCode:503});
 if(reason==='consumer')channel.cancel(uri);else if(reason==='navigation')channel.rotate();else if(reason==='endpoint')channel.setEndpoint(endpoint);else client.abort();
 assert.equal(signal.aborted,true);pending.resolve(prepared());await rejected;
 if(reason==='consumer'||reason==='abort-signal')assert.ok((await channel.readBytes(request(other),async()=>prepared(),()=>{})).imageBytes);
});

test('cancelled providers keep all sixteen slots until their non-abortable work settles, even across navigation',async()=>{
 const channel=setup(),pending=Array.from({length:16},deferred),uris=pending.map(()=>channel.url('entry',raw));
 const work=pending.map((p,index)=>channel.readBytes(request(uris[index]),()=>p.promise,()=>{}));
 const rejected=work.map(p=>assert.rejects(p,{statusCode:503}));for(const uri of uris)channel.cancel(uri);channel.rotate();
 let called=false;await assert.rejects(channel.readBytes(request(channel.url('entry',raw)),async()=>{called=true;return prepared();},()=>{}),{statusCode:429});assert.equal(called,false);
 assert.equal((await channel.handle(request(channel.url('entry',raw)))).status,429);
 pending.forEach(p=>p.resolve(prepared()));await Promise.all(rejected);
 assert.ok((await channel.readBytes(request(channel.url('entry',raw)),async()=>prepared(),()=>{})).imageBytes);
});

test('timeouts, invalid envelopes and final grant mutation cannot leak bytes or poison future reads',async()=>{
 const channel=setup(20),pending=deferred();let signal;
 const work=channel.readBytes(request(channel.url('entry',raw)),async(_id,_url,_mode,current)=>{signal=current;return pending.promise;},()=>{}),rejected=assert.rejects(work,{statusCode:503});
 await new Promise(done=>setTimeout(done,35));assert.equal(signal.aborted,true);pending.resolve(prepared());await rejected;
 for(const image of [{data:Buffer.alloc(0),mime:'image/png'},{data:Buffer.alloc(8*1024*1024+1),mime:'image/png'},{data:Buffer.from([1]),mime:'image/svg+xml'},{data:Buffer.from(new SharedArrayBuffer(3)),mime:'image/png'}])await assert.rejects(channel.readBytes(request(channel.url('entry',raw)),async()=>({image,authorize(){}}),()=>{}),{statusCode:502});
 await assert.rejects(channel.readBytes(request(channel.url('entry',raw)),async()=>({image:prepared().image,authorize(){channel.rotate();}}),()=>{}),{statusCode:503});
 assert.ok((await channel.readBytes(request(channel.url('entry',raw)),async()=>prepared(),()=>{})).imageBytes);
});
