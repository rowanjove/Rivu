import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeByteStages,inspectByteTrace} from '../scripts/bitmap-stage-diagnostics.mjs';
function fixture(){return {main:{ipc:[{id:'4',ok:true,ms:10,cpuMs:2}],files:[{id:'4',ok:true,ms:4}]},preload:[{id:'4',ok:true,ms:18}],renderer:{rows:[{id:'4',ok:true,phase:'read',ms:25},...['blob','bitmap','transfer','mint','revoke'].map(phase=>({id:'4',phase,ms:1}))]},limits:'fixture'};}
test('byte phase joins use exact serial identities and expose residuals without naming them copy CPU',()=>{
 const value=fixture();value.main.files.push({id:'other',ok:true,ms:999});
 const row=summarizeByteStages(value).rows[0];assert.equal(row.fileMs,4);assert.equal(row.ipcResidualMs,8);assert.equal(row.handoffResidualMs,7);assert.equal(row.mainCpuMs,2);
});
test('duplicate or missing dispatch, preload, renderer or file identities reject timing attribution',()=>{
 for(const mutate of [p=>p.main.ipc.push({...p.main.ipc[0]}),p=>p.preload.splice(0),p=>p.main.files[0].id=null,p=>p.renderer.rows.push({...p.renderer.rows.find(row=>row.phase==='bitmap')})]){
  const value=fixture();mutate(value);assert.throws(()=>summarizeByteStages(value));
 }
});
test('inconsistent nested phase timing cannot be turned into a plausible positive residual',()=>{
 const value=fixture();value.preload[0].ms=1;assert.throws(()=>summarizeByteStages(value),/Inconsistent/);
});
test('GC attribution clips spanning slices, unions nested events and rejects duplicate phase identity',()=>{
 const start={name:'rivu-byte:4:read:start',ts:1000,pid:1,tid:2},end={name:'rivu-byte:4:read:end',ts:11000,pid:1,tid:2};
 const events=[start,end,{name:'MajorGC',ph:'X',ts:0,dur:5000,pid:1,tid:2},{name:'V8.GC_SCAVENGER',ph:'X',ts:2000,dur:2000,pid:1,tid:2},{name:'MinorGC',ph:'X',ts:9000,dur:4000,pid:1,tid:2},{name:'MajorGC',ph:'X',ts:1000,dur:10000,pid:2,tid:2}];
 const phase=inspectByteTrace(events,'4','read');assert.equal(phase.durationMs,10);assert.equal(phase.gcUnionMs,6);assert.equal(phase.gcSlices.length,3);
 assert.throws(()=>inspectByteTrace([...events,{...start}],'4','read'),/ambiguous/);
});
