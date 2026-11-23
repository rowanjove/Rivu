import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [resultPath,tracePath,output]=process.argv.slice(2);assert.ok(resultPath&&tracePath&&output&&!existsSync(output));
const raw=readFileSync(resultPath),traceRaw=readFileSync(tracePath),result=JSON.parse(raw),trace=JSON.parse(traceRaw),events=trace.traceEvents;
assert.ok(Array.isArray(events)&&Array.isArray(result.renderer?.gaps));
const start=events.find(e=>e.name==='rivu-restore-preflight-start'),end=events.find(e=>e.name==='rivu-restore-preflight-end');assert.ok(start&&end&&start.pid===end.pid&&start.tid===end.tid&&end.ts>=start.ts,'Trace lacks matching renderer phase marks');
const gaps=result.renderer.gaps.map((gap,index)=>{
 const marks=events.filter(e=>e.name==='rivu-restore-gap:'+index&&e.pid===start.pid&&e.tid===start.tid);assert.equal(marks.length,1,'Gap must have one renderer trace mark');
 const finish=marks[0].ts,begin=finish-gap.ms*1000;
 const slices=events.filter(e=>e.ph==='X'&&e.pid===start.pid&&e.tid===start.tid&&e.ts<finish&&e.ts+(e.dur||0)>begin);
 const describe=e=>({name:e.name,offsetMs:(e.ts-begin)/1000,durationMs:(e.dur||0)/1000,overlapMs:Math.max(0,Math.min(finish,e.ts+(e.dur||0))-Math.max(begin,e.ts))/1000,args:e.args});
 const tasks=slices.filter(e=>e.name==='RunTask');
 return {...gap,index,maxRunTaskOverlapMs:Math.max(0,...tasks.map(e=>describe(e).overlapMs)),
  longestSlices:slices.filter(e=>/RunTask|MajorGC|MinorGC|V8\.GC|FunctionCall|EventDispatch|TimerFire|Decode|Unpark|Receive mojo message/.test(e.name||'')).sort((a,b)=>(b.dur||0)-(a.dur||0)).slice(0,15).map(describe),
  protocolMessages:slices.filter(e=>e.name==='Receive mojo message').map(e=>({...describe(e),interfaceTag:e.args?.chrome_mojo_event_info?.mojo_interface_tag||null})),
  observedLongTasks:(result.renderer.longTasks||[]).filter(e=>e.startEpochMs<gap.startEpochMs+gap.ms&&e.startEpochMs+e.ms>gap.startEpochMs)};
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
writeFileSync(output,JSON.stringify({recordedAt:new Date().toISOString(),status:'TRACE-ANALYZED',inputs:{resultPath,resultSHA256:hash(raw),tracePath,traceSHA256:hash(traceRaw)},eventCount:events.length,rendererPid:start.pid,rendererTid:start.tid,maxGapMs:result.renderer.maxGapMs,visibility:result.renderer.visibility,gaps,limits:['Instrumented preflight only, not full restore acceptance.','Nested event durations must not be summed.','A timer gap without a matching long task does not alone prove throttling or OS scheduling as its cause.']},null,2),{flag:'wx'});
console.log(JSON.stringify({output,eventCount:events.length,maxGapMs:result.renderer.maxGapMs,gaps:gaps.length}));
