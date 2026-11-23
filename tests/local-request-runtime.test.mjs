import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';

const built=await build({entryPoints:['electron/local-request-runtime.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {prepareLocalRequestRuntime}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].contents).toString('base64'));

test('desktop prepares Fastify own injection runtime once without issuing a request',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-inject-init-'));
 const fastify=join(directory,'node_modules','fastify'),nested=join(fastify,'node_modules','light-my-request'),other=join(directory,'node_modules','light-my-request');
 try{
  for(const path of [fastify,nested,other])mkdirSync(path,{recursive:true});
  writeFileSync(join(fastify,'index.js'),'throw Error("Fastify must not be executed by runtime preparation");');
  writeFileSync(join(nested,'index.js'),'module.exports=()=>{throw Error("No synthetic request may be sent");};');
  writeFileSync(join(other,'index.js'),'throw Error("Wrong injection runtime instance");');
  const filename=join(directory,'main.cjs'),load=createRequire(filename),exact=createRequire(load.resolve('fastify')).resolve('light-my-request');
  assert.equal(load.cache[exact],undefined);
  prepareLocalRequestRuntime(filename);const cached=load.cache[exact];assert.ok(cached?.loaded);
  prepareLocalRequestRuntime(filename);assert.equal(load.cache[exact],cached);
  assert.equal(load.cache[join(other,'index.js')],undefined);
  delete load.cache[exact];
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('missing dependency fails during startup rather than silently skipping preparation',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-inject-missing-'));
 try{assert.throws(()=>prepareLocalRequestRuntime(join(directory,'main.cjs')),{code:'MODULE_NOT_FOUND'});}
 finally{rmSync(directory,{recursive:true,force:true});}
});
