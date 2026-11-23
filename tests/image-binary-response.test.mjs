import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import Fastify from 'fastify';

test('streamed injection image replies retain exact binary bytes without materializing a UTF-8 body',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-binary-response-')),outfile=join(directory,'response.mjs'),app=Fastify();
 try{
  buildSync({entryPoints:['electron/image-response.ts'],outfile,bundle:true,platform:'node',format:'esm'});const {readImageResponse}=await import(pathToFileURL(outfile));
  const bytes=Buffer.alloc(8*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
  app.get('/image',(_req,reply)=>reply.type('image/png').send(bytes));
  const response=await app.inject({method:'GET',url:'/image',payloadAsStream:true});assert.equal(response.body,undefined);assert.equal(response.rawPayload,undefined);
  const result=await readImageResponse(response);assert.equal(result.mime,'image/png');assert.deepEqual(result.imageBytes,bytes);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});

test('binary response draining enforces bounds and rejects errors or broken streams without a successful pixel envelope',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-binary-response-errors-')),outfile=join(directory,'response.mjs');
 try{
  buildSync({entryPoints:['electron/image-response.ts'],outfile,bundle:true,platform:'node',format:'esm'});const {readImageResponse}=await import(pathToFileURL(outfile));
  const response=(statusCode,parts,mime='image/png')=>({statusCode,headers:{'content-type':mime},stream:()=>Readable.from(parts)});
  assert.deepEqual(await readImageResponse(response(204,[])),{imageBytes:null});
  await assert.rejects(readImageResponse(response(204,[Buffer.from('unexpected')])),/大小限制/);
  await assert.rejects(readImageResponse(response(200,[Buffer.alloc(8*1024*1024+1)])),/大小限制/);
  await assert.rejects(readImageResponse(response(409,[Buffer.from('{"error":"授权已经变化"}')])),/授权已经变化/);
  await assert.rejects(readImageResponse(response(500,[Buffer.alloc(16385)])),/大小限制/);
  await assert.rejects(readImageResponse(response(200,[Buffer.from('pixels')],'image/svg+xml')),/类型无效/);
  const stream=Readable.from((async function*(){yield Buffer.from('partial');throw Error('read failed');})());
  await assert.rejects(readImageResponse({statusCode:200,headers:{'content-type':'image/png'},stream:()=>stream}),/read failed/);assert.equal(stream.destroyed,true);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
