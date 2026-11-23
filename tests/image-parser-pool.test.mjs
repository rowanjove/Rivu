import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FeedParser} from '../dist-server/feed-parser.js';

function fixture({timeout=2000,idle=30000,pending=64,budget=64*1024*1024}={}){
 const dir=mkdtempSync(join(tmpdir(),'rivu-image-pool-')),task=join(dir,'image.cjs'),gate=join(dir,'gate'),log=join(dir,'calls');
 writeFileSync(task,`const fs=require('node:fs'),{threadId}=require('node:worker_threads');exports.parseImageUrls=async(response,candidate)=>{fs.appendFileSync(${JSON.stringify(log)},threadId+'|'+response.text+'\\n');if(response.text==='exit')process.exit(7);if(response.text==='invalid')return {};if(response.text==='error')throw Object.assign(Error('image failure'),{statusCode:422});if(response.text==='timeout')await new Promise(()=>{});while(fs.existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,5));return ['https://example.invalid/'+threadId+'/'+response.text+'?base='+encodeURIComponent(candidate.url)];};`);
 const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),join(dir,'heavy-must-not-load.cjs'),pending,budget,timeout,task,idle);
 return {parser,gate,log,dir,read:text=>parser.imageUrls({content:text,url:'https://base.invalid/'+text}),async close(){rmSync(gate,{force:true});await parser.stop();rmSync(dir,{recursive:true,force:true});}};
}
const id=urls=>new URL(urls[0]).pathname.split('/')[1];
async function waitFor(predicate){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Worker lifecycle wait timed out');await new Promise(resolve=>setTimeout(resolve,10));}}

test('explicit preparation is lazy, bounded, parses no input, and is consumed by a normal image job',async()=>{
 const f=fixture();try{
  assert.equal(f.parser.imageWorkers.size,0);assert.equal(f.parser.prepareImageParser(),true);assert.equal(f.parser.prepareImageParser(),false);
  const worker=f.parser.idleImageWorker,thread=worker.threadId;assert.equal(existsSync(f.log),false);
  assert.equal(id(await f.read('prepared')),String(thread));assert.equal(readFileSync(f.log,'utf8').trim().split('\n').length,1);
  await f.parser.stop();assert.equal(worker.threadId,-1);assert.equal(f.parser.prepareImageParser(),false);
 }finally{await f.close();}
});

test('unused prepared worker expires without article work and custom modules cannot opt in implicitly',async()=>{
 const f=fixture({idle:100});try{assert.equal(f.parser.prepareImageParser(),true);const w=f.parser.idleImageWorker;await waitFor(()=>w.threadId===-1);assert.equal(existsSync(f.log),false);}finally{await f.close();}
 const custom=new FeedParser('missing-worker.cjs','custom-task.cjs');try{assert.equal(custom.prepareImageParser(),false);}finally{await custom.stop();}
});

test('distinct image misses reuse a light worker while preserving body/base and releasing it on stop',async()=>{
 const f=fixture();try{
  const rows=[];for(let i=0;i<12;i++)rows.push(await f.read('body-'+i));
  assert.equal(new Set(rows.map(id)).size,1);for(let i=0;i<12;i++)assert.equal(new URL(rows[i][0]).searchParams.get('base'),'https://base.invalid/body-'+i);
  assert.equal(readFileSync(f.log,'utf8').trim().split('\n').length,12);
  const workers=[...f.parser.imageWorkers];assert.equal(workers.length,1);await f.parser.stop();assert.equal(workers[0].threadId,-1);await assert.rejects(f.read('body-1'),/已关闭/);
 }finally{await f.close();}
});

test('concurrent image misses share four slots, reject overflow, keep one idle worker, and drain accepted work on stop',async()=>{
 const f=fixture({pending:1});writeFileSync(f.gate,'held');try{
  const jobs=Array.from({length:5},(_,i)=>f.read('body-'+i));await assert.rejects(f.read('overflow'),e=>e.statusCode===503&&e.resourceBusy);
  await waitFor(()=>existsSync(f.log)&&readFileSync(f.log,'utf8').trim().split('\n').length===4);
  const workers=[...f.parser.imageWorkers];assert.equal(workers.length,4);rmSync(f.gate);
  const rows=await Promise.all(jobs);assert.equal(rows.length,5);assert.equal(new Set(rows.slice(0,4).map(id)).size,4);
  assert.equal(f.parser.imageWorkers.size,1);assert.equal(workers.filter(w=>w.threadId!==-1).length,1);
  writeFileSync(f.gate,'held');const accepted=f.read('accepted');const stopping=f.parser.stop();await assert.rejects(f.read('closed'),/已关闭/);rmSync(f.gate);await accepted;await stopping;assert.equal(f.parser.imageWorkers.size,0);
 }finally{await f.close();}
});

test('image task error can retry, while invalid replies, crashes and timeout retire the worker before capacity returns',async()=>{
 const f=fixture({timeout:1000});try{
  const first=id(await f.read('first'));await assert.rejects(f.read('error'),e=>e.statusCode===422);assert.equal(id(await f.read('after-error')),first);
  for(const [input,pattern] of [['invalid',/结果无效/],['exit',/进程退出/],['timeout',/解析超时/]]){
   const before=[...f.parser.imageWorkers];await assert.rejects(f.read(input),pattern);assert.ok(before.every(w=>w.threadId===-1));assert.notEqual(id(await f.read('after-'+input)),first);
  }
 }finally{await f.close();}
});

test('idle image worker expires and a later distinct miss creates a fresh worker; input budget rejects before spawn',async()=>{
 const f=fixture({idle:200});try{const first=id(await f.read('first')),worker=[...f.parser.imageWorkers][0];await waitFor(()=>worker.threadId===-1);assert.notEqual(id(await f.read('later')),first);}finally{await f.close();}
 const small=fixture({budget:32});try{await assert.rejects(small.read('x'.repeat(100)),e=>e.statusCode===503&&e.resourceBusy);assert.equal(existsSync(small.log),false);}finally{await small.close();}
});

test('failed idle retirement cannot accumulate unbounded workers and stop retries every survivor',async()=>{
 const f=fixture({idle:50}),restore=[];
 try{
  for(let i=0;i<5;i++){
   await f.read('retire-'+i);const worker=f.parser.idleImageWorker,terminate=worker.terminate.bind(worker);
   restore.push(()=>{worker.terminate=terminate;});worker.terminate=()=>Promise.reject(Error('simulated termination failure'));
   await waitFor(()=>f.parser.idleImageWorker===undefined);
  }
  assert.equal(f.parser.imageWorkers.size,5);await assert.rejects(f.read('overflow-survivor'),e=>e.statusCode===503&&e.resourceBusy);
  const survivors=[...f.parser.imageWorkers];for(const reset of restore)reset();await f.parser.stop();assert.ok(survivors.every(w=>w.threadId===-1));
 }finally{for(const reset of restore)reset();await f.close();}
});

test('late retirement of an old image worker cannot clear or terminate its idle replacement',async()=>{
 const f=fixture({idle:100});let release,originalTerminate,retiring;
 try{
  const first=id(await f.read('old'));retiring=f.parser.idleImageWorker;originalTerminate=retiring.terminate.bind(retiring);
  const gate=new Promise(resolve=>{release=resolve;});let terminationRequested=false;
  retiring.terminate=()=>{terminationRequested=true;return gate.then(originalTerminate);};
  await waitFor(()=>terminationRequested);assert.notEqual(retiring.threadId,-1);
  // Keep the replacement idle while the old exit is deliberately reordered.
  f.parser.imageIdleMs=30000;
  const next=id(await f.read('replacement')),replacement=f.parser.idleImageWorker;
  assert.notEqual(next,first);assert.notEqual(replacement,retiring);assert.equal(f.parser.imageWorkers.size,2);
  release();await waitFor(()=>retiring.threadId===-1&&f.parser.imageWorkers.size===1);
  assert.equal(f.parser.idleImageWorker,replacement);assert.equal(id(await f.read('after-old-exit')),next);
  await f.parser.stop();assert.equal(replacement.threadId,-1);
 }finally{release?.();if(retiring&&originalTerminate)retiring.terminate=originalTerminate;await f.close();}
});
