import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLogs } from '../dist-server/local-logs.js';

test('local logs use four files, retain seven days and omit private payloads',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rivu-logs-')),directory=join(root,'logs');
  try{
    mkdirSync(directory);
    const old=new Date(Date.now()-9*86_400_000),oldDay=old.toISOString().slice(0,10);
    writeFileSync(join(directory,`feed.${oldDay}.aaaaaaaa.log`),'obsolete\n');
    writeFileSync(join(directory,'app.log'),'old startup\n');utimesSync(join(directory,'app.log'),old,old);
    const logs=await LocalLogs.open(root);
    assert.equal(existsSync(join(directory,`feed.${oldDay}.aaaaaaaa.log`)),false);
    for(const kind of ['app','feed','ai','error'])assert.equal(existsSync(join(directory,`${kind}.log`)),true);
    const feedId='9d2daaa0-e0c1-4c8b-b1ee-b77849810fb1';
    await logs.write('feed','refresh',{feedId,outcome:'failed',errorType:'secret https://example.com/?token=abc',content:'private article body',durationMs:12});
    await logs.write('ai','action',{action:'summary',outcome:'ok',durationMs:27,apiKey:'secret-key',question:'private question'});
    await logs.flush();
    const feed=readFileSync(join(directory,'feed.log'),'utf8'),ai=readFileSync(join(directory,'ai.log'),'utf8');
    assert.equal(JSON.parse(feed.trim()).feedId,feedId);
    assert.equal(JSON.parse(feed.trim()).errorType,'Error');
    assert.equal(JSON.parse(ai.trim()).action,'summary');
    assert.doesNotMatch(feed+ai,/secret-key|private article body|private question|token=abc/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
