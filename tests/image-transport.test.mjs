import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('image IPC transport only decodes lookup/load GET results, including null cache misses and exact large pixel strings',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-transport-')),outfile=join(directory,'transport.mjs');
 try{
  buildSync({entryPoints:['electron/entry-transport.ts'],outfile,bundle:true,platform:'node',format:'esm'});
  const {isImageRead,decodeImageTransport}=await import(pathToFileURL(outfile));
  for(const mode of ['lookup','load'])for(const tail of ['', '?entryId=1&url=https%3A%2F%2Fexample.invalid'])assert.equal(isImageRead('GET','/api/image-cache/'+mode+tail),true);
  for(const [method,path]of [['POST','/api/image-cache/load'],['GET','/api/image-cache/load/extra'],['GET','/api/image-cache/cache'],['GET','//api/image-cache/load'],['GET','https://example.invalid/api/image-cache/load']])assert.equal(isImageRead(method,path),false);
  assert.equal(decodeImageTransport({imageJson:'null'}),null);
  const row={dataUrl:'data:image/png;base64,'+Buffer.alloc(8*1024*1024,7).toString('base64'),bytes:8*1024*1024};assert.deepEqual(decodeImageTransport({imageJson:JSON.stringify(row)}),row);
  for(const value of [null,{}, {imageJson:'[]'}, {imageJson:'{}'}, {imageJson:'{"dataUrl":"javascript:alert(1)","bytes":1}'}, {imageJson:'{"dataUrl":"data:image/png;base64,AA","bytes":-1}'}])assert.throws(()=>decodeImageTransport(value),/图片传输结果无效/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
