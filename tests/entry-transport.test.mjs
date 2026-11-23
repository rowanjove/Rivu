import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('entry IPC transport is restricted to article GET and decodes standard JSON without evaluating content',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-entry-transport-')),outfile=join(directory,'transport.mjs');
 try{
  buildSync({entryPoints:['electron/entry-transport.ts'],outfile,bundle:true,platform:'node',format:'esm'});const {isEntryRead,isEntryResult,isBulkReadWrite,isFeedCategoryWrite,isFeedPatch,isCategoryDelete,decodeFeedTransport,decodeEntryTransport}=await import(pathToFileURL(outfile));
  for(const path of ['/api/entries/article-id','/api/entries/article-id?local=true','/api/entries/encoded%2Fid'])assert.equal(isEntryRead('GET',path),true);
  for(const [method,path] of [['POST','/api/entries/article-id'],['GET','/api/entries'],['GET','/api/entries?limit=100'],['GET','/api/entries/id/ai'],['GET','/api/entries/id/media'],['GET','/api/ai/settings'],['GET','//api/entries/id'],['GET','https://example.com/api/entries/id']])assert.equal(isEntryRead(method,path),false);
  assert.equal(isEntryResult('PATCH','/api/entries/id?fixture=1'),true);
  for(const [method,path] of [['POST','/api/entries/id'],['PATCH','/api/entries/id/tags'],['PATCH','//api/entries/id']])assert.equal(isEntryResult(method,path),false);
  for(const path of ['/api/entries/mark-read','/api/entries/mark-read/undo','/api/entries/mark-read?x=1'])assert.equal(isBulkReadWrite('POST',path),true);
  for(const [method,path] of [['GET','/api/entries/mark-read'],['POST','/api/entries/mark-read/undo/extra'],['POST','//api/entries/mark-read'],['POST','/api/entries/id']])assert.equal(isBulkReadWrite(method,path),false);
  for(const path of ['/api/feeds/bulk','/api/feeds/bulk?fixture=1'])assert.equal(isFeedCategoryWrite('POST',path,{action:'category'}),true);
  for(const [method,path] of [['GET','/api/feeds/bulk'],['PATCH','/api/feeds/bulk'],['POST','//api/feeds/bulk'],['POST','/api/feeds/bulk/extra'],['POST','https://example.invalid/api/feeds/bulk']])assert.equal(isFeedCategoryWrite(method,path,{action:'category'}),false);
  for(const body of [undefined,null,{},[],{action:'delete'},{action:'pause'},'category'])assert.equal(isFeedCategoryWrite('POST','/api/feeds/bulk',body),false);
  assert.equal(isFeedPatch('PATCH','/api/feeds/id?fixture=1'),true);assert.equal(isCategoryDelete('DELETE','/api/categories/id?fixture=1'),true);
  for(const path of ['/api/feeds','//api/feeds/id','/api/feeds/id/refresh','https://example.invalid/api/feeds/id'])assert.equal(isFeedPatch('PATCH',path),false);
  for(const path of ['/api/categories','//api/categories/id','/api/categories/id/extra','https://example.invalid/api/categories/id'])assert.equal(isCategoryDelete('DELETE',path),false);
  assert.equal(isFeedPatch('POST','/api/feeds/id'),false);assert.equal(isCategoryDelete('PATCH','/api/categories/id'),false);
  const feed={id:'feed-id',title:'中文😀\u0000',icon:'data:image/png;base64,'+'A'.repeat(1048576)};assert.deepEqual(decodeFeedTransport({feedJson:JSON.stringify(feed)}),feed);
  for(const value of [null,{}, {feedJson:'null'},{feedJson:'[]'},{feedJson:'{}'}, {feedJson:'{"id":42}'}])assert.throws(()=>decodeFeedTransport(value),/订阅传输结果无效/);
  const row={id:'article-id',content:'中文😀\n\u0000<script>globalThis.__entryEvaluated=true</script>',__protoField:{constructor:'data'}};assert.deepEqual(decodeEntryTransport({entryJson:JSON.stringify(row)}),row);assert.equal(globalThis.__entryEvaluated,undefined);
  for(const value of [undefined,null,'{}',{}, {entryJson:42},...[null,[],true,{}, {id:42}].map(row=>({entryJson:JSON.stringify(row)}))])assert.throws(()=>decodeEntryTransport(value),/传输结果无效/);assert.throws(()=>decodeEntryTransport({entryJson:'{invalid'}),SyntaxError);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
