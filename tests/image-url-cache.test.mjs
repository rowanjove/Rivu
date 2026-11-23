import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {FeedParser} from '../dist-server/feed-parser.js';
const worker=resolve('dist-server/feed-parse-worker.cjs'),actual=resolve('dist-server/feed-parse-task.cjs');
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-url-cache-')),count=join(directory,'calls'),task=join(directory,'task.cjs');
 writeFileSync(task,`const fs=require('node:fs'),mod=require(${JSON.stringify(actual)});Object.assign(exports,mod);exports.parseImageUrls=async(response,candidate)=>{fs.appendFileSync(${JSON.stringify(count)},'call|');if(response.text.includes('failOnce')&&!fs.existsSync(${JSON.stringify(join(directory,'failed'))})){fs.writeFileSync(${JSON.stringify(join(directory,'failed'))},'failed');throw Error('parse failure');}if(response.text==='large')return Array.from({length:9000},(_,i)=>'https://example.invalid/'+i+'x'.repeat(500));return mod.parseImageUrls(response,candidate);};`);
 const parser=new FeedParser(worker,task);return {parser,calls:()=>{try{return readFileSync(count,'utf8').split('|').filter(Boolean).length;}catch{return 0;}},async close(){await parser.stop();rmSync(directory,{recursive:true,force:true});}};
}
const entry={content:'<img src="one.png">',url:'https://example.invalid/a/article'};

test('identical image parsing coalesces concurrent work and returns independent arrays, while stopped parsers reject cached reads',async()=>{
 const f=fixture();try{
  const results=await Promise.all(Array.from({length:12},()=>f.parser.imageUrls(entry)));assert.equal(f.calls(),1);for(const result of results)assert.deepEqual(result,['https://example.invalid/a/one.png']);
  results[0].push('https://wrong.invalid/');assert.equal(results[1].length,1);assert.deepEqual(await f.parser.imageUrls(entry),['https://example.invalid/a/one.png']);assert.equal(f.calls(),1);
  await f.parser.stop();await assert.rejects(f.parser.imageUrls(entry),/已关闭/);
 }finally{await f.close();}
});

test('image parsing cache separates effective body, full text, description, base URL and cover inputs',async()=>{
 const f=fixture();try{
  const inputs=[entry,{...entry,content:'<img src="two.png">'},{...entry,full_content:'<img src="full.png">'},{url:entry.url,description:'<img src="description.png">'},{content:entry.content,feed_url:'https://example.invalid/b/article'},{...entry,cover:'https://example.invalid/cover.png'}];
  const expected=[['https://example.invalid/a/one.png'],['https://example.invalid/a/two.png'],['https://example.invalid/a/full.png'],['https://example.invalid/a/description.png'],['https://example.invalid/b/one.png'],['https://example.invalid/cover.png','https://example.invalid/a/one.png']];
  for(let i=0;i<inputs.length;i++)assert.deepEqual(await f.parser.imageUrls(inputs[i]),expected[i]);assert.equal(f.calls(),inputs.length);
  for(let i=0;i<inputs.length;i++)assert.deepEqual(await f.parser.imageUrls(inputs[i]),expected[i]);assert.equal(f.calls(),inputs.length);
 }finally{await f.close();}
});

test('distinct UTF-16 input strings never share cached image parsing even when URL normalization yields replacement characters',async()=>{
 const f=fixture();try{
  await f.parser.imageUrls({...entry,content:'<img src="/\uD800.png">'});await f.parser.imageUrls({...entry,content:'<img src="/\uD801.png">'});assert.equal(f.calls(),2);
 }finally{await f.close();}
});

test('failed image parsing is not memoized and can retry successfully',async()=>{
 const f=fixture(),input={...entry,content:entry.content+'<!-- failOnce -->'};try{
  await assert.rejects(f.parser.imageUrls(input),/parse failure/);assert.deepEqual(await f.parser.imageUrls(input),['https://example.invalid/a/one.png']);assert.equal(f.calls(),2);
 }finally{await f.close();}
});

test('oversized image URL results are returned without retaining them or evicting useful small results',async()=>{
 const f=fixture();try{
  await f.parser.imageUrls(entry);for(let i=0;i<2;i++)assert.equal((await f.parser.imageUrls({...entry,content:'large'})).length,9000);assert.equal(f.calls(),3);assert.deepEqual(await f.parser.imageUrls(entry),['https://example.invalid/a/one.png']);assert.equal(f.calls(),3);
 }finally{await f.close();}
});
