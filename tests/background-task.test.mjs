import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/background-task.ts'],bundle:true,format:'esm',write:false});
const {yieldBackgroundTask}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));
const original=globalThis.scheduler;
test.after(()=>{if(original===undefined)delete globalThis.scheduler;else globalThis.scheduler=original;});
test('explicit background scheduling carries the abort signal and never inherits yield priority',async()=>{
 const controller=new AbortController(),calls=[];
 globalThis.scheduler={yield(){throw Error('Priority inheritance is forbidden');},postTask:async(callback,options)=>{calls.push(options);callback();}};
 await yieldBackgroundTask(controller.signal);assert.equal(calls.length,1);assert.equal(calls[0].priority,'background');assert.equal(calls[0].signal,controller.signal);
 controller.abort();await assert.rejects(yieldBackgroundTask(controller.signal),{name:'AbortError'});assert.equal(calls.length,1);
});
test('fallback yields to normal timers and abort removes a queued callback',async()=>{
 delete globalThis.scheduler;const order=[];setTimeout(()=>order.push('normal timer'),0);await yieldBackgroundTask();order.push('continued');assert.deepEqual(order,['normal timer','continued']);
 const controller=new AbortController(),work=yieldBackgroundTask(controller.signal);controller.abort();await assert.rejects(work,{name:'AbortError'});
});
