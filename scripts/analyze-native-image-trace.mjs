import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [resultPath,tracePath,outputPath]=process.argv.slice(2);
assert.ok(resultPath&&tracePath&&outputPath,'Usage: result.json trace.json new-analysis.json');
assert.ok(!existsSync(outputPath),'Refuse to replace existing evidence');
const rawResult=readFileSync(resultPath),rawTrace=readFileSync(tracePath);
const result=JSON.parse(rawResult),trace=JSON.parse(rawTrace),events=trace.traceEvents;
assert.ok(Array.isArray(events)&&result.metrics.details);
const marks=new Map();
for(const event of events.filter(event=>event.name?.startsWith('rivu-native:'))){const matches=marks.get(event.name)||[];matches.push(event);marks.set(event.name,matches);}
function uniqueMark(name){const matches=marks.get(name)||[];assert.ok(matches.length<=1,'Ambiguous image phase marks');return matches[0];}
const threads=events.filter(event=>event.name==='thread_name').map(event=>({pid:event.pid,tid:event.tid,name:event.args?.name}));
const imageNames=new Set(['ImageDecodeTask','Decode Image','Decode LazyPixelRef','ImageUploadTask','PaintImage']);
const workerTasks=events.filter(event=>event.name==='ThreadPool_RunTask'&&event.ph==='X');
const flowStarts=new Map(),flowEnds=new Map();
function unionDuration(intervals){
 let total=0,end=-Infinity;
 for(const [from,to] of intervals.sort((a,b)=>a[0]-b[0])){if(to>end){total+=to-Math.max(from,end);end=to;}}
 return total;
}
function queueOccupancy(pid,decoderTid,start,end){
 const byThread=new Map(),bySource=new Map();
 for(const task of workerTasks){
  if(task.pid!==pid||!Number.isFinite(task.ts)||!Number.isFinite(task.dur)||task.dur<0)continue;
  const from=Math.max(start,task.ts),to=Math.min(end,task.ts+task.dur);if(to<=from)continue;
  const ranges=byThread.get(task.tid)||[];ranges.push([from,to]);byThread.set(task.tid,ranges);
  const source=task.args?.src_file||'(unattributed)',sourceThreads=bySource.get(source)||new Map(),sourceRanges=sourceThreads.get(task.tid)||[];
  sourceRanges.push([from,to]);sourceThreads.set(task.tid,sourceRanges);bySource.set(source,sourceThreads);
 }
 const threads=[...byThread].map(([tid,ranges])=>({tid,observedBusyMs:unionDuration(ranges)/1000})).sort((a,b)=>b.observedBusyMs-a.observedBusyMs);
 const decoderObservedBusyMs=threads.find(row=>row.tid===decoderTid)?.observedBusyMs||0;
 return {windowMs:(end-start)/1000,decoderObservedBusyMs,decoderUnattributedMs:Math.max(0,(end-start)/1000-decoderObservedBusyMs),threads,
  sources:[...bySource].map(([source,sourceThreads])=>({source,observedThreadTimeMs:[...sourceThreads.values()].reduce((sum,ranges)=>sum+unionDuration(ranges),0)/1000})).sort((a,b)=>b.observedThreadTimeMs-a.observedThreadTimeMs),
  limits:'Union of recorded worker slices per thread, clipped to matched post-to-dispatch window. Unattributed time is not proof of idle capacity. Source totals can overlap and must not be added. Does not prove scheduler priority, pool saturation or causality.'};
}
for(const event of events){
 if(event.cat!=='toplevel.flow'||event.name!=='ThreadPool_PostTask'||!['s','f'].includes(event.ph))continue;
 const key=event.pid+':'+event.id;
 const map=event.ph==='s'?flowStarts:flowEnds;const rows=map.get(key)||[];rows.push(event);map.set(key,rows);
}
function dispatchDetails(worker,start){
 const task=workerTasks.find(event=>event.pid===worker.pid&&event.tid===worker.tid&&event.ts<=worker.ts&&event.ts+(event.dur||0)>=worker.ts);
 const basic={pid:worker.pid,tid:worker.tid,offsetMs:(worker.ts-start)/1000,durationMs:(worker.dur||0)/1000};
 if(!task)return {...basic,flowStatus:'missing-owning-task'};
 const matches=[...flowEnds.entries()].filter(([,ends])=>ends.some(event=>event.pid===task.pid&&event.tid===task.tid&&event.ts===task.ts));
 if(matches.length!==1)return {...basic,source:task.args,flowStatus:'missing-or-ambiguous-task-flow'};
 const posts=flowStarts.get(matches[0][0])||[];
 if(posts.length!==1||posts[0].ts>task.ts)return {...basic,source:task.args,flowStatus:'missing-or-ambiguous-post'};
 return {...basic,source:task.args,flowStatus:'matched',flowId:matches[0][0],postedByTid:posts[0].tid,postedOffsetMs:(posts[0].ts-start)/1000,queuedMs:(task.ts-posts[0].ts)/1000,taskDurationMs:task.dur/1000,queueOccupancy:queueOccupancy(task.pid,task.tid,posts[0].ts,task.ts)};
}
function phaseDetails(from,to){
 if(!from||!to)return {status:'missing-mark'};
 assert.ok(from.pid===to.pid&&from.tid===to.tid&&from.ts<=to.ts,'Inconsistent image phase marks');
 const start=from.ts,end=to.ts;
 const overlap=event=>event.ph==='X'&&event.pid===from.pid&&event.tid===from.tid&&event.ts<=end&&event.ts+(event.dur||0)>=start;
 const describe=event=>({name:event.name,offsetMs:(event.ts-start)/1000,durationMs:(event.dur||0)/1000,
  overlapMs:Math.max(0,Math.min(end,event.ts+(event.dur||0))-Math.max(start,event.ts))/1000,args:event.args});
 const tasks=events.filter(event=>overlap(event)&&event.name==='RunTask');
 // GC events nest: expose individual slices, never sum their durations.
 const gc=events.filter(event=>overlap(event)&&/^(MajorGC|MinorGC|V8\.GC)/.test(event.name||''));
 return {status:'measured',durationMs:(end-start)/1000,
  longestTasks:tasks.sort((a,b)=>(b.dur||0)-(a.dur||0)).slice(0,10).map(describe),
  garbageCollection:gc.sort((a,b)=>(b.dur||0)-(a.dur||0)).slice(0,10).map(describe)};
}
const slowest=[];
for(const [mode,index] of [['lookup',1],['load',2]]){
 const rows=[...result.metrics.details[index]].sort((a,b)=>b.totalMs-a.totalMs).slice(0,3);
 for(const row of rows){
  const prefix=`rivu-native:${row.image.serial}:`,assigned=uniqueMark(prefix+'assigned'),loaded=uniqueMark(prefix+'loaded'),decoded=uniqueMark(prefix+'decoded');
  assert.ok(loaded&&decoded,'Trace lacks probe marks');
  const start=loaded.ts,end=decoded.ts,pid=loaded.pid,tid=loaded.tid;
  const within=events.filter(event=>event.ts>=start&&event.ts<=end);
  const tasks=events.filter(event=>event.ph==='X'&&event.pid===pid&&event.tid===tid&&event.name==='RunTask'&&event.ts<=end&&event.ts+(event.dur||0)>=start);
  const imageEvents=within.filter(event=>imageNames.has(event.name));
  slowest.push({mode,...row,phases:{load:phaseDetails(assigned,loaded),decode:phaseDetails(loaded,decoded)},loadedToDecodedMs:(end-start)/1000,rendererPid:pid,rendererTid:tid,
   timerFires:within.filter(event=>event.name==='TimerFire'&&event.pid===pid&&event.tid===tid).length,
   rendererTaskCount:tasks.length,maxRendererTaskMs:Math.max(0,...tasks.map(event=>(event.dur||0)/1000)),
   maxRendererOverlapMs:Math.max(0,...tasks.map(event=>(Math.min(end,event.ts+(event.dur||0))-Math.max(start,event.ts))/1000)),
   imageEvents:imageEvents.map(event=>({name:event.name,pid:event.pid,tid:event.tid,offsetMs:(event.ts-start)/1000,durationMs:(event.dur||0)/1000,args:event.args})),
   workerDispatchEvents:within.filter(event=>event.name==='ImageController::ProcessNextImageDecodeOnWorkerThread').map(event=>dispatchDetails(event,start)),
   overlappingParkingTasks:workerTasks.filter(event=>event.pid===pid&&event.args?.src_file?.endsWith('parkable_image.cc')&&event.ts<=end&&event.ts+(event.dur||0)>=start).map(event=>({tid:event.tid,offsetMs:(event.ts-start)/1000,durationMs:event.dur/1000,source:event.args})),
   compositorEvents:within.filter(event=>/QueueImageDecode|ImageDecodeFinished|ImageDecodeRequest|NotifyImageDecode/.test(event.name||'')).map(event=>({name:event.name,pid:event.pid,tid:event.tid,offsetMs:(event.ts-start)/1000,durationMs:(event.dur||0)/1000,args:event.args}))});
 }
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const analysis={recordedAt:new Date().toISOString(),inputs:{resultPath,resultSHA256:sha(rawResult),tracePath,traceSHA256:sha(rawTrace)},product:trace.metadata?.['product-version'],
 runtime:result.runtime,decodeHint:result.decodeHint||'auto',decodeExperiment:result.decodeExperiment||'none',diagnostic:!!result.diagnostic,maxMs:result.metrics.maxMs,eventCount:events.length,threads,slowest,
 limits:['Trace instrumentation can perturb timings; compare to untraced strict gate results.','Image events in an interval can belong to multiple images; temporal proximity is not per-image identity proof.','GC slices are nested and must not be summed; overlap establishes a main-thread stall, not its allocation root cause.','Promise resolution or paint events do not prove physical presentation or device60FPS.']};
writeFileSync(outputPath,JSON.stringify(analysis,null,2));
console.log(JSON.stringify({outputPath,product:analysis.product,maxMs:analysis.maxMs,slowest:slowest.slice(0,1).map(({mode,totalMs,loadedToDecodedMs,timerFires,maxRendererTaskMs})=>({mode,totalMs,loadedToDecodedMs,timerFires,maxRendererTaskMs}))}));
