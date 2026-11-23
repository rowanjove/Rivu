import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-renderer-analysis-')),result=join(directory,'result.json'),trace=join(directory,'trace.json'),output=join(directory,'analysis.json');
 writeFileSync(result,JSON.stringify({renderer:{maxGapMs:100,visibility:[],gaps:[{startEpochMs:1000,ms:100}],longTasks:[{startEpochMs:990,ms:40},{startEpochMs:2000,ms:1000}]}}));
 writeFileSync(trace,JSON.stringify({traceEvents:[
  {name:'rivu-restore-preflight-start',pid:1,tid:2,ts:900000},
  {name:'rivu-restore-preflight-end',pid:1,tid:2,ts:1200000},
  {name:'rivu-restore-gap:0',pid:1,tid:2,ts:1100000},
  {name:'RunTask',ph:'X',pid:1,tid:2,ts:990000,dur:60000},
  {name:'MajorGC',ph:'X',pid:1,tid:2,ts:1020000,dur:1000},
  {name:'RunTask',ph:'X',pid:3,tid:2,ts:900000,dur:300000},
  {name:'Receive mojo message',ph:'X',pid:1,tid:2,ts:1000000,dur:40000,args:{chrome_mojo_event_info:{mojo_interface_tag:'blink.mojom.DevToolsSession'}}}
 ]}));return {directory,result,trace,output,args:[resolve('scripts/analyze-restore-renderer-trace.mjs'),result,trace,output]};
}

test('restore renderer trace isolates the marked thread and clips tasks spanning gap boundaries',()=>{
 const f=fixture();try{
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const analysis=JSON.parse(readFileSync(f.output,'utf8')),gap=analysis.gaps[0];assert.equal(gap.maxRunTaskOverlapMs,50);assert.equal(gap.longestSlices.length,3);assert.equal(gap.observedLongTasks.length,1);
  assert.equal(gap.protocolMessages[0].interfaceTag,'blink.mojom.DevToolsSession');assert.equal(gap.protocolMessages[0].overlapMs,40);
  assert.equal(gap.longestSlices.find(row=>row.name==='MajorGC').overlapMs,1);
  const bytes=readFileSync(f.output);assert.notEqual(spawnSync(process.execPath,f.args).status,0);assert.deepEqual(readFileSync(f.output),bytes);
 }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('missing or ambiguous renderer gap marks cannot be promoted to timing evidence',()=>{
 for(const duplicate of [false,true]){const f=fixture();try{
  const trace=JSON.parse(readFileSync(f.trace,'utf8'));if(duplicate)trace.traceEvents.push({...trace.traceEvents[2]});else trace.traceEvents=trace.traceEvents.filter(row=>row.name!=='rivu-restore-gap:0');writeFileSync(f.trace,JSON.stringify(trace));
  const run=spawnSync(process.execPath,f.args,{encoding:'utf8'});assert.notEqual(run.status,0);assert.match(run.stderr,/Gap must have one renderer trace mark/);assert.equal(existsSync(f.output),false);
 }finally{rmSync(f.directory,{recursive:true,force:true});}}
});
