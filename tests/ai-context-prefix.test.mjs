import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fitText,excerptParagraphs} from '../server/ai-context.ts';
import {FeedParser} from '../dist-server/feed-parser.js';
import {AIService} from '../dist-server/ai.js';
import {RivuDatabase} from '../dist-server/database.cjs';
function oldFit(text,budget){if(budget<=0)return '';if(Buffer.byteLength(text)<=budget)return text;let low=0,high=text.length;while(low<high){const mid=Math.ceil((low+high)/2);if(Buffer.byteLength(text.slice(0,mid))<=budget)low=mid;else high=mid-1;}if(low>0&&/[\uD800-\uDBFF]/.test(text[low-1]))low--;return text.slice(0,low);}
test('bounded UTF8 fitting preserves prior prefixes at Unicode, malformed-surrogate and fractional boundaries',()=>{
  const strings=['','ascii text','中文😀末尾','\ud800x','x\ud800','\udc00x','\ufeff  x\n😀','😀'.repeat(1000),'abc'.repeat(100000)];let state=123456;const alphabet=['a','中','😀','\ud800','\udc00','\n',' '];for(let i=0;i<100;i++){let text='';for(let j=0;j<80;j++){state=(Math.imul(state,1664525)+1013904223)>>>0;text+=alphabet[state%alphabet.length];}strings.push(text);}
  for(const text of strings)for(const budget of [-1,0,.5,1,2,3,4,5,7.5,30,80,150,250,Infinity,NaN])assert.equal(fitText(text,budget),oldFit(text,budget));
  const original=Buffer.byteLength;let largest=0;Buffer.byteLength=function(value,...args){largest=Math.max(largest,value.length);return original.call(this,value,...args);};try{assert.equal(fitText('x'.repeat(2000000),1024).length,1024);assert.ok(largest<=1024);}finally{Buffer.byteLength=original;}
});
test('excerpt preparation preserves the first five nonempty trimmed paragraphs and exact 800-unit prefixes',()=>{
  const samples=['',' \n\n  a \n b\r\n\ufeffc\ufeff\n','a'+(' '.repeat(1000))+'\nB','x'.repeat(799)+'😀\n中文','😀\rinside\u2028paragraph\nnext',Array.from({length:10000},(_,i)=>'  paragraph '+i+'  ').join('\n\n')];
  for(const body of samples)assert.deepEqual(excerptParagraphs(body),body.split(/\n+/).map(value=>value.trim()).filter(Boolean).slice(0,5).map(value=>value.slice(0,800)));
});
test('Worker prepared excerpts preserve chat sources and action hashes without main paragraph scanning',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-context-prefix-')),db=new RivuDatabase(join(dir,'rivu.db')),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs')),feed=db.addFeed({title:'Local',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'中文 Title',content:'<p>First</p><p>'+('中😀'.repeat(1200))+'</p><p>Third</p><p>Fourth</p><p>Fifth</p><p>Sixth ignored</p>',hash:'one'}]);const id=db.entries()[0].id;
  const ai=new AIService(db,undefined,undefined,html=>parser.aiContextText(html),undefined,html=>parser.aiDigest(html)),reference=new AIService(db,undefined,undefined,html=>parser.aiText(html));
  try{ai.configure({model:'fixture',contextLength:1024,maxTokens:100});reference.configure({model:'fixture',contextLength:1024,maxTokens:100});const expected=await reference.withPreparedBodies([id],()=>({chat:reference.preview([id]),action:reference.previewAction(id,'summary')}));
    await ai.withPreparedBodies([id],()=>{const row=ai.prepared.getStore().get(id);assert.ok(row.paragraphs.length<=5);assert.ok(row.paragraphs.every(p=>p.length<=800));const split=String.prototype.split;String.prototype.split=function(...args){if(String(this)===row.body)throw Error('Main paragraph scan forbidden');return split.apply(this,args);};try{const actual=ai.preview([id]);assert.deepEqual(actual.sources,expected.chat.sources);assert.deepEqual(ai.previewAction(id,'summary'),expected.action);}finally{String.prototype.split=split;}});
    assert.ok(ai.cacheBytes<=16*1024*1024);assert.equal(ai.retainedBytes,0);
  }finally{await parser.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
