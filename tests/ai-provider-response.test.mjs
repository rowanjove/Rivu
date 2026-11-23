import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readAIResponse,decodeAIProviderResponse,AI_RESPONSE_BYTES,AI_CONTENT_CHARS} from '../dist-server/ai-provider-response.js';
import {FeedParser} from '../dist-server/feed-parser.js';
const encoder=new TextEncoder();
test('successful responses reject malformed UTF-8 while bounded HTTP error prefixes tolerate split characters',async()=>{
 const malformed=new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(0x22,0xc3,0x28,0x22));controller.close();}}));await assert.rejects(readAIResponse(malformed,16),error=>error.statusCode===502&&/UTF-8/.test(error.message));
 assert.equal(await readAIResponse(new Response('"�"'),16),'"�"');assert.equal(await readAIResponse(new Response('中文'),1,true),'�');assert.equal(await readAIResponse(new Response('recovered'),16),'recovered');
});
test('declared oversize, streamed oversize and invalid bytes are canceled without waiting for the sender',async()=>{
 let canceled=0;const response=new Response(new ReadableStream({cancel(){canceled++;return new Promise(()=>{});}}),{headers:{'content-length':'1000'}});await assert.rejects(readAIResponse(response,32),/超过大小限制/);assert.equal(canceled,1);
 const streamed=new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode('x'.repeat(40)));},cancel(){canceled++;}}));await assert.rejects(readAIResponse(streamed,32),/超过大小限制/);assert.equal(canceled,2);
 const invalid=new Response(new ReadableStream({start(controller){controller.enqueue('not bytes');},cancel(){canceled++;}}));await assert.rejects(readAIResponse(invalid,32),/字节流无效/);assert.equal(canceled,3);
});
test('byte limits include fragmented UTF-8 and BOM, error previews truncate and aborts release capacity',async()=>{
 const raw=encoder.encode('\ufeff{"model":"中文😀"}');let at=0;const fragmented=new Response(new ReadableStream({pull(controller){if(at===raw.length)controller.close();else controller.enqueue(raw.subarray(at,++at));}}));assert.equal(await readAIResponse(fragmented,raw.length),'{"model":"中文😀"}');
 let canceled=false;const error=new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode('abcdef'.repeat(1000)));},cancel(){canceled=true;}}));assert.equal(await readAIResponse(error,4,true),'abcd');assert.equal(canceled,true);
 const failed=new Response(new ReadableStream({start(controller){controller.error(Error('fixture abort'));}}));await assert.rejects(readAIResponse(failed,AI_RESPONSE_BYTES),/fixture abort/);assert.equal(await readAIResponse(new Response('ok'),2),'ok');
});
test('aggregate 64MiB storage admission rejects before reading and is recovered after all failures',async()=>{
 const held=[],controllers=[];for(let i=0;i<8;i++){const response=new Response(new ReadableStream({start(controller){controllers.push(controller);}}));held.push(readAIResponse(response,AI_RESPONSE_BYTES));}
 let canceled=false;const ninth=new Response(new ReadableStream({cancel(){canceled=true;}}));await assert.rejects(readAIResponse(ninth,AI_RESPONSE_BYTES),error=>error.statusCode===503&&error.resourceBusy);assert.equal(canceled,true);controllers.forEach(controller=>controller.error(Error('fixture release')));await Promise.all(held.map(result=>assert.rejects(result,/fixture release/)));assert.equal(await readAIResponse(new Response('after'),AI_RESPONSE_BYTES),'after');
});
test('provider JSON validates content type and size, discards padding and preserves optional model lists',()=>{
 assert.deepEqual(decodeAIProviderResponse('{"data":[{"id":"fixture"}],"padding":"ignored"}','models'),{model:'fixture'});assert.deepEqual(decodeAIProviderResponse('{}','models'),{model:''});assert.deepEqual(decodeAIProviderResponse('{"choices":[{"message":{"content":"  中文😀  "}}]}','completion'),{content:'中文😀'});
 for(const text of ['null','[]','{broken','{"choices":[{"message":{"content":{}}}]}'])assert.throws(()=>decodeAIProviderResponse(text,'completion'),error=>error.statusCode===502);assert.throws(()=>decodeAIProviderResponse(JSON.stringify({choices:[{message:{content:'x'.repeat(AI_CONTENT_CHARS+1)}}]}),'completion'),/超过大小限制/);assert.throws(()=>decodeAIProviderResponse(JSON.stringify({data:[{id:'x'.repeat(201)}]}),'models'),/模型名称无效/);
});
test('provider decoding uses the shared persistent parser and recovers after invalid JSON',async()=>{
 const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));
 try{assert.deepEqual(await parser.aiProviderJson(JSON.stringify({choices:[{message:{content:'worker answer'}}],padding:'x'.repeat(2*1024*1024)}),'completion'),{content:'worker answer'});await assert.rejects(parser.aiProviderJson('{broken','completion'),/JSON 无效/);assert.deepEqual(await parser.aiProviderJson('{"data":[{"id":"worker-model"}]}','models'),{model:'worker-model'});await assert.rejects(parser.aiProviderJson('{}'.repeat(100),'invalid'),/参数无效/);}finally{await parser.stop();}
});

