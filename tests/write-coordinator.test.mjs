import test from 'node:test';
import assert from 'node:assert/strict';
import {WriteCoordinator} from '../dist-server/write-coordinator.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('main leases share the event loop, exclusive workers wait, and resumed main leases are reserved before the next worker',async()=>{
  const gate=new WriteCoordinator(),a=await gate.enterMain(),b=await gate.enterMain();let releaseWorker,started=false,second=false;
  const worker=gate.withWorker(async()=>{started=true;await new Promise(resolve=>releaseWorker=resolve);});
  a();a();await tick();assert.equal(started,false);b();await tick();assert.equal(started,true);
  let releaseMain;const main=gate.enterMain().then(release=>{releaseMain=release;});
  const next=gate.withWorker(async()=>{second=true;});await tick();assert.equal(releaseMain,undefined);
  releaseWorker();await worker;await main;assert.equal(second,false);releaseMain();await next;assert.equal(second,true);
});
test('exceptions release both kinds of lease and subsequent work proceeds',async()=>{
  const gate=new WriteCoordinator();await assert.rejects(gate.withMain(()=>{throw Error('main');}),/main/);
  await assert.rejects(gate.withWorker(async()=>{throw Error('worker');}),/worker/);
  assert.equal(await gate.withMain(()=>42),42);assert.equal(await gate.withWorker(async()=>43),43);
});
test('new main tasks cannot indefinitely extend a queued worker after its grace period',async()=>{
  let now=0;const gate=new WriteCoordinator(100,()=>now),first=await gate.enterMain();let started=false,releaseWorker;
  const worker=gate.withWorker(async()=>{started=true;await new Promise(resolve=>releaseWorker=resolve);});
  now=50;const early=await gate.enterMain();early();now=101;let releaseLate;
  const late=gate.enterMain().then(release=>{releaseLate=release;});await tick();assert.equal(releaseLate,undefined);assert.equal(started,false);
  first();await tick();assert.equal(started,true);assert.equal(releaseLate,undefined);releaseWorker();await worker;await late;releaseLate();
});
