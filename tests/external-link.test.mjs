import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const directory=mkdtempSync(join(tmpdir(),'rivu-external-unit-')),file=join(directory,'external.mjs');
await build({entryPoints:['src/external-link.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
const {openExternalLink}=await import(pathToFileURL(file).href);
test.after(()=>{const scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-external-unit-')&&!scope.startsWith('..')&&!isAbsolute(scope));rmSync(directory,{recursive:true,force:true});});

test('invalid or executable addresses never dispatch; valid HTTP(S) addresses normalize',async()=>{
  const calls=[],errors=[];const open=async url=>{calls.push(url);};
  for(const value of [undefined,null,{},0,'','not a url','http://','https://','file:///C:/test','javascript:alert(1)','data:text/html,test','mailto:local@example.invalid','ftp://example.invalid/'])assert.equal(await openExternalLink(value,e=>errors.push(e),open),false);
  assert.equal(calls.length,0);assert.equal(errors.length,13);assert.ok(errors.every(e=>e==='链接地址无效。'));
  assert.equal(await openExternalLink('HTTP://EXAMPLE.INVALID:80/a b?q=中文#section',e=>errors.push(e),open),true);
  assert.equal(await openExternalLink('https://[::1]:8443/a',e=>errors.push(e),open),true);
  assert.deepEqual(calls,['http://example.invalid/a%20b?q=%E4%B8%AD%E6%96%87#section','https://[::1]:8443/a']);assert.equal(errors.length,13);
});

test('synchronous and asynchronous system failures resolve false with one safe message each',async()=>{
  for(const open of [()=>{throw Error('private detail');},async()=>{throw Error('private detail');}]){
    const errors=[];assert.equal(await openExternalLink('https://example.invalid/',message=>errors.push(message),open),false);
    assert.deepEqual(errors,['无法打开链接，请检查默认浏览器设置或稍后重试。']);
  }
});
