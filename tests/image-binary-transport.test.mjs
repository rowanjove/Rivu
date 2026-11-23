import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';

test('binary image decoding preserves 8MiB pixels, MIME, byte length and null without persistent object URLs',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-binary-')),outfile=join(directory,'transport.mjs'),page=new JSDOM('');
 const previous={FileReader:globalThis.FileReader,Blob:globalThis.Blob};
 try{
  buildSync({entryPoints:['electron/image-transport.ts'],outfile,bundle:true,platform:'node',format:'esm'});
  const {decodeImageBinaryTransport}=await import(pathToFileURL(outfile));
  globalThis.FileReader=page.window.FileReader;globalThis.Blob=page.window.Blob;
  const bytes=new Uint8Array(8*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const result=await decodeImageBinaryTransport({imageBytes:bytes,mime:'image/png'});
  assert.equal(result.bytes,bytes.length);assert.equal(result.dataUrl,'data:image/png;base64,'+Buffer.from(bytes).toString('base64'));
  assert.equal(await decodeImageBinaryTransport({imageBytes:null}),null);
 }finally{Object.assign(globalThis,previous);page.window.close();rmSync(directory,{recursive:true,force:true});}
});

test('binary image envelopes reject oversized, empty, wrong-type or active content before creating browser resources',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-binary-invalid-')),outfile=join(directory,'transport.mjs');
 try{
  buildSync({entryPoints:['electron/image-transport.ts'],outfile,bundle:true,platform:'node',format:'esm'});
  const {imageBinaryPayload}=await import(pathToFileURL(outfile));
  for(const value of [null,{}, {imageBytes:'pixels',mime:'image/png'},{imageBytes:new ArrayBuffer(2),mime:'image/png'},{imageBytes:new Uint8Array(0),mime:'image/png'},{imageBytes:new Uint8Array(8*1024*1024+1),mime:'image/png'},{imageBytes:new Uint8Array(1),mime:'image/svg+xml'},{imageBytes:new Uint8Array(1),mime:'text/html'}])assert.throws(()=>imageBinaryPayload(value),/图片传输结果无效/);
  const bytes=new Uint8Array([1,2,3,4]),payload=imageBinaryPayload({imageBytes:bytes.subarray(1,3),mime:'image/webp'}).bytes;
  assert.deepEqual(payload,new Uint8Array([2,3]));assert.equal(payload.byteOffset,0);assert.equal(payload.buffer.byteLength,2);assert.notEqual(payload.buffer,bytes.buffer);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
