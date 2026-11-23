import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdtempSync,copyFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {imageUrls} from '../dist-server/offline.js';
import {FeedParser} from '../dist-server/feed-parser.js';
import {simpleArticleImageUrl} from '../server/image-url-shape.ts';
const require=createRequire(import.meta.url),{parseImageUrls}=require('../dist-server/image-url-task.cjs');
const base='https://example.invalid/a/article';
const documents=[
 '<image src="alias.png"><IMAGE src="upper-alias.png">',
 '<IMG SRC="../one.png?x=1&amp;y=2"><img src="//cdn.invalid/two.png"><img src="../one.png?x=1&amp;y=2">',
 '<template><img src="hidden.png"></template><img src="shown.png">',
 '<script>"<img src=script.png>"</script><style><img src=style.png></style><textarea><img src=text.png></textarea>',
 '<noscript><img src="no-script.png"></noscript><iframe><img src=frame.png></iframe>',
 '<table><img src="foster.png"><tr><td><img src="cell.png"></table><img src="end.png">',
 '<svg><image href="svg.png"/><foreignObject><img src="foreign.png"></foreignObject></svg><math><mtext><img src="math.png"></mtext></math>',
 '<img src="one.png" SRC="two.png"><img src=""><img src="   "><img srcset="srcset.png 1x"><!-- <img src=comment.png> -->',
 '<img src="data:image/png;base64,AA"><img src="file:///C:/private"><img src="javascript:alert(1)"><img src="https://user:secret@example.invalid/x"><img src="https://example.invalid/x">',
 '<base href="https://wrong.invalid/"><img src="relative.png"><img src="/nul\0.png"><img src="/\uD800.png">',
 '<!doctype html><html><head><img src="head.png"></head><body><picture><source srcset="other.png"><img src="body.png"></picture></body></html>',
 '<template><template><img src="nested.png"></template></template><select><img src="discarded.png"></select><img src="valid.png">',
 '<svg><g><img src="breakout.png"></g></svg><x-custom><img src="custom.png"></x-custom>',
];

test('lightweight image parser matches the existing document parser on malformed HTML, inert trees, URL policy and document order',()=>{
 for(const content of documents)for(const url of [base,undefined,'invalid base'])for(const cover of [undefined,'../cover.png','https://cover.invalid/x','https://user:secret@example.invalid/x']){
  const entry={id:'',saved:0,content,url,cover};
  assert.deepEqual(parseImageUrls({text:content,url:url||'',type:'text/html'},{url:url||'',cover}),imageUrls(entry),JSON.stringify({content,url,cover}));
 }
});

test('bounded single-image recognition agrees with document parsing and declines complex markup',()=>{
 for(const src of ['../image.png','//cdn.invalid/image.png','https://example.invalid/image.png?x=1','https://u:p@example.invalid/image.png','data:image/png;base64,AA']){
  for(const text of [`<img src="${src}">`,`<p> <img src="${src}" alt="中文" /> </p>`]){
   assert.equal(simpleArticleImageUrl(text,base),parseImageUrls({text,url:base,type:'text/html'},{url:base})[0]);
  }
 }
 for(const text of ['<template><img src="image.png"></template>','<!--<img src="image.png">-->','<img src="a&amp;b">','<img src="a" src="b">','<img src="a\u0000">','<img src="中文.png">','<img src="a">'+' '.repeat(1024)])assert.equal(simpleArticleImageUrl(text,base),undefined);
});

test('stock image Worker uses the standalone task and preserves effective input precedence',async()=>{
 const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));
 try{
  assert.deepEqual(await parser.imageUrls({url:base,content:'<img src="body.png">',full_content:'<img src="full.png">',cover:'https://cover.invalid/x'}),['https://cover.invalid/x','https://example.invalid/a/full.png']);
  assert.deepEqual(await parser.imageUrls({feed_url:base,description:'<noscript><img src="description.png"></noscript>'}),['https://example.invalid/a/description.png']);
 }finally{await parser.stop();}
});

test('deep HTML traversal avoids recursive JavaScript stack exhaustion and keeps document order',()=>{
 const text='<div>'.repeat(12000)+'<img src="deep.png">'+'</div>'.repeat(12000)+'<img src="last.png">';
 assert.deepEqual(parseImageUrls({text,url:base,type:'text/html'},{url:base}),['https://example.invalid/a/deep.png','https://example.invalid/a/last.png']);
});

test('split packaged worker/task directories use the explicitly selected image task without loading the heavy task',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-image-split-'));
 const unpacked=join(directory,'app.asar.unpacked'),packed=join(directory,'app.asar');mkdirSync(unpacked);mkdirSync(packed);
 const worker=join(unpacked,'feed-parse-worker.cjs'),heavy=join(packed,'feed-parse-task.cjs');copyFileSync(resolve('dist-server/feed-parse-worker.cjs'),worker);
 writeFileSync(heavy,"throw Error('heavy task must not load for images');");
 const parser=new FeedParser(worker,heavy,undefined,undefined,undefined,resolve('dist-server/image-url-task.cjs'));
 try{assert.deepEqual(await parser.imageUrls({url:base,content:'<img src="split.png">'}),['https://example.invalid/a/split.png']);}
 finally{await parser.stop();rmSync(directory,{recursive:true,force:true});}
});
