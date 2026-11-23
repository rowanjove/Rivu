import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {AIScanner} from '../dist-server/ai-scanner.js';

test('body transfers preserve UTF16 including isolated surrogates and drain decoding before stop',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-body-transfer-')),modulePath=join(directory,'task.cjs');
  writeFileSync(modulePath,"exports.readAIBodies=input=>{const html='\\ud800A\\udc00中文😀',rows=input.entryIds.map(id=>({id,title:'Title',html,body_revision:'0'.repeat(32)}));return {rows,bytes:input.maxBytes===0?0:rows.length*(256+2*('Title'.length+html.length))}};exports.scanAIRule=()=>({matching:0,rows:[]});");
  const scanner=new AIScanner(resolve('dist-server/ai-scan-worker.cjs'),modulePath);
  try{
    await assert.rejects(scanner.readBodies({operation:'bodies',databasePath:'fixture',entryIds:['bad'],maxBytes:0}),/传输结果无效/);
    assert.deepEqual(await scanner.read({databasePath:'fixture',conditions:{},limit:1,count:true}),{matching:0,rows:[]});
    const ids=Array.from({length:20},(_,index)=>String(index)),pending=scanner.readBodies({operation:'bodies',databasePath:'fixture',entryIds:ids,maxBytes:64000});
    const stopping=scanner.stop(),result=await pending;await stopping;
    assert.deepEqual(result.rows.map(row=>row.id),ids);for(const row of result.rows){assert.equal(row.html,'\ud800A\udc00中文😀');assert.equal(Object.hasOwn(row,'htmlBuffer'),false);}assert.equal(Object.hasOwn(result,'transport'),false);
    await assert.rejects(scanner.readBodies({operation:'bodies',databasePath:'fixture',entryIds:['closed'],maxBytes:64000}),/关闭/);
  }finally{await scanner.stop();rmSync(directory,{recursive:true,force:true});}
});
