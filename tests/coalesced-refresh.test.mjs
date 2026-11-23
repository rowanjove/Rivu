import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoalescedRefresh} from '../src/coalesced-refresh.ts';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('a burst shares one active pass and all callers await the latest follow-up',async()=>{
  const gates=[defer(),defer()],started=[defer(),defer()];let calls=0,committed=0,source=1,concurrency=0,maxConcurrency=0;
  const refresh=createCoalescedRefresh(async()=>{const index=calls++,snapshot=source;maxConcurrency=Math.max(maxConcurrency,++concurrency);started[index].resolve();await gates[index].promise;committed=snapshot;concurrency--;});
  const first=refresh();await started[0].promise;source=2;const requests=Array.from({length:100},()=>refresh());assert.ok(requests.every(p=>p===first));
  let ended=false;first.then(()=>ended=true);gates[0].resolve();await started[1].promise;assert.equal(ended,false);assert.equal(committed,1);gates[1].resolve();await Promise.all([first,...requests]);assert.equal(committed,2);assert.equal(calls,2);assert.equal(maxConcurrency,1);
});
test('requests arriving during a follow-up force another current snapshot',async()=>{
  const gates=[defer(),defer(),defer()],started=[defer(),defer(),defer()];let calls=0,source=1,committed=0;
  const refresh=createCoalescedRefresh(async()=>{const index=calls++,snapshot=source;started[index].resolve();await gates[index].promise;committed=snapshot;});
  const first=refresh();await started[0].promise;source=2;const second=refresh();gates[0].resolve();await started[1].promise;source=3;const third=refresh();gates[1].resolve();await started[2].promise;gates[2].resolve();await Promise.all([first,second,third]);assert.equal(committed,3);assert.equal(calls,3);
});
test('synchronous throws and async failures release the refresh so retries work',async()=>{
  for(const synchronous of [false,true]){let calls=0;const refresh=createCoalescedRefresh(()=>{calls++;if(calls===1){if(synchronous)throw Error('fixture');return Promise.reject(Error('fixture'));}return Promise.resolve();});
    const a=refresh(),b=refresh();assert.equal(a,b);await assert.rejects(a,/fixture/);await assert.rejects(b,/fixture/);await refresh();assert.equal(calls,2);
  }
});
test('a request scheduled at pass completion is not lost in a cleanup microtask',async()=>{
  let calls=0,late;
  const refresh=createCoalescedRefresh(async()=>{calls++;if(calls===1)queueMicrotask(()=>queueMicrotask(()=>{late=refresh();}));});
  await refresh();await late;assert.equal(calls,2);await refresh();assert.equal(calls,3);
});
