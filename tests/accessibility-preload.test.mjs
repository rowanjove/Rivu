import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['electron/preload.ts'],bundle:true,format:'esm',platform:'node',write:false,define:{'process.argv':'globalThis.__accessibilityArgs'},plugins:[{name:'electron-fixture',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const {contextBridge,ipcRenderer}=globalThis.__accessibilityHarness;',loader:'js'}));}}]});
let serial=0;
async function fixture(args=[]){
 let api;const listeners=new Map(),pending=[];
 globalThis.__accessibilityArgs=args;globalThis.__accessibilityHarness={contextBridge:{exposeInMainWorld(_name,value){api=value;}},ipcRenderer:{on(name,callback){listeners.set(name,callback);},invoke(name){assert.equal(name,'rivu:accessibility-state');return new Promise((resolve,reject)=>pending.push({resolve,reject}));},removeListener(){}}};
 await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64')+'#'+(++serial));
 return {api,pending,emit:value=>listeners.get('rivu:accessibility-changed')({},value),flush:()=>new Promise(done=>setImmediate(done))};
}
test.after(()=>{delete globalThis.__accessibilityArgs;delete globalThis.__accessibilityHarness;});
test('preload starts safe when flag is unknown and honors the canonical latest flag',async()=>{
 assert.equal((await fixture()).api.accessibilitySupportEnabled(),true);
 assert.equal((await fixture(['--rivu-accessibility=0'])).api.accessibilitySupportEnabled(),false);
 assert.equal((await fixture(['--rivu-accessibility=0','--rivu-accessibility=1'])).api.accessibilitySupportEnabled(),true);
});
test('new native event supersedes an older state response and unsubscribe releases callback',async()=>{
 const f=await fixture(['--rivu-accessibility=0']),calls=[],off=f.api.onAccessibilitySupportChanged(value=>calls.push(value));
 f.emit(true);f.pending[0].resolve(false);await f.flush();assert.deepEqual(calls,[true]);assert.equal(f.api.accessibilitySupportEnabled(),true);
 off();f.emit(false);assert.deepEqual(calls,[true]);assert.equal(f.api.accessibilitySupportEnabled(),false);
});
test('state request failure or invalid payload fails closed',async()=>{
 for(const mode of ['reject','invalid']){
  const f=await fixture(['--rivu-accessibility=0']),calls=[];f.api.onAccessibilitySupportChanged(value=>calls.push(value));
  if(mode==='reject')f.pending[0].reject(Error('Unavailable'));else f.pending[0].resolve('bad');
  await f.flush();assert.equal(f.api.accessibilitySupportEnabled(),true);assert.deepEqual(calls,[true]);
 }
});
test('invalid native push fails closed and invalidates older reads',async()=>{
 const f=await fixture(['--rivu-accessibility=0']),calls=[];f.api.onAccessibilitySupportChanged(value=>calls.push(value));
 f.emit('invalid');f.pending[0].resolve(false);await f.flush();assert.equal(f.api.accessibilitySupportEnabled(),true);assert.deepEqual(calls,[true]);
});
