import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {startBoundedRendererTrace} from '../scripts/bounded-renderer-trace.mjs';

function fixture(events){
 const session=new EventEmitter(),calls=[];
 session.send=async(method,args)=>{calls.push({method,args});if(method==='Tracing.end'){session.emit('Tracing.dataCollected',{value:events});session.emit('Tracing.tracingComplete',{dataLossOccurred:false});}if(method==='Tracing.getCategories')return {categories:['disabled-by-default-v8.gc','disabled-by-default-v8.gc_stats']};if(method==='Runtime.getHeapUsage')return {usedSize:1000,totalSize:2000,embedderHeapUsedSize:3000,backingStorageSize:4000,unrelated:'secret'};return {};};
 session.detach=async()=>{calls.push({method:'detach'});};
 return {page:{context:()=>({newCDPSession:async()=>session})},calls};
}

test('bounded trace attributes only overlapping work on the marked process/thread and omits raw arguments',async()=>{
 const {page,calls}=fixture([
  {ph:'M',name:'thread_name',pid:1,tid:2,args:{name:'CrRendererMain'}},
  {ph:'X',name:'GC',pid:1,tid:2,ts:100000,dur:120000,args:{privateURL:'secret',data:{usedHeapSizeBefore:8192,reason:'secret'},nested:{deeper:{privateURL:'secret'}}}},
  {ph:'X',name:'wrong process',pid:3,tid:2,ts:100000,dur:150000},
  {ph:'X',name:'wrong thread',pid:1,tid:4,ts:100000,dur:150000},
  {ph:'X',name:'earlier',pid:1,tid:2,ts:0,dur:20000},
  {ph:'R',name:'rivu-writer-gap-0-150',pid:1,tid:2,ts:250000}
 ]);
 const summary=await(await startBoundedRendererTrace(page))();
 assert.equal(calls.find(call=>call.method==='Tracing.start').args.traceConfig.traceBufferSizeInKb,2048);
 assert.deepEqual(summary.gaps[0].overlaps.map(event=>event.name),['GC']);
 assert.equal(summary.gaps[0].overlaps[0].thread,'CrRendererMain');
 assert.equal(summary.gaps[0].overlaps[0].phase,'X');
 assert.deepEqual(summary.gcPhases[0].numericArgs,{'data.usedHeapSizeBefore':8192});
 assert.ok(!summary.categories.includes('toplevel'));
 assert.ok(!summary.categories.includes('disabled-by-default-v8.gc_stats'));
 assert.deepEqual(summary.heapBefore,{usedSize:1000,totalSize:2000,embedderHeapUsedSize:3000,backingStorageSize:4000});
 assert.ok(!JSON.stringify(summary).includes('secret'));
 assert.equal(calls.at(-1).method,'detach');
});

test('bounded trace matches nested B/E spans independently per thread',async()=>{
 const {page}=fixture([
  {ph:'B',name:'outer',pid:1,tid:2,ts:0},
  {ph:'B',name:'inner',pid:1,tid:2,ts:10000},
  {ph:'E',pid:2,tid:2,ts:15000},
  {ph:'E',pid:1,tid:2,ts:40000},
  {ph:'E',pid:1,tid:2,ts:50000}
 ]);
 const result=await(await startBoundedRendererTrace(page))();
 assert.deepEqual(result.longestSpans.map(event=>[event.name,event.ms]),[['outer',50],['inner',30]]);
 assert.ok(result.longestSpans.every(event=>event.phase==='B'));
});

test('bounded trace detaches the session when start or end fails',async()=>{
 for(const failedMethod of ['Tracing.start','Tracing.end']){
  let detached=false;
  const session=new EventEmitter();session.send=async method=>{if(method===failedMethod)throw Error('probe failure');return {};};session.detach=async()=>{detached=true;};
  const page={context:()=>({newCDPSession:async()=>session})};
  await assert.rejects(async()=>{const stop=await startBoundedRendererTrace(page);await stop();},/probe failure/);
  assert.equal(detached,true);
 }
});

test('bounded trace reports retained-event limit instead of silently claiming full coverage',async()=>{
 const {page}=fixture(Array.from({length:50003},(_,ts)=>({ph:'X',name:'work',pid:1,tid:2,ts,dur:1})));
 const result=await(await startBoundedRendererTrace(page))();
 assert.equal(result.received,50003);assert.equal(result.retained,50000);assert.equal(result.discarded,3);
 assert.equal(result.longestSpans.length,40);
});
