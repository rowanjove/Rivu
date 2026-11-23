import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FeedParser} from '../dist-server/feed-parser.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-ai-pool-')),modulePath=join(dir,'task.cjs'),gate=join(dir,'gate'),log=join(dir,'started');
  writeFileSync(modulePath,`const fs=require('node:fs'),{threadId}=require('node:worker_threads');exports.parseAIText=async response=>{const text=response.text;fs.appendFileSync(${JSON.stringify(log)},threadId+'\\n');if(text==='exit')process.exit(4);if(text==='invalid')return {};if(text==='error')throw Object.assign(Error('task failure'),{statusCode:422});if(text==='timeout')await new Promise(()=>{});while(fs.existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,10));return JSON.stringify({text,threadId});};`);
  return {dir,modulePath,gate,log};
}
test('sequential AI parses reuse one worker while preserving each distinct result',async()=>{
  const f=fixture(),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),f.modulePath);
  try{const rows=[];for(let i=0;i<20;i++)rows.push(JSON.parse(await parser.aiText('body-'+i)));assert.deepEqual(rows.map(row=>row.text),Array.from({length:20},(_,i)=>'body-'+i));assert.equal(new Set(rows.map(row=>row.threadId)).size,1);assert.equal(readFileSync(f.log,'utf8').trim().split('\n').length,20);
  }finally{await parser.stop();rmSync(f.dir,{recursive:true,force:true});}
});
test('AI pool shares four running slots and bounded queue, drains accepted jobs on stop',async()=>{
  const f=fixture();writeFileSync(f.gate,'held');const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),f.modulePath,1);
  try{const jobs=Array.from({length:5},(_,i)=>parser.aiText('body-'+i));await assert.rejects(parser.aiText('overflow'),error=>error.statusCode===503&&error.resourceBusy);const deadline=Date.now()+10000;while((!existsSync(f.log)||readFileSync(f.log,'utf8').trim().split('\n').length<4)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(readFileSync(f.log,'utf8').trim().split('\n').length,4);const stopping=parser.stop();await assert.rejects(parser.aiText('after-stop'),/已关闭/);rmSync(f.gate);const rows=(await Promise.all(jobs)).map(row=>JSON.parse(row));await stopping;assert.equal(new Set(rows.map(row=>row.threadId)).size,4);assert.equal(rows[4].text,'body-4');
  }finally{rmSync(f.gate,{force:true});await parser.stop();rmSync(f.dir,{recursive:true,force:true});}
});
test('task errors reuse the worker, crashes and invalid output destroy it before retry',async()=>{
  const f=fixture(),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),f.modulePath);
  try{const first=JSON.parse(await parser.aiText('first'));await assert.rejects(parser.aiText('error'),error=>error.statusCode===422);assert.equal(JSON.parse(await parser.aiText('after-error')).threadId,first.threadId);await assert.rejects(parser.aiText('exit'),/来源解析进程退出/);const replacement=JSON.parse(await parser.aiText('after-exit'));assert.notEqual(replacement.threadId,first.threadId);await assert.rejects(parser.aiText('invalid'),/结果无效/);assert.notEqual(JSON.parse(await parser.aiText('after-invalid')).threadId,replacement.threadId);
  }finally{await parser.stop();rmSync(f.dir,{recursive:true,force:true});}
});
test('timed out worker is terminated and a new lane can process a later task',async()=>{
  const f=fixture(),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),f.modulePath,64,64*1024*1024,1000);
  try{const first=JSON.parse(await parser.aiText('first'));await assert.rejects(parser.aiText('timeout'),/来源解析超时/);assert.notEqual(JSON.parse(await parser.aiText('after-timeout')).threadId,first.threadId);
  }finally{await parser.stop();rmSync(f.dir,{recursive:true,force:true});}
});
test('input budget rejects before spawning and remains shared with other parser kinds',async()=>{
  const f=fixture(),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),f.modulePath,64,32);
  try{await assert.rejects(parser.aiText('x'.repeat(100)),error=>error.statusCode===503&&error.resourceBusy);assert.equal(existsSync(f.log),false);writeFileSync(f.gate,'held');const held=parser.aiText('held');await assert.rejects(parser.parse({text:'x',url:'',type:'text/html'},{url:''}),error=>error.statusCode===503&&error.resourceBusy);rmSync(f.gate);assert.equal(JSON.parse(await held).text,'held');
  }finally{rmSync(f.gate,{force:true});await parser.stop();rmSync(f.dir,{recursive:true,force:true});}
});
