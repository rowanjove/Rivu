import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(duplicate=false){
 const directory=mkdtempSync(join(tmpdir(),'rivu-trace-evidence-'));
 const result=join(directory,'result.json'),trace=join(directory,'trace.json'),output=join(directory,'analysis.json');
 const row={totalMs:200,image:{serial:'1'}},events=[
  {name:'rivu-native:1:loaded',ts:100000,pid:10,tid:11},
  {name:'rivu-native:1:decoded',ts:300000,pid:10,tid:11},
  {name:'RunTask',ph:'X',ts:99000,dur:2000,pid:10,tid:11},
  {name:'ThreadPool_RunTask',ph:'X',ts:299000,dur:100,pid:10,tid:12,args:{src_file:'cc/tiles/image_controller.cc'}},
  {name:'ImageController::ProcessNextImageDecodeOnWorkerThread',ph:'X',ts:299010,dur:50,pid:10,tid:12},
  {name:'ThreadPool_RunTask',ph:'X',ts:95000,dur:210000,pid:10,tid:13,args:{src_file:'third_party/blink/renderer/platform/graphics/parkable_image.cc'}},
  {name:'ThreadPool_PostTask',cat:'toplevel.flow',ph:'s',id:7,ts:101000,pid:10,tid:14},
  {name:'ThreadPool_PostTask',cat:'toplevel.flow',ph:'f',id:7,ts:299000,pid:10,tid:12},
  // Reused ids in another process must never contaminate the queue latency.
  {name:'ThreadPool_PostTask',cat:'toplevel.flow',ph:'s',id:7,ts:200000,pid:20,tid:14},
  {name:'ThreadPool_PostTask',cat:'toplevel.flow',ph:'f',id:7,ts:299000,pid:20,tid:12}
 ];
 if(duplicate)events.push({...events[6],ts:102000});
 writeFileSync(result,JSON.stringify({metrics:{details:[[],[row],[row]],maxMs:[1,200,200]}}));
 writeFileSync(trace,JSON.stringify({traceEvents:events}));
 const args=[resolve('scripts/analyze-native-image-trace.mjs'),result,trace,output];
 return {directory,output,args};
}

test('trace attribution isolates process flow ids and includes tasks spanning the interval boundary',()=>{
 const f=fixture();try{
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const analysis=JSON.parse(readFileSync(f.output,'utf8')),row=analysis.slowest[0];
  assert.equal(row.workerDispatchEvents[0].flowStatus,'matched');assert.equal(row.workerDispatchEvents[0].queuedMs,198);
  assert.equal(row.maxRendererTaskMs,2);assert.equal(row.maxRendererOverlapMs,1);assert.equal(row.overlappingParkingTasks.length,1);
  const bytes=readFileSync(f.output);assert.notEqual(spawnSync(process.execPath,f.args).status,0);assert.deepEqual(readFileSync(f.output),bytes);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('ambiguous task posts remain unverified rather than inventing a queue latency',()=>{
 const f=fixture(true);try{
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const row=JSON.parse(readFileSync(f.output,'utf8')).slowest[0].workerDispatchEvents[0];
  assert.equal(row.flowStatus,'missing-or-ambiguous-post');assert.equal(row.queuedMs,undefined);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('queue occupancy clips boundaries and unions nested or duplicate worker slices without cross-process attribution',()=>{
 const f=fixture();try{
  const trace=JSON.parse(readFileSync(f.args[2],'utf8'));
  trace.traceEvents.push(
   {name:'ThreadPool_RunTask',ph:'X',ts:95000,dur:210000,pid:10,tid:13,args:{src_file:'third_party/blink/renderer/platform/graphics/parkable_image.cc'}},
   {name:'ThreadPool_RunTask',ph:'X',ts:150000,dur:10000,pid:10,tid:13,args:{src_file:'nested.cc'}},
   {name:'ThreadPool_RunTask',ph:'X',ts:90000,dur:21000,pid:10,tid:12,args:{src_file:'other.cc'}},
   {name:'ThreadPool_RunTask',ph:'X',ts:0,dur:999999,pid:20,tid:12,args:{src_file:'wrong-process.cc'}});
  writeFileSync(f.args[2],JSON.stringify(trace));
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const queue=JSON.parse(readFileSync(f.output,'utf8')).slowest[0].workerDispatchEvents[0].queueOccupancy;
  assert.equal(queue.windowMs,198);assert.equal(queue.decoderObservedBusyMs,10);assert.equal(queue.decoderUnattributedMs,188);
  assert.equal(queue.threads.find(row=>row.tid===13).observedBusyMs,198);
  assert.equal(queue.sources.find(row=>row.source.endsWith('parkable_image.cc')).observedThreadTimeMs,198);
  assert.equal(queue.sources.find(row=>row.source==='nested.cc').observedThreadTimeMs,10);
  assert.equal(queue.sources.some(row=>row.source==='wrong-process.cc'),false);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('duplicate image phase marks cannot be silently selected as timing evidence',()=>{
 const f=fixture();try{
  const trace=JSON.parse(readFileSync(f.args[2],'utf8'));trace.traceEvents.push({...trace.traceEvents[0],ts:101000});writeFileSync(f.args[2],JSON.stringify(trace));
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.notEqual(run.status,0);assert.match(run.stderr,/Ambiguous image phase marks/);assert.equal(existsSync(f.output),false);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('load phase reports a spanning renderer GC separately from decode and other threads',()=>{
 const f=fixture();try{
  const trace=JSON.parse(readFileSync(f.args[2],'utf8'));
  trace.traceEvents.push(
   {name:'rivu-native:1:assigned',ts:10000,pid:10,tid:11},
   {name:'RunTask',ph:'X',ts:5000,dur:90000,pid:10,tid:11},
   {name:'MajorGC',ph:'X',ts:6000,dur:88000,pid:10,tid:11},
   {name:'V8.GCFinalizeMC',ph:'X',ts:7000,dur:86000,pid:10,tid:11},
   {name:'MajorGC',ph:'X',ts:0,dur:500000,pid:10,tid:12});
  writeFileSync(f.args[2],JSON.stringify(trace));
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const phases=JSON.parse(readFileSync(f.output,'utf8')).slowest[0].phases;
  assert.equal(phases.load.durationMs,90);assert.equal(phases.load.longestTasks[0].overlapMs,85);
  assert.equal(phases.load.garbageCollection.length,2);assert.equal(phases.load.garbageCollection[0].name,'MajorGC');
  assert.equal(phases.load.garbageCollection[0].overlapMs,84);
  assert.equal(phases.decode.durationMs,200);assert.deepEqual(phases.decode.garbageCollection,[]);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('legacy missing assignment remains explicit and inconsistent phase marks are rejected',()=>{
 const f=fixture();try{
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(readFileSync(f.output,'utf8')).slowest[0].phases.load.status,'missing-mark');
  const trace=JSON.parse(readFileSync(f.args[2],'utf8'));
  trace.traceEvents.push({name:'rivu-native:1:assigned',ts:200000,pid:10,tid:11});
  writeFileSync(f.args[2],JSON.stringify(trace));
  const output=join(f.directory,'invalid.json');
  const invalid=spawnSync(process.execPath,[...f.args.slice(0,3),output],{encoding:'utf8'});
  assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Inconsistent image phase marks/);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});
